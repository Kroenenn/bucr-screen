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

/** A GtfsData with one outbound-from-terminus trip departing STOP_ID at `departure`, and terminalStopIdByTrip/firstBoardableStopIdByTrip/departureTerminusStopIds populated the way gtfs.ts's real parser does. */
function buildGtfs(opts: {
  trips: Array<{ tripId: string, departure: string, headsign?: string, isMilla?: boolean }>
  inboundTrips?: Array<{ tripId: string }>
}): GtfsData {
  const trips = new Map<string, GtfsTrip>()
  const stopTimesByStop = new Map<string, GtfsStopTime[]>()
  const firstBoardableStopIdByTrip = new Map<string, string>()
  const terminalStopIdByTrip = new Map<string, string>()

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
    // Outbound trips don't terminate at the terminus; they start here. Set an arbitrary terminal.
    terminalStopIdByTrip.set(t.tripId, 'bUCR_0_02')
  }

  // Add inbound trips that terminate at STOP_ID.
  for (const t of opts.inboundTrips ?? []) {
    trips.set(t.tripId, { tripId: t.tripId, routeId: 'bUCR', serviceId: 'entresemana', headsign: 'Educación', isMilla: false })
    // Inbound trip has a terminal stop_time at STOP_ID (seq 9, non-boardable).
    const st: GtfsStopTime = {
      tripId: t.tripId,
      stopId: STOP_ID,
      stopSequence: 9,
      arrivalSeconds: 0, // irrelevant for inbound extraction
      departureSeconds: 0,
      isBoardable: false
    }
    const list = stopTimesByStop.get(STOP_ID)
    if (list) list.push(st)
    else stopTimesByStop.set(STOP_ID, [st])
    terminalStopIdByTrip.set(t.tripId, STOP_ID)
  }

  // Precompute departureTerminusStopIds the way gtfs.ts does: intersection of terminals and first-boardables.
  const outboundStops = new Set(firstBoardableStopIdByTrip.values())
  const departureTerminusStopIds = new Set([...new Set(terminalStopIdByTrip.values())].filter(s => outboundStops.has(s)))

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
    terminalStopIdByTrip,
    firstBoardableStopIdByTrip,
    departureTerminusStopIds
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
    const gtfs = buildGtfs({ trips: [{ tripId: 'out-0800', departure: '08:00:00' }], inboundTrips: [{ tripId: 'in-feeder' }] })

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
    const gtfs = buildGtfs({ trips: [{ tripId: 'out-0800', departure: '08:00:00' }], inboundTrips: [{ tripId: 'inbound-feeder' }] })

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

    const inboundTripId = 'desde_odontologia_a_educacion_entresemana_11:25'
    const gtfs = buildGtfs({
      trips: [{ tripId: 'out-real', departure: '00:00:00' }],
      inboundTrips: [{ tripId: inboundTripId }]
    })
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

  it('late-feeder regression: a passed slot with a live feeder appears as a delayed departure (ETA = predicted+buffer), then future slot', () => {
    // Reproduces the live scenario: now=12:41:34, inbound feeder arrives ~12:41:26,
    // its 12:35 slot is already passed but the bus hasn't left yet.
    const now = epochFor('2026-08-24', '12:41:34') // Monday
    const passedSlotScheduled = epochFor('2026-08-24', '12:35:00') // ~6 min ago
    const nextSlotScheduled = epochFor('2026-08-24', '13:00:00') // future

    const gtfs = buildGtfs({
      trips: [
        { tripId: 'out-1235', departure: '12:35:00' },
        { tripId: 'out-1300', departure: '13:00:00' }
      ],
      inboundTrips: [{ tripId: 'in-1215' }]
    })

    // Inbound feeder predicted at terminus ~12:41:26, so with buffer it departs at ~12:42:26.
    const predictedArrival = epochFor('2026-08-24', '12:41:26')
    const feed = inboundFeedArrivingAt(predictedArrival, 'v-late', 'in-1215')

    const result = deriveTerminusArrivals(feed, gtfs, STOP_ID, TZ, now, 5, DEFAULT_PARAMS)

    // Both slots appear: the late 12:35 bus (estimated) + the 13:00 plain schedule.
    expect(result).toHaveLength(2)
    expect(result[0].tripId).toBe('out-1235')
    expect(result[0].estimated).toBe(true)
    expect(result[0].scheduledEta).toBe(passedSlotScheduled)
    // ETA = predictedArrival + boarding buffer (60s) = ~12:42:26
    expect(result[0].eta).toBe(predictedArrival + DEFAULT_PARAMS.boardingBufferS)
    expect(result[0].eta).toBeGreaterThan(now) // still future (boarding)
    expect(result[0].etaMinutes).toBe(Math.floor((predictedArrival + DEFAULT_PARAMS.boardingBufferS - now) / 60))

    expect(result[1].tripId).toBe('out-1300')
    expect(result[1].estimated).toBeFalsy()
    expect(result[1].scheduledEta).toBeUndefined()
    expect(result[1].eta).toBe(nextSlotScheduled)
  })

  it('passed slot with NO feeder is dropped (departed on time, today behavior)', () => {
    const now = epochFor('2026-08-24', '12:40:00')
    const gtfs = buildGtfs({ trips: [{ tripId: 'out-1235', departure: '12:35:00' }] })
    const feed = loadFixture('trip_updates.outbound.sample.json') // no inbound feeder (or empty)

    const result = deriveTerminusArrivals(feed, gtfs, STOP_ID, TZ, now, 5, DEFAULT_PARAMS)
    expect(result).toEqual([]) // no slots to show
  })

  it('passed slot matched but feeder already departed (estimatedDeparture <= now) is dropped', () => {
    const now = epochFor('2026-08-24', '12:43:00')
    const gtfs = buildGtfs({ trips: [{ tripId: 'out-1235', departure: '12:35:00' }], inboundTrips: [{ tripId: 'in-1215' }] })
    // Feeder arrived at 12:41:26, so with buffer it would depart at 12:42:26 — already in the past now.
    const predictedArrival = epochFor('2026-08-24', '12:41:26')
    const feed = inboundFeedArrivingAt(predictedArrival, 'v-departed', 'in-1215')

    const result = deriveTerminusArrivals(feed, gtfs, STOP_ID, TZ, now, 5, DEFAULT_PARAMS)
    expect(result).toEqual([]) // bus already left
  })
})
