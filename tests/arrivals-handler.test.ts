/**
 * Integration-style test for server/api/arrivals.get.ts's "real" branch,
 * terminus-gated path (WS-C, see design/realtime-terminus-prediction.md
 * §8). The handler relies on Nitro/Nuxt auto-imports (`defineEventHandler`,
 * `useRuntimeConfig`, `createError`, `setResponseHeader`, `getGtfsData`)
 * that only exist at build/dev time via unplugin codegen — there is no
 * @nuxt/test-utils dependency in this project to spin up a real Nitro
 * context for tests. Since those identifiers are only referenced *inside*
 * the handler's function body (not at module-evaluation time, aside from
 * `defineEventHandler` itself wrapping the export), stubbing them on
 * `globalThis` before a fresh dynamic import of the module lets this test
 * exercise the actual handler file end-to-end, including the real
 * fetch(trip_updates.json) call (mocked here) and the real gtfs.ts-shaped
 * GtfsData contract — not just the pure pieces it composes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GtfsCalendar, GtfsData, GtfsStopTime, GtfsTrip } from '../server/utils/gtfs'

const STOP_ID = 'bUCR_0_01'
const TZ = 'America/Costa_Rica'

const WEEKDAY_CALENDAR: GtfsCalendar = {
  serviceId: 'entresemana',
  startDate: '20260101',
  endDate: '20261231',
  sunday: false,
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false
}

/** Costa Rica is a fixed UTC-6 offset — see server/utils/time.ts. */
function epochFor(dateStr: string, hhmmss: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = hhmmss.split(':').map(Number)
  return Date.UTC(y, m - 1, d, hh, mm, ss) / 1000 + 6 * 3600
}

/**
 * A departure-terminus-shaped GtfsData (Educación-like): one outbound trip
 * departing STOP_ID at 08:00, plus an unrelated inbound trip whose terminal
 * is STOP_ID (so `isDepartureTerminus` is true, mirroring the real feed's
 * two-way-terminus shape).
 */
function terminusGtfs(): GtfsData {
  const outboundTrip: GtfsTrip = { tripId: 'out-0800', routeId: 'bUCR', serviceId: 'entresemana', headsign: 'Odontología', isMilla: false }
  const inboundTrip: GtfsTrip = { tripId: 'in-someone-else', routeId: 'bUCR', serviceId: 'entresemana', headsign: 'Educación', isMilla: false }

  const trips = new Map([[outboundTrip.tripId, outboundTrip], [inboundTrip.tripId, inboundTrip]])
  const outboundStopTime: GtfsStopTime = {
    tripId: 'out-0800',
    stopId: STOP_ID,
    stopSequence: 1,
    arrivalSeconds: 8 * 3600,
    departureSeconds: 8 * 3600,
    isBoardable: true
  }
  const inboundStopTime: GtfsStopTime = {
    tripId: 'in-someone-else',
    stopId: STOP_ID,
    stopSequence: 9,
    arrivalSeconds: 7 * 3600,
    departureSeconds: 7 * 3600,
    isBoardable: false
  }

  return {
    agency: { name: 'bUCR', url: 'https://example.test', timezone: TZ },
    routes: new Map(),
    feedInfo: null,
    stops: new Map([[STOP_ID, { id: STOP_ID, name: 'Educación' }]]),
    trips,
    stopTimesByStop: new Map([[STOP_ID, [outboundStopTime, inboundStopTime]]]),
    calendars: [WEEKDAY_CALENDAR],
    calendarExceptions: [],
    loadedAt: Date.now(),
    terminalStopIdByTrip: new Map([['in-someone-else', STOP_ID]]),
    firstBoardableStopIdByTrip: new Map([['out-0800', STOP_ID]]),
    departureTerminusStopIds: new Set([STOP_ID])
  }
}

function inboundFeederFeed(predictedArrival: number, headerTimestamp: number) {
  // Uses the known 'in-someone-else' trip_id registered in terminusGtfs()
  // as non-boardable at STOP_ID (its terminus) -- matches how a *known*
  // inbound feeder run appears live: deriveArrivalsFromFeed's own
  // non-boardable filter correctly excludes it from the plain realtime
  // path (it's not a boarding opportunity), while extractInboundArrivals
  // picks it up precisely because it *is* that trip's terminal stop.
  return {
    header: { timestamp: headerTimestamp },
    entity: [
      {
        id: 'v1',
        trip_update: {
          trip: { trip_id: 'in-someone-else', route_id: 'bUCR', direction_id: 1 },
          stop_time_update: [
            { stop_sequence: 9, stop_id: STOP_ID, arrival: { time: predictedArrival, uncertainty: 120 } }
          ]
        }
      }
    ]
  }
}

function outboundOnlyFeed(headerTimestamp: number) {
  // Mirrors design/feed-samples/trip_updates.sample.json's shape: an
  // outbound-from-terminus run in progress, no inbound feeder at all.
  return {
    header: { timestamp: headerTimestamp },
    entity: [
      {
        id: 'v2',
        trip_update: {
          trip: { trip_id: 'out-0800', route_id: 'bUCR', direction_id: 0 },
          stop_time_update: [
            { stop_sequence: 3, stop_id: 'bUCR_0_06', arrival: { time: headerTimestamp + 200 } }
          ]
        }
      }
    ]
  }
}

interface ConfigOverrides {
  terminusPrediction?: boolean
  stopId?: string
}

function baseConfig(overrides: ConfigOverrides = {}) {
  return {
    operationMode: 'real',
    stopId: overrides.stopId ?? STOP_ID,
    databusBaseUrl: 'https://databus.example.test',
    realtimeStaleThresholdSeconds: 90,
    realtimeFetchTimeoutMs: 5000,
    terminusPrediction: overrides.terminusPrediction ?? false,
    terminusBoardingBufferSeconds: 60,
    terminusMaxLayoverSeconds: 1200,
    terminusMaxEarlySeconds: 300,
    public: { maxArrivals: 5 }
  }
}

async function loadHandler() {
  vi.resetModules()
  const mod = await import('../server/api/arrivals.get')
  return mod.default as (event: unknown) => Promise<import('../shared/types').ArrivalsResponse>
}

describe('arrivals.get real-mode terminus path (WS-C)', () => {
  const NOW = epochFor('2026-08-24', '07:55:00') // Monday, 5 min before the scheduled 08:00 departure

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
    vi.stubGlobal('setResponseHeader', () => {})
    vi.stubGlobal('createError', (opts: Record<string, unknown>) => Object.assign(new Error(String(opts.statusMessage)), opts))
    vi.stubGlobal('getGtfsData', vi.fn(async () => terminusGtfs()))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('flag off: behaves exactly as today (schedule fallback when trip_updates has no direct match at the terminus)', async () => {
    vi.stubGlobal('useRuntimeConfig', () => baseConfig({ terminusPrediction: false }))
    // Even though a real inbound feeder is present in the feed, the flag is
    // off, so the handler must never consult it.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => inboundFeederFeed(NOW + 60, NOW)
    })))

    const handler = await loadHandler()
    const result = await handler({})

    expect(result.source).toBe('schedule')
    expect(result.realtimeFallback).toBe(true)
    expect(result.arrivals[0]?.tripId).toBe('out-0800')
    expect(result.arrivals[0]?.estimated).toBeFalsy()
  })

  it('flag on + inbound feeder present: matched slot shows estimated eta, estimated:true, scheduledEta set', async () => {
    const scheduledEpoch = epochFor('2026-08-24', '08:00:00')
    const predictedArrival = scheduledEpoch + 120 // 2 min late -> pushes departure out
    vi.stubGlobal('useRuntimeConfig', () => baseConfig({ terminusPrediction: true }))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => inboundFeederFeed(predictedArrival, NOW)
    })))

    const handler = await loadHandler()
    const result = await handler({})

    expect(result.source).toBe('realtime')
    expect(result.realtimeFallback).toBe(false)
    expect(result.arrivals).toHaveLength(1)
    expect(result.arrivals[0]).toMatchObject({
      tripId: 'out-0800',
      estimated: true,
      scheduledEta: scheduledEpoch,
      eta: predictedArrival + 60 // boardingBufferS default
    })
  })

  it('outbound-only feed (no inbound feeder): terminus path yields no bogus estimate, plain schedule shown as realtime', async () => {
    vi.stubGlobal('useRuntimeConfig', () => baseConfig({ terminusPrediction: true }))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => outboundOnlyFeed(NOW)
    })))

    const handler = await loadHandler()
    const result = await handler({})

    expect(result.arrivals[0]?.tripId).toBe('out-0800')
    expect(result.arrivals[0]?.estimated).toBeFalsy()
    expect(result.arrivals[0]?.scheduledEta).toBeUndefined()
    expect(result.arrivals[0]?.eta).toBe(epochFor('2026-08-24', '08:00:00'))
    // Per shared/types.ts's ArrivalSource/realtimeFallback comments and
    // design/realtime-terminus-prediction.md §8 WS-D: "a predicted-from-
    // schedule+RT board is still source: 'realtime' (it used live data)".
    // The terminus path consulted a healthy, fresh trip_updates feed this
    // cycle even though zero feeders matched any slot, so this must still
    // report live data was used, not a fallback.
    expect(result.source).toBe('realtime')
    expect(result.realtimeFallback).toBe(false)
  })

  it('unhealthy feed (fetch fails): falls back to the plain GTFS schedule, terminus path never engaged', async () => {
    vi.stubGlobal('useRuntimeConfig', () => baseConfig({ terminusPrediction: true }))
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network unreachable')
    }))

    const handler = await loadHandler()
    const result = await handler({})

    expect(result.source).toBe('schedule')
    expect(result.realtimeFallback).toBe(true)
    expect(result.arrivals[0]?.estimated).toBeFalsy()
  })

  it('flag on but stop is not a departure terminus: terminus path never engages, normal real/schedule behavior', async () => {
    const nonTerminusGtfs = terminusGtfs()
    nonTerminusGtfs.terminalStopIdByTrip.clear() // no trip terminates here -> not a departure terminus
    nonTerminusGtfs.departureTerminusStopIds.clear() // precomputed set (FIX 3) must reflect the same fact
    vi.stubGlobal('getGtfsData', vi.fn(async () => nonTerminusGtfs))
    vi.stubGlobal('useRuntimeConfig', () => baseConfig({ terminusPrediction: true }))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => inboundFeederFeed(NOW + 60, NOW)
    })))

    const handler = await loadHandler()
    const result = await handler({})

    expect(result.source).toBe('schedule')
    expect(result.arrivals[0]?.estimated).toBeFalsy()
  })
})
