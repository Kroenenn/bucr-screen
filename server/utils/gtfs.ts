/**
 * Static GTFS Schedule layer: fetch the zip from GTFS_FEED_URL, parse it,
 * and cache the result.
 *
 * Parses every file the feed actually ships (agency, routes, stops, trips,
 * stop_times, calendar, calendar_dates, feed_info) rather than only the
 * ones strictly needed for a countdown — branding (route color/name,
 * agency name/url) and the service timezone all come from here now instead
 * of being hardcoded, so this file is the single place that can go stale
 * if the feed changes, not scattered assumptions across the codebase.
 * `shapes.txt` (route geometry) is the one file still unparsed — nothing
 * in this app draws a map yet.
 *
 * Caching has two tiers:
 *  - in-memory, refreshed every `gtfsRefreshIntervalSeconds` (schedule data
 *    changes rarely — no need to re-fetch on every request)
 *  - on-disk (raw zip bytes, under `gtfsCacheDir`), so a fetch failure on a
 *    later boot still has yesterday's schedule instead of nothing. This is
 *    the "no internet at the venue" safety net for `fake` mode and for the
 *    schedule fallback inside `real` mode.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import { parse } from 'csv-parse/sync'

export interface GtfsAgency {
  id?: string
  name: string
  url: string
  /** IANA timezone (e.g. "America/Costa_Rica") — the authoritative source for local-day/service-date math, see time.ts. */
  timezone: string
}

export interface GtfsRoute {
  id: string
  shortName: string
  longName: string
  /** Hex without "#", e.g. "005DA4". Falls back to "000000" if the feed leaves it blank. */
  color: string
  textColor: string
}

export interface GtfsFeedInfo {
  publisherName: string
  publisherUrl: string
}

export interface GtfsStop {
  id: string
  name: string
  zone?: string
}

export interface GtfsTrip {
  tripId: string
  routeId: string
  serviceId: string
  headsign: string
  directionId?: number
  /**
   * True for a trip that takes the longer "milla universitaria" loop
   * instead of the direct route — same signal infobus-web surfaces as its
   * "con milla" badge. bUCR's trip_ids encode this directly
   * (`..._con_milla_...` vs `..._sin_milla_...`), same source
   * infobus-web's `scheduleProvider.ts` uses (there, via shape_id).
   */
  isMilla: boolean
}

export interface GtfsStopTime {
  tripId: string
  stopId: string
  stopSequence: number
  /** Seconds since local midnight of the trip's service date. Can exceed 86400 for post-midnight trips. */
  arrivalSeconds: number
  departureSeconds: number
  /**
   * True when a rider can actually board this trip here — false when this
   * is the trip's last stop_sequence (nowhere onward to go: bUCR's real
   * feed has trips that end at Educación with trip_headsign "Educación"
   * itself, not a boarding opportunity) or when the feed explicitly sets
   * pickup_type=1 (no pickup available). Computed straight from
   * stop_sequence/pickup_type — no per-deployment config needed, and it's
   * correct for any stop_id, not just termini.
   */
  isBoardable: boolean
}

const WEEKDAY_COLUMNS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

export interface GtfsCalendar {
  serviceId: string
  startDate: string
  endDate: string
  sunday: boolean
  monday: boolean
  tuesday: boolean
  wednesday: boolean
  thursday: boolean
  friday: boolean
  saturday: boolean
}

export interface GtfsCalendarException {
  serviceId: string
  date: string
  /** 1 = service added for this date, 2 = service removed for this date. */
  exceptionType: 1 | 2
}

export interface GtfsData {
  agency: GtfsAgency | null
  routes: Map<string, GtfsRoute>
  feedInfo: GtfsFeedInfo | null
  stops: Map<string, GtfsStop>
  trips: Map<string, GtfsTrip>
  stopTimesByStop: Map<string, GtfsStopTime[]>
  calendars: GtfsCalendar[]
  calendarExceptions: GtfsCalendarException[]
  loadedAt: number
  /**
   * Each trip's terminal stop_id (the stop at its max stop_sequence) — the
   * stop it ends at, never a boarding opportunity there (see
   * `GtfsStopTime.isBoardable`). Lets a terminus-prediction consumer ask
   * "is this trip an inbound feeder for stop S?" via a lookup instead of
   * rescanning stop_times.txt. See design/realtime-terminus-prediction.md §4.
   */
  terminalStopIdByTrip: Map<string, string>
  /**
   * Each trip's first *boardable* stop_id (min stop_sequence among
   * stop_times where `isBoardable` is true). Lets a consumer ask "does this
   * trip depart from stop S?" via a lookup. Same source doc as above.
   */
  firstBoardableStopIdByTrip: Map<string, string>
  /**
   * stop_ids that are a **departure terminus**: some trip's first-boardable
   * stop AND some (other) trip's terminal stop — precomputed once here
   * (rather than re-derived per request) so `isDepartureTerminus` in
   * terminus-prediction.ts, called on every /api/arrivals request, is a
   * trivial Set lookup instead of a linear scan of both trip maps. See
   * design/realtime-terminus-prediction.md §8 WS-C.
   */
  departureTerminusStopIds: Set<string>
}

function parseGtfsTime(value: string): number {
  const parts = value.split(':').map(p => Number.parseInt(p, 10))
  const [h, m, s] = parts
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0)
}

function parseCsv(zip: AdmZip, fileName: string): Record<string, string>[] {
  const entry = zip.getEntry(fileName)
  if (!entry) return []
  const content = entry.getData().toString('utf-8')
  return parse(content, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[]
}

/** Reads a required GTFS column; throws rather than silently writing "undefined" into a map key. */
function requiredField(row: Record<string, string>, key: string, fileName: string): string {
  const value = row[key]
  if (value === undefined) throw new Error(`${fileName}: row is missing required column "${key}"`)
  return value
}

function parseZipBuffer(buffer: Buffer): GtfsData {
  const zip = new AdmZip(buffer)

  const agencyRows = parseCsv(zip, 'agency.txt')
  const agencyRow = agencyRows[0]
  const agency: GtfsAgency | null = agencyRow
    ? {
        id: agencyRow.agency_id || undefined,
        name: requiredField(agencyRow, 'agency_name', 'agency.txt'),
        url: requiredField(agencyRow, 'agency_url', 'agency.txt'),
        timezone: requiredField(agencyRow, 'agency_timezone', 'agency.txt')
      }
    : null

  const routes = new Map<string, GtfsRoute>()
  for (const row of parseCsv(zip, 'routes.txt')) {
    const id = requiredField(row, 'route_id', 'routes.txt')
    routes.set(id, {
      id,
      shortName: row.route_short_name || '',
      longName: row.route_long_name || '',
      color: row.route_color || '000000',
      textColor: row.route_text_color || 'FFFFFF'
    })
  }

  const feedInfoRows = parseCsv(zip, 'feed_info.txt')
  const feedInfoRow = feedInfoRows[0]
  const feedInfo: GtfsFeedInfo | null = feedInfoRow
    ? {
        publisherName: requiredField(feedInfoRow, 'feed_publisher_name', 'feed_info.txt'),
        publisherUrl: requiredField(feedInfoRow, 'feed_publisher_url', 'feed_info.txt')
      }
    : null

  const stops = new Map<string, GtfsStop>()
  for (const row of parseCsv(zip, 'stops.txt')) {
    const id = requiredField(row, 'stop_id', 'stops.txt')
    stops.set(id, { id, name: requiredField(row, 'stop_name', 'stops.txt'), zone: row.zone_id || undefined })
  }

  const trips = new Map<string, GtfsTrip>()
  for (const row of parseCsv(zip, 'trips.txt')) {
    const tripId = requiredField(row, 'trip_id', 'trips.txt')
    trips.set(tripId, {
      tripId,
      routeId: requiredField(row, 'route_id', 'trips.txt'),
      serviceId: requiredField(row, 'service_id', 'trips.txt'),
      headsign: row.trip_headsign || '',
      directionId: row.direction_id === '' || row.direction_id === undefined ? undefined : Number(row.direction_id),
      isMilla: tripId.includes('con_milla')
    })
  }

  const stopTimeRows = parseCsv(zip, 'stop_times.txt')

  // First pass: each trip's highest stop_sequence, to tell a real boarding
  // stop apart from a trip's final (alighting-only) stop.
  const maxStopSequenceByTrip = new Map<string, number>()
  for (const row of stopTimeRows) {
    const tripId = requiredField(row, 'trip_id', 'stop_times.txt')
    const stopSequence = Number(requiredField(row, 'stop_sequence', 'stop_times.txt'))
    const current = maxStopSequenceByTrip.get(tripId)
    if (current === undefined || stopSequence > current) maxStopSequenceByTrip.set(tripId, stopSequence)
  }

  const stopTimesByStop = new Map<string, GtfsStopTime[]>()
  const terminalStopIdByTrip = new Map<string, string>()
  const firstBoardableStopIdByTrip = new Map<string, string>()
  const minBoardableStopSequenceByTrip = new Map<string, number>()
  for (const row of stopTimeRows) {
    const tripId = requiredField(row, 'trip_id', 'stop_times.txt')
    const stopSequence = Number(requiredField(row, 'stop_sequence', 'stop_times.txt'))
    const isLastStop = stopSequence === maxStopSequenceByTrip.get(tripId)
    // pickup_type isn't present in bUCR's current feed (absent = GTFS
    // default of "regular pickup"), but checking it costs nothing and
    // keeps this correct if the feed ever starts setting it.
    const pickupForbidden = row.pickup_type === '1'
    const stopTime: GtfsStopTime = {
      tripId,
      stopId: requiredField(row, 'stop_id', 'stop_times.txt'),
      stopSequence,
      arrivalSeconds: parseGtfsTime(requiredField(row, 'arrival_time', 'stop_times.txt')),
      departureSeconds: parseGtfsTime(requiredField(row, 'departure_time', 'stop_times.txt')),
      isBoardable: !isLastStop && !pickupForbidden
    }
    const list = stopTimesByStop.get(stopTime.stopId)
    if (list) list.push(stopTime)
    else stopTimesByStop.set(stopTime.stopId, [stopTime])

    if (isLastStop) terminalStopIdByTrip.set(tripId, stopTime.stopId)

    if (stopTime.isBoardable) {
      const currentMin = minBoardableStopSequenceByTrip.get(tripId)
      if (currentMin === undefined || stopSequence < currentMin) {
        minBoardableStopSequenceByTrip.set(tripId, stopSequence)
        firstBoardableStopIdByTrip.set(tripId, stopTime.stopId)
      }
    }
  }

  const calendars: GtfsCalendar[] = parseCsv(zip, 'calendar.txt').map(row => ({
    serviceId: requiredField(row, 'service_id', 'calendar.txt'),
    startDate: requiredField(row, 'start_date', 'calendar.txt'),
    endDate: requiredField(row, 'end_date', 'calendar.txt'),
    sunday: row.sunday === '1',
    monday: row.monday === '1',
    tuesday: row.tuesday === '1',
    wednesday: row.wednesday === '1',
    thursday: row.thursday === '1',
    friday: row.friday === '1',
    saturday: row.saturday === '1'
  }))

  const calendarExceptions: GtfsCalendarException[] = parseCsv(zip, 'calendar_dates.txt').map(row => ({
    serviceId: requiredField(row, 'service_id', 'calendar_dates.txt'),
    date: requiredField(row, 'date', 'calendar_dates.txt'),
    exceptionType: Number(row.exception_type) === 1 ? 1 : 2
  }))

  const outboundDepartureStopIds = new Set(firstBoardableStopIdByTrip.values())
  const departureTerminusStopIds = new Set(
    [...new Set(terminalStopIdByTrip.values())].filter(stopId => outboundDepartureStopIds.has(stopId))
  )

  return {
    agency,
    routes,
    feedInfo,
    stops,
    trips,
    stopTimesByStop,
    calendars,
    calendarExceptions,
    loadedAt: Date.now(),
    terminalStopIdByTrip,
    firstBoardableStopIdByTrip,
    departureTerminusStopIds
  }
}

/** Service ids active on a given GTFS date (YYYYMMDD), per calendar.txt + calendar_dates.txt exceptions. */
export function activeServiceIds(gtfs: GtfsData, dateStr: string, weekdayIndex: number): Set<string> {
  const dayKey = WEEKDAY_COLUMNS[weekdayIndex]
  if (!dayKey) throw new Error(`activeServiceIds: weekdayIndex must be 0-6 (Date.getUTCDay() range), got ${weekdayIndex}`)
  const active = new Set<string>()
  for (const cal of gtfs.calendars) {
    if (dateStr >= cal.startDate && dateStr <= cal.endDate && cal[dayKey]) active.add(cal.serviceId)
  }
  for (const ex of gtfs.calendarExceptions) {
    if (ex.date !== dateStr) continue
    if (ex.exceptionType === 1) active.add(ex.serviceId)
    else active.delete(ex.serviceId)
  }
  return active
}

async function readCachedZip(cacheDir: string): Promise<Buffer | null> {
  try {
    return await readFile(join(cacheDir, 'bUCR_GTFS.zip'))
  } catch {
    return null
  }
}

async function writeCachedZip(cacheDir: string, buffer: Buffer): Promise<void> {
  const path = join(cacheDir, 'bUCR_GTFS.zip')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, buffer)
}

/**
 * A hung feed host is worse than a failing one: without a deadline this
 * `fetch` can stall indefinitely, and because `getGtfsData` shares one
 * in-flight promise across callers, every request would stall with it.
 * `AbortSignal.timeout` covers the whole exchange (connect + body), so a
 * black-holed connection surfaces as an error we can fall back from.
 */
async function fetchZip(url: string, timeoutMs: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`GTFS feed fetch failed: ${response.status} ${response.statusText}`)
  return Buffer.from(await response.arrayBuffer())
}

let gtfsData: GtfsData | null = null
let loadingPromise: Promise<GtfsData> | null = null

/** Fetch + parse + cache-to-disk, falling back to memory then disk on failure. */
async function loadGtfs(): Promise<GtfsData> {
  const config = useRuntimeConfig()
  try {
    const buffer = await fetchZip(config.gtfsFeedUrl, config.gtfsFetchTimeoutMs)
    const fresh = parseZipBuffer(buffer)
    gtfsData = fresh
    // Best-effort disk cache write; a failure here shouldn't break the response.
    writeCachedZip(config.gtfsCacheDir, buffer).catch(err =>
      console.warn('[gtfs] failed to write disk cache', err)
    )
    return fresh
  } catch (err) {
    console.warn('[gtfs] fetch/parse failed, falling back to cache:', err)
    if (gtfsData) return gtfsData
    const cached = await readCachedZip(config.gtfsCacheDir)
    if (cached) {
      const parsed = parseZipBuffer(cached)
      gtfsData = parsed
      return parsed
    }
    throw new Error('No GTFS data available: fetch failed and no disk cache present', { cause: err })
  }
}

/** Shared in-flight load, so concurrent callers don't each hit the network. */
function loadOnce(): Promise<GtfsData> {
  if (loadingPromise) return loadingPromise
  loadingPromise = loadGtfs().finally(() => {
    loadingPromise = null
  })
  return loadingPromise
}

/**
 * Returns the in-memory GTFS data, refreshing from GTFS_FEED_URL once the
 * copy is older than `gtfsRefreshIntervalSeconds`.
 *
 * Stale-while-revalidate: once we hold *any* parsed copy, the refresh runs
 * in the background and the stale copy is returned immediately. Awaiting it
 * inline would make one request per refresh window pay for a full
 * download+parse, and a hung feed host would stall that request along with
 * every other one waiting on the shared promise. Schedule data slightly past
 * its refresh window is harmless; a frozen board is not.
 *
 * Only a cold start (no in-memory copy) awaits the load, and even then it
 * falls back to the on-disk zip. Throws only with no network *and* no cache.
 */
export async function getGtfsData(): Promise<GtfsData> {
  const config = useRuntimeConfig()
  const staleMs = config.gtfsRefreshIntervalSeconds * 1000

  if (gtfsData) {
    if (Date.now() - gtfsData.loadedAt >= staleMs) {
      // Fire-and-forget: loadGtfs already logs and falls back internally, so
      // an unhandled rejection here would be the only way this could bite.
      void loadOnce().catch(() => {})
    }
    return gtfsData
  }

  return loadOnce()
}

/**
 * Warms the cache at container start (see server/plugins/gtfs-warmup.ts) so
 * the first viewer isn't the one paying for the cold load — and so a Pi that
 * boots before its Wi-Fi associates gets retried here rather than serving a
 * 503 to whoever looks at the screen first.
 */
export async function warmGtfsData(): Promise<void> {
  await loadOnce()
}
