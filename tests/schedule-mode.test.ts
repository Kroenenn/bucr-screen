import { describe, expect, it } from 'vitest'
import type { GtfsCalendar, GtfsCalendarException, GtfsData, GtfsStopTime, GtfsTrip } from '../server/utils/gtfs'
import { nextDepartures } from '../server/utils/schedule-mode'

const STOP_ID = 'bUCR_0_01'
const TZ = 'America/Costa_Rica'

/** Costa Rica is a fixed UTC-6 offset — see server/utils/time.ts. */
function epochFor(dateStr: string, hhmmss: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm, ss] = hhmmss.split(':').map(Number)
  return Date.UTC(y, m - 1, d, hh, mm, ss) / 1000 + 6 * 3600
}

function trip(tripId: string, serviceId: string, headsign = 'Odontología', isMilla = false): GtfsTrip {
  return { tripId, routeId: 'bUCR', serviceId, headsign, isMilla }
}

function stopTime(tripId: string, departure: string, stopId = STOP_ID, isBoardable = true): GtfsStopTime {
  const [hh, mm, ss] = departure.split(':').map(Number)
  const seconds = hh * 3600 + mm * 60 + ss
  return { tripId, stopId, stopSequence: 0, arrivalSeconds: seconds, departureSeconds: seconds, isBoardable }
}

function buildGtfs(opts: { trips: GtfsTrip[], stopTimes: GtfsStopTime[], calendars: GtfsCalendar[], exceptions?: GtfsCalendarException[] }): GtfsData {
  const trips = new Map(opts.trips.map(t => [t.tripId, t]))
  const stopTimesByStop = new Map<string, GtfsStopTime[]>()
  for (const st of opts.stopTimes) {
    const list = stopTimesByStop.get(st.stopId)
    if (list) list.push(st)
    else stopTimesByStop.set(st.stopId, [st])
  }
  return {
    agency: null,
    routes: new Map(),
    feedInfo: null,
    stops: new Map([[STOP_ID, { id: STOP_ID, name: 'Educación' }]]),
    trips,
    stopTimesByStop,
    calendars: opts.calendars,
    calendarExceptions: opts.exceptions ?? [],
    loadedAt: Date.now(),
    terminalStopIdByTrip: new Map(),
    firstBoardableStopIdByTrip: new Map(),
    departureTerminusStopIds: new Set()
  }
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

describe('nextDepartures', () => {
  it('returns upcoming departures sorted by time with correct etaMinutes', () => {
    // 2026-08-24 is a Monday.
    const gtfs = buildGtfs({
      trips: [trip('t1', 'entresemana'), trip('t2', 'entresemana'), trip('t3', 'entresemana')],
      stopTimes: [stopTime('t1', '07:00:00'), stopTime('t2', '07:15:00'), stopTime('t3', '07:30:00')],
      calendars: [WEEKDAY_CALENDAR]
    })

    const now = epochFor('2026-08-24', '07:05:00')
    const result = nextDepartures(gtfs, STOP_ID, TZ, now, 5)

    expect(result.map(a => a.tripId)).toEqual(['t2', 't3'])
    expect(result[0].etaMinutes).toBe(10)
    expect(result[1].etaMinutes).toBe(25)
  })

  it('excludes departures already in the past', () => {
    const gtfs = buildGtfs({
      trips: [trip('t1', 'entresemana')],
      stopTimes: [stopTime('t1', '07:00:00')],
      calendars: [WEEKDAY_CALENDAR]
    })

    const now = epochFor('2026-08-24', '08:00:00')
    expect(nextDepartures(gtfs, STOP_ID, TZ, now, 5)).toEqual([])
  })

  it('respects the weekday flags on calendar.txt (no service on Sunday)', () => {
    const gtfs = buildGtfs({
      trips: [trip('t1', 'entresemana')],
      stopTimes: [stopTime('t1', '07:00:00')],
      calendars: [WEEKDAY_CALENDAR]
    })

    // 2026-08-23 is a Sunday.
    const now = epochFor('2026-08-23', '06:00:00')
    expect(nextDepartures(gtfs, STOP_ID, TZ, now, 5)).toEqual([])
  })

  it('removes an otherwise-active service on a calendar_dates.txt holiday exception', () => {
    const gtfs = buildGtfs({
      trips: [trip('t1', 'entresemana')],
      stopTimes: [stopTime('t1', '07:00:00')],
      calendars: [WEEKDAY_CALENDAR],
      exceptions: [{ serviceId: 'entresemana', date: '20260824', exceptionType: 2 }]
    })

    const now = epochFor('2026-08-24', '06:00:00')
    expect(nextDepartures(gtfs, STOP_ID, TZ, now, 5)).toEqual([])
  })

  it('adds an otherwise-inactive service via a calendar_dates.txt "added" exception', () => {
    const gtfs = buildGtfs({
      trips: [trip('t1', 'special')],
      stopTimes: [stopTime('t1', '07:00:00')],
      calendars: [], // "special" has no calendar.txt row at all
      exceptions: [{ serviceId: 'special', date: '20260823', exceptionType: 1 }]
    })

    // 2026-08-23 is a Sunday, no calendar.txt service runs, but the exception adds one.
    const now = epochFor('2026-08-23', '06:00:00')
    expect(nextDepartures(gtfs, STOP_ID, TZ, now, 5).map(a => a.tripId)).toEqual(['t1'])
  })

  it('treats a departure_time >= 24:00:00 as belonging to the previous service day', () => {
    // A 25:30:00 departure on Monday's service is really 01:30 on Tuesday.
    const gtfs = buildGtfs({
      trips: [trip('t1', 'entresemana')],
      stopTimes: [stopTime('t1', '25:30:00')],
      calendars: [WEEKDAY_CALENDAR]
    })

    const now = epochFor('2026-08-25', '01:00:00') // Tuesday 01:00
    const result = nextDepartures(gtfs, STOP_ID, TZ, now, 5)
    expect(result.map(a => a.tripId)).toEqual(['t1'])
    expect(result[0].etaMinutes).toBe(30)
  })

  it('excludes a non-boardable stop_time (trip ends here, or pickup_type forbids it)', () => {
    // Mirrors bUCR's real feed at Educación: a trip ending there with a
    // trip_headsign matching the stop's own name is not boardable.
    const gtfs = buildGtfs({
      trips: [trip('t1', 'entresemana', 'Educación'), trip('t2', 'entresemana', 'Odontología')],
      stopTimes: [stopTime('t1', '07:00:00', STOP_ID, false), stopTime('t2', '07:05:00', STOP_ID, true)],
      calendars: [WEEKDAY_CALENDAR]
    })

    const now = epochFor('2026-08-24', '06:00:00')
    expect(nextDepartures(gtfs, STOP_ID, TZ, now, 5).map(a => a.tripId)).toEqual(['t2'])
  })

  it('caps the result at the requested limit', () => {
    const gtfs = buildGtfs({
      trips: [trip('t1', 'entresemana'), trip('t2', 'entresemana'), trip('t3', 'entresemana')],
      stopTimes: [stopTime('t1', '07:00:00'), stopTime('t2', '07:05:00'), stopTime('t3', '07:10:00')],
      calendars: [WEEKDAY_CALENDAR]
    })

    const now = epochFor('2026-08-24', '06:00:00')
    expect(nextDepartures(gtfs, STOP_ID, TZ, now, 2)).toHaveLength(2)
  })

  it('flags a "con milla" trip so the frontend can badge it — same headsign, different route', () => {
    const gtfs = buildGtfs({
      trips: [trip('t1', 'entresemana', 'Odontología', true), trip('t2', 'entresemana', 'Odontología', false)],
      stopTimes: [stopTime('t1', '19:30:00'), stopTime('t2', '07:00:00')],
      calendars: [WEEKDAY_CALENDAR]
    })

    const now = epochFor('2026-08-24', '06:00:00')
    const result = nextDepartures(gtfs, STOP_ID, TZ, now, 5)
    expect(result.find(a => a.tripId === 't1')?.viaMilla).toBe(true)
    expect(result.find(a => a.tripId === 't2')?.viaMilla).toBe(false)
  })

  it('uses a different timezone correctly when given one', () => {
    // UTC has no offset — a stop_time at "07:00:00" local should match
    // an epoch that's exactly 07:00 UTC, not 07:00 minus some CR offset.
    const gtfs = buildGtfs({
      trips: [trip('t1', 'entresemana')],
      stopTimes: [stopTime('t1', '07:00:00')],
      calendars: [WEEKDAY_CALENDAR]
    })

    // 2026-08-24 06:00 UTC, a Monday.
    const now = Date.UTC(2026, 7, 24, 6, 0, 0) / 1000
    const result = nextDepartures(gtfs, STOP_ID, 'UTC', now, 5)
    expect(result.map(a => a.tripId)).toEqual(['t1'])
    expect(result[0].etaMinutes).toBe(60)
  })
})
