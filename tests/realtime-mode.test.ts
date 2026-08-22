import { describe, expect, it } from 'vitest'
import type { GtfsData } from '../server/utils/gtfs'
import { deriveArrivalsFromFeed, type DatabusTripUpdateFeed } from '../server/utils/realtime-mode'

const STOP_ID = 'bUCR_0_01'
const DIRECTION_ID = 0
const NOW = 1_800_000_000
const STALE_THRESHOLD = 90

interface StopTimeUpdateEntry {
  stop_id: string
  stop_sequence?: number
  arrival?: { time?: number; uncertainty?: number }
  departure?: { time?: number; uncertainty?: number }
}

function emptyGtfs(): GtfsData {
  return { stops: new Map(), trips: new Map(), stopTimesByStop: new Map(), calendars: [], calendarExceptions: [], loadedAt: Date.now() }
}

function gtfsWithHeadsign(tripId: string, headsign: string, isMilla = false): GtfsData {
  const gtfs = emptyGtfs()
  gtfs.trips.set(tripId, { tripId, routeId: 'bUCR', serviceId: 'entresemana', headsign, isMilla })
  return gtfs
}

function feedWithEntity(stopTimeUpdate: StopTimeUpdateEntry[], headerTimestamp = NOW, tripDirectionId: number | undefined = DIRECTION_ID): DatabusTripUpdateFeed {
  return {
    header: { timestamp: headerTimestamp },
    entity: [
      {
        id: 'vehicle-1',
        trip_update: {
          trip: { trip_id: 't1', route_id: 'bUCR', direction_id: tripDirectionId },
          stop_time_update: stopTimeUpdate,
        },
      },
    ],
  }
}

describe('deriveArrivalsFromFeed', () => {
  it('is unhealthy when the feed header timestamp is older than the stale threshold', () => {
    const feed = feedWithEntity([{ stop_id: STOP_ID, arrival: { time: NOW + 120 } }], NOW - 200)
    const result = deriveArrivalsFromFeed(feed, emptyGtfs(), STOP_ID, DIRECTION_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.healthy).toBe(false)
    expect(result.arrivals).toEqual([])
  })

  it('is unhealthy when no stop_time_update entries match the target stop', () => {
    const feed = feedWithEntity([{ stop_id: 'some-other-stop', arrival: { time: NOW + 120 } }])
    const result = deriveArrivalsFromFeed(feed, emptyGtfs(), STOP_ID, DIRECTION_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.healthy).toBe(false)
  })

  it('returns a healthy result with a headsign joined from static GTFS trips', () => {
    const feed = feedWithEntity([{ stop_id: STOP_ID, arrival: { time: NOW + 300, uncertainty: 30 } }])
    const gtfs = gtfsWithHeadsign('t1', 'Odontología')
    const result = deriveArrivalsFromFeed(feed, gtfs, STOP_ID, DIRECTION_ID, NOW, 5, STALE_THRESHOLD)

    expect(result.healthy).toBe(true)
    expect(result.arrivals).toHaveLength(1)
    expect(result.arrivals[0]).toMatchObject({ tripId: 't1', headsign: 'Odontología', etaMinutes: 5, uncertaintySeconds: 30 })
  })

  it('falls back to route_id as the headsign when the trip is unknown in static GTFS', () => {
    const feed = feedWithEntity([{ stop_id: STOP_ID, arrival: { time: NOW + 60 } }])
    const result = deriveArrivalsFromFeed(feed, emptyGtfs(), STOP_ID, DIRECTION_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.arrivals[0].headsign).toBe('bUCR')
  })

  it('keeps an arrival within the departure grace window but drops one further in the past', () => {
    const feed: DatabusTripUpdateFeed = {
      header: { timestamp: NOW },
      entity: [
        { id: 'v1', trip_update: { trip: { trip_id: 't1', route_id: 'bUCR', direction_id: DIRECTION_ID }, stop_time_update: [{ stop_id: STOP_ID, arrival: { time: NOW - 10 } }] } },
        { id: 'v2', trip_update: { trip: { trip_id: 't2', route_id: 'bUCR', direction_id: DIRECTION_ID }, stop_time_update: [{ stop_id: STOP_ID, arrival: { time: NOW - 60 } }] } },
      ],
    }
    const result = deriveArrivalsFromFeed(feed, emptyGtfs(), STOP_ID, DIRECTION_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.arrivals.map((a) => a.tripId)).toEqual(['t1'])
  })

  it('excludes a trip running the opposite direction_id — a two-way terminus stop_time is not boardable', () => {
    // Mirrors bUCR's real feed at Educación: a trip ending there runs
    // direction_id 1, even though it still has a stop_time_update for the stop.
    const feed = feedWithEntity([{ stop_id: STOP_ID, arrival: { time: NOW + 120 } }], NOW, 1)
    const result = deriveArrivalsFromFeed(feed, emptyGtfs(), STOP_ID, DIRECTION_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.healthy).toBe(false)
  })

  it('includes a trip with no direction_id at all (fails open — GTFS-RT makes the field optional)', () => {
    const feed = feedWithEntity([{ stop_id: STOP_ID, arrival: { time: NOW + 120 } }], NOW, undefined)
    const result = deriveArrivalsFromFeed(feed, emptyGtfs(), STOP_ID, DIRECTION_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.healthy).toBe(true)
  })

  it('flags viaMilla from the static GTFS trip when it is known', () => {
    const feed = feedWithEntity([{ stop_id: STOP_ID, arrival: { time: NOW + 120 } }])
    const gtfs = gtfsWithHeadsign('t1', 'Odontología', true)
    const result = deriveArrivalsFromFeed(feed, gtfs, STOP_ID, DIRECTION_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.arrivals[0]?.viaMilla).toBe(true)
  })

  it('falls back to the live trip_id itself for viaMilla when the trip is unknown in static GTFS', () => {
    const feed: DatabusTripUpdateFeed = {
      header: { timestamp: NOW },
      entity: [
        {
          id: 'v1',
          trip_update: {
            trip: { trip_id: 'desde_educacion_a_odontologia_con_milla_entresemana_19:30', route_id: 'bUCR', direction_id: DIRECTION_ID },
            stop_time_update: [{ stop_id: STOP_ID, arrival: { time: NOW + 120 } }],
          },
        },
      ],
    }
    const result = deriveArrivalsFromFeed(feed, emptyGtfs(), STOP_ID, DIRECTION_ID, NOW, 5, STALE_THRESHOLD)
    expect(result.arrivals[0]?.viaMilla).toBe(true)
  })
})
