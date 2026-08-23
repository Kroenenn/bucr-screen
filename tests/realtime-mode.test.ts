import { describe, expect, it } from 'vitest'
import type { GtfsData } from '../server/utils/gtfs'
import { deriveArrivalsFromFeed, type DatabusTripUpdateFeed } from '../server/utils/realtime-mode'

const STOP_ID = 'bUCR_0_01'
const NOW = 1_800_000_000
const STALE_THRESHOLD = 90

interface StopTimeUpdateEntry {
  stop_id: string
  stop_sequence?: number
  arrival?: { time?: number, uncertainty?: number }
  departure?: { time?: number, uncertainty?: number }
}

function emptyGtfs(): GtfsData {
  return { agency: null, routes: new Map(), feedInfo: null, stops: new Map(), trips: new Map(), stopTimesByStop: new Map(), calendars: [], calendarExceptions: [], loadedAt: Date.now() }
}

function gtfsWithHeadsign(tripId: string, headsign: string, isMilla = false): GtfsData {
  const gtfs = emptyGtfs()
  gtfs.trips.set(tripId, { tripId, routeId: 'bUCR', serviceId: 'entresemana', headsign, isMilla })
  return gtfs
}

/** A GtfsData whose static schedule marks `tripId` as not boardable at STOP_ID (trip ends here). */
function gtfsWithNonBoardableTrip(tripId: string): GtfsData {
  const gtfs = emptyGtfs()
  gtfs.stopTimesByStop.set(STOP_ID, [
    { tripId, stopId: STOP_ID, stopSequence: 9, arrivalSeconds: 0, departureSeconds: 0, isBoardable: false }
  ])
  return gtfs
}

function feedWithEntity(stopTimeUpdate: StopTimeUpdateEntry[], headerTimestamp = NOW, tripId = 't1'): DatabusTripUpdateFeed {
  return {
    header: { timestamp: headerTimestamp },
    entity: [
      {
        id: 'vehicle-1',
        trip_update: {
          trip: { trip_id: tripId, route_id: 'bUCR' },
          stop_time_update: stopTimeUpdate
        }
      }
    ]
  }
}

describe('deriveArrivalsFromFeed', () => {
  it('is unhealthy when the feed header timestamp is older than the stale threshold', () => {
    const feed = feedWithEntity([{ stop_id: STOP_ID, arrival: { time: NOW + 120 } }], NOW - 200)
    const result = deriveArrivalsFromFeed(feed, emptyGtfs(), STOP_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.healthy).toBe(false)
    expect(result.arrivals).toEqual([])
  })

  it('is unhealthy when no stop_time_update entries match the target stop', () => {
    const feed = feedWithEntity([{ stop_id: 'some-other-stop', arrival: { time: NOW + 120 } }])
    const result = deriveArrivalsFromFeed(feed, emptyGtfs(), STOP_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.healthy).toBe(false)
  })

  it('returns a healthy result with a headsign joined from static GTFS trips', () => {
    const feed = feedWithEntity([{ stop_id: STOP_ID, arrival: { time: NOW + 300, uncertainty: 30 } }])
    const gtfs = gtfsWithHeadsign('t1', 'Odontología')
    const result = deriveArrivalsFromFeed(feed, gtfs, STOP_ID, NOW, 5, STALE_THRESHOLD)

    expect(result.healthy).toBe(true)
    expect(result.arrivals).toHaveLength(1)
    expect(result.arrivals[0]).toMatchObject({ tripId: 't1', headsign: 'Odontología', etaMinutes: 5, uncertaintySeconds: 30 })
  })

  it('falls back to route_id as the headsign when the trip is unknown in static GTFS', () => {
    const feed = feedWithEntity([{ stop_id: STOP_ID, arrival: { time: NOW + 60 } }])
    const result = deriveArrivalsFromFeed(feed, emptyGtfs(), STOP_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.arrivals[0].headsign).toBe('bUCR')
  })

  it('keeps an arrival within the departure grace window but drops one further in the past', () => {
    const feed: DatabusTripUpdateFeed = {
      header: { timestamp: NOW },
      entity: [
        { id: 'v1', trip_update: { trip: { trip_id: 't1', route_id: 'bUCR' }, stop_time_update: [{ stop_id: STOP_ID, arrival: { time: NOW - 10 } }] } },
        { id: 'v2', trip_update: { trip: { trip_id: 't2', route_id: 'bUCR' }, stop_time_update: [{ stop_id: STOP_ID, arrival: { time: NOW - 60 } }] } }
      ]
    }
    const result = deriveArrivalsFromFeed(feed, emptyGtfs(), STOP_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.arrivals.map(a => a.tripId)).toEqual(['t1'])
  })

  it('excludes a trip the static schedule marks as not boardable at this stop (its last stop_sequence)', () => {
    // Mirrors bUCR's real feed at Educación: a trip ending there still has
    // a live stop_time_update, but the static schedule says it's arriving
    // to go out of service, not boarding anyone.
    const feed = feedWithEntity([{ stop_id: STOP_ID, arrival: { time: NOW + 120 } }], NOW, 't1')
    const result = deriveArrivalsFromFeed(feed, gtfsWithNonBoardableTrip('t1'), STOP_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.healthy).toBe(false)
  })

  it('includes a live trip_id the static schedule has never heard of (e.g. an ADDED trip) — fails open', () => {
    const feed = feedWithEntity([{ stop_id: STOP_ID, arrival: { time: NOW + 120 } }], NOW, 'brand-new-trip')
    const result = deriveArrivalsFromFeed(feed, emptyGtfs(), STOP_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.healthy).toBe(true)
  })

  it('flags viaMilla from the static GTFS trip when it is known', () => {
    const feed = feedWithEntity([{ stop_id: STOP_ID, arrival: { time: NOW + 120 } }])
    const gtfs = gtfsWithHeadsign('t1', 'Odontología', true)
    const result = deriveArrivalsFromFeed(feed, gtfs, STOP_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.arrivals[0]?.viaMilla).toBe(true)
  })

  it('falls back to the live trip_id itself for viaMilla when the trip is unknown in static GTFS', () => {
    const feed = feedWithEntity([{ stop_id: STOP_ID, arrival: { time: NOW + 120 } }], NOW, 'desde_educacion_a_odontologia_con_milla_entresemana_19:30')
    const result = deriveArrivalsFromFeed(feed, emptyGtfs(), STOP_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.arrivals[0]?.viaMilla).toBe(true)
  })
})
