import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GtfsData } from '../server/utils/gtfs'
import { extractInboundArrivals, type DatabusTripUpdateFeed } from '../server/utils/realtime-mode'

const STOP_ID = 'bUCR_0_01'
const NOW = 1_800_000_000

const FIXTURE_DIR = join(__dirname, '..', 'design', 'feed-samples')

function loadFixture(name: string): DatabusTripUpdateFeed {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8')) as DatabusTripUpdateFeed
}

function emptyGtfs(): GtfsData {
  return {
    agency: null,
    routes: new Map(),
    feedInfo: null,
    stops: new Map(),
    trips: new Map(),
    stopTimesByStop: new Map(),
    calendars: [],
    calendarExceptions: [],
    loadedAt: Date.now(),
    terminalStopIdByTrip: new Map(),
    firstBoardableStopIdByTrip: new Map(),
    departureTerminusStopIds: new Set()
  }
}

/** A GtfsData whose static schedule marks `tripId`'s last stop_sequence as `stopId` (i.e. `stopId` is the terminus for that trip). */
function gtfsWithTerminalTrip(tripId: string, stopId: string): GtfsData {
  const gtfs = emptyGtfs()
  gtfs.trips.set(tripId, { tripId, routeId: 'bUCR', serviceId: 'entresemana', headsign: 'Educación', isMilla: false })
  gtfs.stopTimesByStop.set(stopId, [
    { tripId, stopId, stopSequence: 9, arrivalSeconds: 0, departureSeconds: 0, isBoardable: false }
  ])
  gtfs.terminalStopIdByTrip.set(tripId, stopId)
  return gtfs
}

/** A GtfsData whose static schedule marks `tripId` as boarding normally (not terminal) at `stopId`. */
function gtfsWithMidRouteTrip(tripId: string, stopId: string): GtfsData {
  const gtfs = emptyGtfs()
  gtfs.trips.set(tripId, { tripId, routeId: 'bUCR', serviceId: 'entresemana', headsign: 'Odontología', isMilla: false })
  gtfs.stopTimesByStop.set(stopId, [
    { tripId, stopId, stopSequence: 3, arrivalSeconds: 0, departureSeconds: 0, isBoardable: true }
  ])
  // Terminus is a different, later stop — stopId is genuinely mid-route.
  gtfs.terminalStopIdByTrip.set(tripId, 'bUCR_9_99')
  return gtfs
}

/**
 * A GtfsData whose static schedule marks `tripId`'s stop_time at `stopId` as
 * non-boardable due to `pickup_type=1` (a mid-route no-pickup stop) — NOT
 * because it's the trip's terminal stop. Regression fixture for FIX 1: a
 * naive "non-boardable ⇒ terminus" signal would misclassify this as an
 * inbound feeder even though the real terminus is elsewhere.
 */
function gtfsWithNoPickupMidRouteTrip(tripId: string, stopId: string): GtfsData {
  const gtfs = emptyGtfs()
  gtfs.trips.set(tripId, { tripId, routeId: 'bUCR', serviceId: 'entresemana', headsign: 'Odontología', isMilla: false })
  gtfs.stopTimesByStop.set(stopId, [
    { tripId, stopId, stopSequence: 3, arrivalSeconds: 0, departureSeconds: 0, isBoardable: false }
  ])
  // The trip's real terminus is a different, later stop.
  gtfs.terminalStopIdByTrip.set(tripId, 'bUCR_9_99')
  return gtfs
}

function feedWithEntity(
  stopTimeUpdate: DatabusTripUpdateFeed['entity'][number]['trip_update']['stop_time_update'],
  tripId = 't1',
  vehicleId = 'v1'
): DatabusTripUpdateFeed {
  return {
    header: { timestamp: NOW },
    entity: [
      {
        id: vehicleId,
        trip_update: {
          trip: { trip_id: tripId, route_id: 'bUCR', direction_id: 1 },
          stop_time_update: stopTimeUpdate
        }
      }
    ]
  }
}

describe('extractInboundArrivals', () => {
  it('primary fixture: a live inbound run ending at bUCR_0_01 yields exactly one InboundArrival with the real arrival.time', () => {
    const feed = loadFixture('trip_updates.inbound.sample.json')
    const result = extractInboundArrivals(feed, emptyGtfs(), STOP_ID, feed.header?.timestamp ?? NOW)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      vehicleId: '299-921',
      tripId: 'desde_odontologia_a_educacion_entresemana_11:25',
      predictedArrival: 1787593332,
      uncertaintySeconds: 120
    })
  })

  it('counter-case fixture: an outbound run departing the terminus yields zero inbound arrivals', () => {
    const feed = loadFixture('trip_updates.sample.json')
    const result = extractInboundArrivals(feed, emptyGtfs(), STOP_ID, NOW)
    expect(result).toEqual([])
  })

  it('matches the terminal stop by stop_id, not array position (known trip)', () => {
    const feed = feedWithEntity([
      { stop_sequence: 9, stop_id: STOP_ID, arrival: { time: NOW + 400 } },
      { stop_sequence: 5, stop_id: 'bUCR_1_05', arrival: { time: NOW + 100 } }
    ], 't1')
    const result = extractInboundArrivals(feed, gtfsWithTerminalTrip('t1', STOP_ID), STOP_ID, NOW)
    expect(result).toHaveLength(1)
    expect(result[0].predictedArrival).toBe(NOW + 400)
  })

  it('excludes a known trip whose stop_time_update at stopId is not its terminal stop', () => {
    const feed = feedWithEntity([{ stop_sequence: 3, stop_id: STOP_ID, arrival: { time: NOW + 100 } }], 't1')
    const result = extractInboundArrivals(feed, gtfsWithMidRouteTrip('t1', STOP_ID), STOP_ID, NOW)
    expect(result).toEqual([])
  })

  it('fails open for an unknown/ADDED trip that carries a stop_time_update at stopId which is the max stop_sequence in its own update array, even out of array order', () => {
    const feed = feedWithEntity([
      { stop_sequence: 9, stop_id: STOP_ID, arrival: { time: NOW + 500 } },
      { stop_sequence: 5, stop_id: 'bUCR_1_05', arrival: { time: NOW + 100 } }
    ], 'brand-new-trip', 'v9')
    const result = extractInboundArrivals(feed, emptyGtfs(), STOP_ID, NOW)
    expect(result).toEqual([{ vehicleId: 'v9', tripId: 'brand-new-trip', predictedArrival: NOW + 500, uncertaintySeconds: undefined }])
  })

  it('does not fail open for an unknown trip whose stopId update is not the max stop_sequence in its own array (mid-route, not terminal)', () => {
    const feed = feedWithEntity([
      { stop_sequence: 3, stop_id: STOP_ID, arrival: { time: NOW + 100 } },
      { stop_sequence: 9, stop_id: 'bUCR_1_09', arrival: { time: NOW + 500 } }
    ], 'brand-new-trip')
    const result = extractInboundArrivals(feed, emptyGtfs(), STOP_ID, NOW)
    expect(result).toEqual([])
  })

  it('excludes a known trip whose stop_time_update at stopId is non-boardable due to pickup_type=1 but is NOT the trip\'s terminal stop (mid-route no-pickup, not a terminus feeder — FIX 1 regression)', () => {
    const feed = feedWithEntity([{ stop_sequence: 3, stop_id: STOP_ID, arrival: { time: NOW + 100 } }], 't1')
    const result = extractInboundArrivals(feed, gtfsWithNoPickupMidRouteTrip('t1', STOP_ID), STOP_ID, NOW)
    expect(result).toEqual([])
  })

  it('skips an entity with no stop_time_update at the terminus this cycle', () => {
    const feed = feedWithEntity([{ stop_sequence: 3, stop_id: 'bUCR_1_03', arrival: { time: NOW + 100 } }], 't1')
    const result = extractInboundArrivals(feed, gtfsWithTerminalTrip('t1', STOP_ID), STOP_ID, NOW)
    expect(result).toEqual([])
  })

  it('falls back to departure.time when arrival is absent', () => {
    const feed = feedWithEntity([{ stop_sequence: 9, stop_id: STOP_ID, departure: { time: NOW + 200, uncertainty: 60 } }], 't1')
    const result = extractInboundArrivals(feed, gtfsWithTerminalTrip('t1', STOP_ID), STOP_ID, NOW)
    expect(result).toEqual([{ vehicleId: 'v1', tripId: 't1', predictedArrival: NOW + 200, uncertaintySeconds: undefined }])
  })

  it('is pure and never throws on a malformed/empty feed', () => {
    expect(() => extractInboundArrivals({}, emptyGtfs(), STOP_ID, NOW)).not.toThrow()
    expect(extractInboundArrivals({}, emptyGtfs(), STOP_ID, NOW)).toEqual([])
  })
})
