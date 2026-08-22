import { describe, expect, it } from 'vitest'
import type { GtfsData, GtfsStopTime, GtfsTrip } from '../server/utils/gtfs'
import { nextDemoDepartures } from '../server/utils/demo-mode'

const STOP_ID = 'bUCR_0_01'
const DIRECTION_ID = 0
const DEFAULT_OPTIONS = { departingGraceSeconds: 180 }

function trip(tripId: string, serviceId: string, headsign: string, directionId: number | undefined = DIRECTION_ID, isMilla = false): GtfsTrip {
  return { tripId, routeId: 'bUCR', serviceId, headsign, directionId, isMilla }
}

// Departure time on the real GTFS schedule doesn't matter for demo mode
// beyond ordering (used only to determine first-seen headsign order) — use
// small distinct values.
function stopTime(tripId: string, order: number, stopId = STOP_ID): GtfsStopTime {
  return { tripId, stopId, stopSequence: 0, arrivalSeconds: order, departureSeconds: order }
}

function buildGtfs(trips: GtfsTrip[], stopTimes: GtfsStopTime[]): GtfsData {
  const tripsMap = new Map(trips.map((t) => [t.tripId, t]))
  const stopTimesByStop = new Map<string, GtfsStopTime[]>()
  for (const st of stopTimes) {
    const list = stopTimesByStop.get(st.stopId)
    if (list) list.push(st)
    else stopTimesByStop.set(st.stopId, [st])
  }
  return { stops: new Map(), trips: tripsMap, stopTimesByStop, calendars: [], calendarExceptions: [], loadedAt: Date.now() }
}

// Richest service alternates two legitimate (direction 0) destinations. A
// sparser service and a wrong-direction trip are present too, to confirm
// richness selection and direction filtering both still work — the
// wrong-direction trip mirrors bUCR's real feed at Educación, where a trip
// ending there (direction 1) has trip_headsign "Educación" itself.
const TWO_HEADSIGN_GTFS = buildGtfs(
  [
    trip('r1', 'rich', 'Odontología'),
    trip('r2', 'rich', 'Artes'),
    trip('r3', 'rich', 'Odontología'),
    trip('wrong-dir', 'rich', 'Educación', 1),
    trip('s1', 'sparse', 'Otro Destino'),
  ],
  [stopTime('r1', 0), stopTime('r2', 1), stopTime('r3', 2), stopTime('wrong-dir', 3), stopTime('s1', 0)]
)

describe('nextDemoDepartures', () => {
  it('returns an empty array when the stop has no stop_times at all', () => {
    const gtfs = buildGtfs([], [])
    expect(nextDemoDepartures(gtfs, STOP_ID, DIRECTION_ID, 0, 5, DEFAULT_OPTIONS)).toEqual([])
  })

  it('always fills exactly `limit` rows (never an empty board mid-cycle)', () => {
    for (const now of [0, 190, 500, 719, 720, 5000]) {
      const result = nextDemoDepartures(TWO_HEADSIGN_GTFS, STOP_ID, DIRECTION_ID, now, 5, DEFAULT_OPTIONS)
      expect(result).toHaveLength(5)
    }
  })

  it('shows the just-departed trip as departing (etaMinutes 0) at the moment of departure', () => {
    const result = nextDemoDepartures(TWO_HEADSIGN_GTFS, STOP_ID, DIRECTION_ID, 0, 5, DEFAULT_OPTIONS)
    expect(result[0]).toMatchObject({ tripId: 'demo-0', departing: true, etaMinutes: 0 })
    // eta is the real departure epoch, which is <= now once departing.
    expect(result[0]!.eta).toBeLessThanOrEqual(0)
  })

  it('computes correct etaMinutes for the upcoming departures after the departing one (gaps: 3, 4, 5, 3, 4... min)', () => {
    const result = nextDemoDepartures(TWO_HEADSIGN_GTFS, STOP_ID, DIRECTION_ID, 0, 5, DEFAULT_OPTIONS)
    expect(result.map((a) => a.etaMinutes)).toEqual([0, 3, 7, 12, 15])
    expect(result.map((a) => a.departing)).toEqual([true, false, false, false, false])
  })

  it('cycles headsigns round-robin through the distinct destinations found in the richest service', () => {
    const result = nextDemoDepartures(TWO_HEADSIGN_GTFS, STOP_ID, DIRECTION_ID, 0, 4, DEFAULT_OPTIONS)
    expect(result.map((a) => a.headsign)).toEqual(['Odontología', 'Artes', 'Odontología', 'Artes'])
  })

  it('never uses a wrong-direction trip as a destination, even though it belongs to the richest service', () => {
    const result = nextDemoDepartures(TWO_HEADSIGN_GTFS, STOP_ID, DIRECTION_ID, 0, 10, DEFAULT_OPTIONS)
    expect(result.every((a) => a.headsign !== 'Educación')).toBe(true)
  })

  it('moves the "departing" trip forward once a later one has since departed', () => {
    // Trip at index 1 departs at t=180 (see GAP_PATTERN_SECONDS: 180, 240, 300).
    // At t=190, index 1 is now the most recently departed trip, not index 0.
    const result = nextDemoDepartures(TWO_HEADSIGN_GTFS, STOP_ID, DIRECTION_ID, 190, 5, DEFAULT_OPTIONS)
    expect(result[0]).toMatchObject({ tripId: 'demo-1', departing: true })
  })

  it('shows no departing trip once its grace window has expired', () => {
    const shortGrace = { departingGraceSeconds: 10 }
    // Index 1 departs at t=180; by t=195 that's 15s ago, past a 10s grace.
    const result = nextDemoDepartures(TWO_HEADSIGN_GTFS, STOP_ID, DIRECTION_ID, 195, 5, shortGrace)
    expect(result.some((a) => a.departing)).toBe(false)
    expect(result[0]!.tripId).toBe('demo-2')
  })

  it('keeps working correctly across a pattern repetition (index >= 3)', () => {
    // t=720 is exactly the start of the second repetition of the 3-gap pattern.
    const result = nextDemoDepartures(TWO_HEADSIGN_GTFS, STOP_ID, DIRECTION_ID, 720, 3, DEFAULT_OPTIONS)
    expect(result.map((a) => a.tripId)).toEqual(['demo-3', 'demo-4', 'demo-5'])
    expect(result.map((a) => a.etaMinutes)).toEqual([0, 3, 7])
  })

  it('treats a "con milla" trip as a distinct destination from its identical-headsign sin-milla counterpart', () => {
    const gtfs = buildGtfs(
      [trip('r1', 'rich', 'Odontología', DIRECTION_ID, false), trip('r2', 'rich', 'Odontología', DIRECTION_ID, true)],
      [stopTime('r1', 0), stopTime('r2', 1)]
    )
    const result = nextDemoDepartures(gtfs, STOP_ID, DIRECTION_ID, 0, 4, DEFAULT_OPTIONS)
    expect(result.map((a) => a.viaMilla)).toEqual([false, true, false, true])
    expect(result.every((a) => a.headsign === 'Odontología')).toBe(true)
  })
})
