import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GtfsCalendar, GtfsData, GtfsStopTime, GtfsTrip } from '../server/utils/gtfs'
import type { DatabusTripUpdateFeed } from '../server/utils/realtime-mode'
import { deriveTerminusArrivals } from '../server/utils/terminus-mode'
import type { TerminusParams } from '../server/utils/terminus-prediction'

const STOP_ID = 'bUCR_0_01'
const TZ = 'America/Costa_Rica'
const DEFAULT_PARAMS: TerminusParams = { boardingBufferS: 60, maxLayoverS: 1200, maxEarlyS: 300 }

const FIXTURE_DIR = join(__dirname, '..', 'design', 'feed-samples')

function loadFixture(name: string): DatabusTripUpdateFeed {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8')) as DatabusTripUpdateFeed
}

/** Costa Rica is a fixed UTC-6 offset — see server/utils/time.ts. */
function epochFor(dateStr: string, hhmmss: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = hhmmss.split(':').map(Number)
  return Date.UTC(y, m - 1, d, hh, mm, ss) / 1000 + 6 * 3600
}

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

function outboundTrip(tripId: string, headsign = 'Odontología', isMilla = false): GtfsTrip {
  return { tripId, routeId: 'bUCR', serviceId: 'entresemana', headsign, isMilla }
}

/** A GtfsData with one outbound-from-terminus trip departing STOP_ID at `departure`, and terminalStopIdByTrip/firstBoardableStopIdByTrip populated the way gtfs.ts's real parser does. */
function buildGtfs(opts: { trips: Array<{ tripId: string, departure: string, headsign?: string, isMilla?: boolean }> }): GtfsData {
  const trips = new Map<string, GtfsTrip>()
  const stopTimesByStop = new Map<string, GtfsStopTime[]>()
  const firstBoardableStopIdByTrip = new Map<string, string>()

  for (const t of opts.trips) {
    trips.set(t.tripId, outboundTrip(t.tripId, t.headsign, t.isMilla))
    const [hh, mm, ss] = t.departure.split(':').map(Number)
    const seconds = hh * 3600 + mm * 60 + ss
    const st: GtfsStopTime = {
      tripId: t.tripId,
      stopId: STOP_ID,
      stopSequence: 1,
      arrivalSeconds: seconds,
      departureSeconds: seconds,
      isBoardable: true
    }
    const list = stopTimesByStop.get(STOP_ID)
    if (list) list.push(st)
    else stopTimesByStop.set(STOP_ID, [st])
    firstBoardableStopIdByTrip.set(t.tripId, STOP_ID)
  }

  return {
    agency: null,
    routes: new Map(),
    feedInfo: null,
    stops: new Map([[STOP_ID, { id: STOP_ID, name: 'Educación' }]]),
    trips,
    stopTimesByStop,
    calendars: [WEEKDAY_CALENDAR],
    calendarExceptions: [],
    loadedAt: Date.now(),
    terminalStopIdByTrip: new Map(),
    firstBoardableStopIdByTrip,
    departureTerminusStopIds: new Set()
  }
}

function inboundFeedArrivingAt(predictedArrival: number, vehicleId = 'v1', tripId = 'inbound-feeder'): DatabusTripUpdateFeed {
  return {
    header: { timestamp: predictedArrival - 60 },
    entity: [
      {
        id: vehicleId,
        trip_update: {
          trip: { trip_id: tripId, route_id: 'bUCR', direction_id: 1 },
          stop_time_update: [
            { stop_sequence: 9, stop_id: STOP_ID, arrival: { time: predictedArrival, uncertainty: 120 } }
          ]
        }
      }
    ]
  }
}

describe('deriveTerminusArrivals', () => {
  it('matched slot: shows estimated eta = max(scheduled, predicted+buffer), estimated:true, scheduledEta set', () => {
    const now = epochFor('2026-08-24', '07:55:00') // Monday
    const scheduledEpoch = epochFor('2026-08-24', '08:00:00')
    const gtfs = buildGtfs({ trips: [{ tripId: 'out-0800', departure: '08:00:00' }] })

    // Feeder predicted 5 minutes late -> departure pushed past scheduled.
    const predictedArrival = scheduledEpoch + 300
    const feed = inboundFeedArrivingAt(predictedArrival, 'v1', 'in-feeder')

    const result = deriveTerminusArrivals(feed, gtfs, STOP_ID, TZ, now, 5, DEFAULT_PARAMS)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      tripId: 'out-0800',
      estimated: true,
      scheduledEta: scheduledEpoch,
      eta: predictedArrival + DEFAULT_PARAMS.boardingBufferS,
      uncertaintySeconds: 120
    })
    expect(result[0].eta).toBeGreaterThan(result[0].scheduledEta!)
  })

  it('matched slot, on-time feeder: eta never earlier than the timetable (floored at scheduled)', () => {
    const now = epochFor('2026-08-24', '07:50:00')
    const scheduledEpoch = epochFor('2026-08-24', '08:00:00')
    const gtfs = buildGtfs({ trips: [{ tripId: 'out-0800', departure: '08:00:00' }] })

    // Feeder arrives 3 minutes early (typical turnaround) -> scheduled wins.
    const feed = inboundFeedArrivingAt(scheduledEpoch - 180)
    const result = deriveTerminusArrivals(feed, gtfs, STOP_ID, TZ, now, 5, DEFAULT_PARAMS)

    expect(result[0].eta).toBe(scheduledEpoch)
    expect(result[0].estimated).toBe(true)
    expect(result[0].scheduledEta).toBe(scheduledEpoch)
  })

  it('outbound-only feed (no inbound feeder): no bogus estimate, slot keeps the plain scheduled time', () => {
    const now = epochFor('2026-08-24', '06:00:00')
    const gtfs = buildGtfs({ trips: [{ tripId: 'out-0800', departure: '08:00:00' }] })
    const feed = loadFixture('trip_updates.sample.json') // outbound-only counter-case fixture

    const result = deriveTerminusArrivals(feed, gtfs, STOP_ID, TZ, now, 5, DEFAULT_PARAMS)

    expect(result).toHaveLength(1)
    expect(result[0].tripId).toBe('out-0800')
    expect(result[0].estimated).toBeFalsy()
    expect(result[0].scheduledEta).toBeUndefined()
    expect(result[0].eta).toBe(epochFor('2026-08-24', '08:00:00'))
  })

  it('an arrival outside the match window leaves the slot unmatched (plain schedule)', () => {
    const now = epochFor('2026-08-24', '06:00:00')
    const scheduledEpoch = epochFor('2026-08-24', '08:00:00')
    const gtfs = buildGtfs({ trips: [{ tripId: 'out-0800', departure: '08:00:00' }] })
    // 30 minutes late -- beyond default maxLayoverS (1200s / 20min).
    const feed = inboundFeedArrivingAt(scheduledEpoch + 1800)

    const result = deriveTerminusArrivals(feed, gtfs, STOP_ID, TZ, now, 5, DEFAULT_PARAMS)
    expect(result[0].estimated).toBeFalsy()
    expect(result[0].eta).toBe(scheduledEpoch)
  })

  it('returns [] when there are no scheduled slots at all (caller falls through to its own fallback)', () => {
    const now = epochFor('2026-08-24', '09:00:00') // after the only scheduled departure
    const gtfs = buildGtfs({ trips: [{ tripId: 'out-0800', departure: '08:00:00' }] })
    const feed = inboundFeedArrivingAt(now + 100)

    expect(deriveTerminusArrivals(feed, gtfs, STOP_ID, TZ, now, 5, DEFAULT_PARAMS)).toEqual([])
  })

  it('is defensive: a malformed feed degrades to [] rather than throwing', () => {
    const now = epochFor('2026-08-24', '06:00:00')
    const gtfs = buildGtfs({ trips: [{ tripId: 'out-0800', departure: '08:00:00' }] })
    const malformedFeed = { entity: 'not-an-array' } as unknown as DatabusTripUpdateFeed

    expect(() => deriveTerminusArrivals(malformedFeed, gtfs, STOP_ID, TZ, now, 5, DEFAULT_PARAMS)).not.toThrow()
  })

  it('real inbound fixture wired through the full pipeline: extraction + matching accepts the live feed shape end-to-end', () => {
    const feed = loadFixture('trip_updates.inbound.sample.json')
    const predictedArrival = 1787593332 // from design doc §9 / inbound-arrivals.test.ts
    const now = predictedArrival - 600
    // A slot scheduled 3 minutes after the feeder's predicted arrival --
    // typical bUCR turnaround (§4) -- expressed in UTC so departureSeconds
    // maps directly onto the fixture's raw epoch without a timezone offset.
    const scheduledEpoch = predictedArrival + 180
    const dayStartUtc = Math.floor(scheduledEpoch / 86400) * 86400
    const departureSeconds = scheduledEpoch - dayStartUtc

    const gtfs = buildGtfs({ trips: [{ tripId: 'out-real', departure: '00:00:00' }] })
    gtfs.stopTimesByStop.set(STOP_ID, [
      { tripId: 'out-real', stopId: STOP_ID, stopSequence: 1, arrivalSeconds: departureSeconds, departureSeconds, isBoardable: true }
    ])

    const result = deriveTerminusArrivals(feed, gtfs, STOP_ID, 'UTC', now, 5, DEFAULT_PARAMS)
    expect(result).toHaveLength(1)
    expect(result[0].estimated).toBe(true)
    // Scheduled (predictedArrival + 180) is later than predicted + buffer
    // (predictedArrival + 60), so the "never earlier than the timetable"
    // floor means scheduled wins here — this is the on-time-turnaround case.
    expect(result[0].eta).toBe(scheduledEpoch)
    expect(result[0].scheduledEta).toBe(scheduledEpoch)
  })
})
