/**
 * Static GTFS Schedule layer: fetch the zip from GTFS_FEED_URL, parse the
 * handful of files we actually need, and cache the result.
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
  stops: Map<string, GtfsStop>
  trips: Map<string, GtfsTrip>
  stopTimesByStop: Map<string, GtfsStopTime[]>
  calendars: GtfsCalendar[]
  calendarExceptions: GtfsCalendarException[]
  loadedAt: number
}

function parseGtfsTime(value: string): number {
  const parts = value.split(':').map((p) => Number.parseInt(p, 10))
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
      isMilla: tripId.includes('con_milla'),
    })
  }

  const stopTimesByStop = new Map<string, GtfsStopTime[]>()
  for (const row of parseCsv(zip, 'stop_times.txt')) {
    const stopTime: GtfsStopTime = {
      tripId: requiredField(row, 'trip_id', 'stop_times.txt'),
      stopId: requiredField(row, 'stop_id', 'stop_times.txt'),
      stopSequence: Number(requiredField(row, 'stop_sequence', 'stop_times.txt')),
      arrivalSeconds: parseGtfsTime(requiredField(row, 'arrival_time', 'stop_times.txt')),
      departureSeconds: parseGtfsTime(requiredField(row, 'departure_time', 'stop_times.txt')),
    }
    const list = stopTimesByStop.get(stopTime.stopId)
    if (list) list.push(stopTime)
    else stopTimesByStop.set(stopTime.stopId, [stopTime])
  }

  const calendars: GtfsCalendar[] = parseCsv(zip, 'calendar.txt').map((row) => ({
    serviceId: requiredField(row, 'service_id', 'calendar.txt'),
    startDate: requiredField(row, 'start_date', 'calendar.txt'),
    endDate: requiredField(row, 'end_date', 'calendar.txt'),
    sunday: row.sunday === '1',
    monday: row.monday === '1',
    tuesday: row.tuesday === '1',
    wednesday: row.wednesday === '1',
    thursday: row.thursday === '1',
    friday: row.friday === '1',
    saturday: row.saturday === '1',
  }))

  const calendarExceptions: GtfsCalendarException[] = parseCsv(zip, 'calendar_dates.txt').map((row) => ({
    serviceId: requiredField(row, 'service_id', 'calendar_dates.txt'),
    date: requiredField(row, 'date', 'calendar_dates.txt'),
    exceptionType: Number(row.exception_type) === 1 ? 1 : 2,
  }))

  return { stops, trips, stopTimesByStop, calendars, calendarExceptions, loadedAt: Date.now() }
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

async function fetchZip(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GTFS feed fetch failed: ${response.status} ${response.statusText}`)
  return Buffer.from(await response.arrayBuffer())
}

let gtfsData: GtfsData | null = null
let loadingPromise: Promise<GtfsData> | null = null

/**
 * Returns cached GTFS data, refreshing from GTFS_FEED_URL in the background
 * when the in-memory copy is older than `gtfsRefreshIntervalSeconds`. Never
 * throws while a usable copy (memory or disk cache) exists — only throws if
 * this is a cold start with no network and no prior cache.
 */
export async function getGtfsData(): Promise<GtfsData> {
  const config = useRuntimeConfig()
  const staleMs = config.gtfsRefreshIntervalSeconds * 1000

  if (gtfsData && Date.now() - gtfsData.loadedAt < staleMs) return gtfsData
  if (loadingPromise) return loadingPromise

  loadingPromise = (async () => {
    try {
      const buffer = await fetchZip(config.gtfsFeedUrl)
      const fresh = parseZipBuffer(buffer)
      gtfsData = fresh
      // Best-effort disk cache write; a failure here shouldn't break the response.
      writeCachedZip(config.gtfsCacheDir, buffer).catch((err) =>
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
      throw new Error('No GTFS data available: fetch failed and no disk cache present')
    }
  })()

  try {
    return await loadingPromise
  } finally {
    loadingPromise = null
  }
}
