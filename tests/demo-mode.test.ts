import { describe, expect, it } from 'vitest'
import type { GtfsData, GtfsStopTime, GtfsTrip } from '../server/utils/gtfs'
import { nextDemoDepartures } from '../server/utils/demo-mode'

const STOP_ID = 'bUCR_0_01'
// cycleSeconds=420 against a 4200s real span -> speedMultiplier=10, easy to reason about by hand.
const OPTIONS = { cycleSeconds: 420, departingGraceSeconds: 180 }

function trip(tripId: string, serviceId: string, headsign: string, isMilla = false): GtfsTrip {
  return { tripId, routeId: 'bUCR', serviceId, headsign, isMilla }
}

function stopTime(tripId: string, departureSeconds: number, stopId = STOP_ID, isBoardable = true): GtfsStopTime {
  return { tripId, stopId, stopSequence: 0, arrivalSeconds: departureSeconds, departureSeconds, isBoardable }
}

function buildGtfs(trips: GtfsTrip[], stopTimes: GtfsStopTime[]): GtfsData {
  const tripsMap = new Map(trips.map(t => [t.tripId, t]))
  const stopTimesByStop = new Map<string, GtfsStopTime[]>()
  for (const st of stopTimes) {
    const list = stopTimesByStop.get(st.stopId)
    if (list) list.push(st)
    else stopTimesByStop.set(st.stopId, [st])
  }
  return { agency: null, routes: new Map(), feedInfo: null, stops: new Map(), trips: tripsMap, stopTimesByStop, calendars: [], calendarExceptions: [], loadedAt: Date.now() }
}

// Real-looking, unevenly-spaced departures (like bUCR's actual schedule):
// 06:20, 06:40 (+20min), 07:10 (+30min), 07:30 (+20min con milla).
const REAL_SCHEDULE_GTFS = buildGtfs(
  [
    trip('r1', 'rich', 'Odontología'),
    trip('r2', 'rich', 'Odontología'),
    trip('r3', 'rich', 'Odontología'),
    trip('r4', 'rich', 'Odontología', true),
    trip('wrong-stop', 'rich', 'Educación'),
    trip('s1', 'sparse', 'Otro Destino')
  ],
  [
    stopTime('r1', 22800), // 06:20:00
    stopTime('r2', 24000), // 06:40:00
    stopTime('r3', 25800), // 07:10:00
    stopTime('r4', 27000), // 07:30:00
    stopTime('wrong-stop', 28000, STOP_ID, false), // not boardable — should never appear
    stopTime('s1', 0) // sparse service, richness loses to "rich"
  ]
)

describe('nextDemoDepartures', () => {
  it('returns an empty array when the stop has no boardable stop_times at all', () => {
    const gtfs = buildGtfs([], [])
    expect(nextDemoDepartures(gtfs, STOP_ID, 0, 5, OPTIONS)).toEqual([])
  })

  it('uses real schedule gaps for etaMinutes, not a fabricated pattern', () => {
    // At the very start of the cycle, simulatedNow == first departure (r1).
    const result = nextDemoDepartures(REAL_SCHEDULE_GTFS, STOP_ID, 0, 4, OPTIONS)
    expect(result.map(a => a.tripId)).toEqual(['r1', 'r2', 'r3', 'r4'])
    // Real gaps: r1=0, r2=+20min, r3=+50min (20+30), r4=+70min (20+30+20).
    expect(result.map(a => a.etaMinutes)).toEqual([0, 20, 50, 70])
  })

  it('never includes a non-boardable stop_time, even from the richest service', () => {
    const result = nextDemoDepartures(REAL_SCHEDULE_GTFS, STOP_ID, 0, 10, OPTIONS)
    expect(result.some(a => a.tripId === 'wrong-stop')).toBe(false)
  })

  it('carries real per-trip viaMilla through instead of a synthetic pattern', () => {
    const result = nextDemoDepartures(REAL_SCHEDULE_GTFS, STOP_ID, 0, 4, OPTIONS)
    expect(result.map(a => a.viaMilla)).toEqual([false, false, false, true])
  })

  it('shows the most recently departed trip as "departing" while within its grace window', () => {
    // speedMultiplier = 4200/420 = 10. At realEpochSeconds=5, compressed
    // clock has advanced 50s past r1's departure (22800 -> 22850).
    const result = nextDemoDepartures(REAL_SCHEDULE_GTFS, STOP_ID, 5, 4, OPTIONS)
    expect(result[0]).toMatchObject({ tripId: 'r1', departing: true, etaMinutes: 0 })
    expect(result.slice(1).map(a => a.tripId)).toEqual(['r2', 'r3', 'r4'])
  })

  it('stops showing "departing" once the grace window (schedule-equivalent seconds) has elapsed', () => {
    const shortGrace = { cycleSeconds: 420, departingGraceSeconds: 10 }
    // 50 schedule-seconds since r1 departed > 10s grace.
    const result = nextDemoDepartures(REAL_SCHEDULE_GTFS, STOP_ID, 5, 4, shortGrace)
    expect(result.some(a => a.departing)).toBe(false)
    expect(result.map(a => a.tripId)).toEqual(['r2', 'r3', 'r4'])
  })

  it('tapers off near the end of the represented day instead of padding with fabricated rows', () => {
    // Push simulatedNow just past r4 (last departure) and outside its grace
    // window: secondsIntoCycle must land past 4200 (r4 offset) + grace.
    // realEpochSeconds * 10 mod 4200 == 4199 -> simulatedNow = 22800+4199 = 26999...
    // easier: pick realEpochSeconds so secondsIntoCycle = 4199 (just before wrap).
    const result = nextDemoDepartures(REAL_SCHEDULE_GTFS, STOP_ID, 419.9, 4, OPTIONS)
    expect(result.length).toBeLessThan(4)
  })

  it('wraps back to the first departure once the compressed clock completes a full cycle', () => {
    // secondsIntoCycle wraps exactly at spanSeconds (4200s of compressed time = 420 real seconds).
    const result = nextDemoDepartures(REAL_SCHEDULE_GTFS, STOP_ID, 420, 1, OPTIONS)
    expect(result[0]?.tripId).toBe('r1')
  })

  it('caps the result at the requested limit', () => {
    const result = nextDemoDepartures(REAL_SCHEDULE_GTFS, STOP_ID, 0, 2, OPTIONS)
    expect(result).toHaveLength(2)
  })
})
