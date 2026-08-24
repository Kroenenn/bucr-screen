import { describe, expect, it } from 'vitest'
import type { GtfsData, GtfsStopTime } from '../server/utils/gtfs'
import type { InboundArrival } from '../server/utils/realtime-mode'
import {
  isDepartureTerminus,
  isInboundFeeder,
  isOutboundFrom,
  matchArrivalsToSlots,
  type TerminusParams
} from '../server/utils/terminus-prediction'

const STOP_ID = 'bUCR_0_01' // Educación, the departure terminus.
const NOW = 1_800_000_000

const DEFAULT_PARAMS: TerminusParams = { boardingBufferS: 60, maxLayoverS: 1200, maxEarlyS: 300 }

/**
 * Builds a GtfsData whose terminalStopIdByTrip / firstBoardableStopIdByTrip
 * are computed the same way gtfs.ts's parser computes them: from a per-trip
 * list of (stopSequence, stopId, isBoardable) rows, taking the max-sequence
 * row as terminal and the min-sequence *boardable* row as first-boardable.
 * Deliberately mirrors parseZipBuffer's real algorithm rather than hand-
 * picking the answer, and deliberately uses non-contiguous stop_sequence
 * numbers and out-of-order row insertion so a classifier bug that reads
 * array position instead of stop_id/stop_sequence would fail these tests.
 */
function buildRealisticGtfs(tripRows: Record<string, Array<{ stopSequence: number, stopId: string, isBoardable: boolean }>>): GtfsData {
  const terminalStopIdByTrip = new Map<string, string>()
  const firstBoardableStopIdByTrip = new Map<string, string>()
  const stopTimesByStop = new Map<string, GtfsStopTime[]>()

  for (const [tripId, rows] of Object.entries(tripRows)) {
    const maxSeq = Math.max(...rows.map(r => r.stopSequence))
    const terminalRow = rows.find(r => r.stopSequence === maxSeq)!
    terminalStopIdByTrip.set(tripId, terminalRow.stopId)

    const boardableRows = rows.filter(r => r.isBoardable)
    if (boardableRows.length > 0) {
      const minBoardableSeq = Math.min(...boardableRows.map(r => r.stopSequence))
      const firstBoardableRow = boardableRows.find(r => r.stopSequence === minBoardableSeq)!
      firstBoardableStopIdByTrip.set(tripId, firstBoardableRow.stopId)
    }

    for (const row of rows) {
      const st: GtfsStopTime = {
        tripId,
        stopId: row.stopId,
        stopSequence: row.stopSequence,
        arrivalSeconds: 0,
        departureSeconds: 0,
        isBoardable: row.isBoardable
      }
      const list = stopTimesByStop.get(row.stopId)
      if (list) list.push(st)
      else stopTimesByStop.set(row.stopId, [st])
    }
  }

  // Mirrors gtfs.ts's own precompute (FIX 3): a departure terminus is a
  // stop_id that is both some trip's terminal AND some trip's first-boardable.
  const outboundDepartureStopIds = new Set(firstBoardableStopIdByTrip.values())
  const departureTerminusStopIds = new Set(
    [...new Set(terminalStopIdByTrip.values())].filter(stopId => outboundDepartureStopIds.has(stopId))
  )

  return {
    agency: null,
    routes: new Map(),
    feedInfo: null,
    stops: new Map(),
    trips: new Map(),
    stopTimesByStop,
    calendars: [],
    calendarExceptions: [],
    loadedAt: Date.now(),
    terminalStopIdByTrip,
    firstBoardableStopIdByTrip,
    departureTerminusStopIds
  }
}

function arrival(vehicleId: string, tripId: string, predictedArrival: number, uncertaintySeconds?: number): InboundArrival {
  return { vehicleId, tripId, predictedArrival, uncertaintySeconds }
}

describe('isInboundFeeder / isOutboundFrom', () => {
  // Case (e): terminus matched by stop_id, not array index. Stops are
  // inserted out of stop_sequence order, and stop_sequence itself is
  // non-contiguous (bUCR's real feed skips numbers) — a bug that assumed
  // "last array element" or "sequence increments by 1" would break this.
  const gtfs = buildRealisticGtfs({
    // Inbound feeder: Odontología -> Educación, terminal stop is bUCR_0_01
    // at stop_sequence 9 (not the last-inserted row below, and not seq+1
    // from its neighbor).
    inbound1: [
      { stopSequence: 3, stopId: 'bUCR_0_06', isBoardable: true },
      { stopSequence: 9, stopId: STOP_ID, isBoardable: false }, // terminal
      { stopSequence: 1, stopId: 'bUCR_0_05', isBoardable: true }
    ],
    // Outbound: Educación -> Odontología, first boardable stop is bUCR_0_01
    // at stop_sequence 1.
    outbound1: [
      { stopSequence: 5, stopId: 'bUCR_0_11', isBoardable: false }, // trip's terminal, unrelated stop
      { stopSequence: 1, stopId: STOP_ID, isBoardable: true }, // first boardable
      { stopSequence: 3, stopId: 'bUCR_0_06', isBoardable: true }
    ],
    // A trip that merely passes through the terminus mid-route (boardable,
    // not first, not last) — neither classifier should claim it.
    passThrough1: [
      { stopSequence: 1, stopId: 'bUCR_0_02', isBoardable: true },
      { stopSequence: 4, stopId: STOP_ID, isBoardable: true },
      { stopSequence: 8, stopId: 'bUCR_0_09', isBoardable: false }
    ]
  })

  it('identifies an inbound feeder by its terminal stop_id', () => {
    expect(isInboundFeeder(gtfs, 'inbound1', STOP_ID)).toBe(true)
  })

  it('does not misidentify a stop that merely has a high stop_sequence but is not terminal', () => {
    expect(isInboundFeeder(gtfs, 'inbound1', 'bUCR_0_06')).toBe(false)
  })

  it('identifies outbound-from-terminus by its first boardable stop_id', () => {
    expect(isOutboundFrom(gtfs, 'outbound1', STOP_ID)).toBe(true)
  })

  it('does not misidentify a trip whose terminal (non-boardable) stop happens to be elsewhere', () => {
    expect(isOutboundFrom(gtfs, 'outbound1', 'bUCR_0_11')).toBe(false)
  })

  it('is neither inbound feeder nor outbound-from for a stop the trip only passes through', () => {
    expect(isInboundFeeder(gtfs, 'passThrough1', STOP_ID)).toBe(false)
    expect(isOutboundFrom(gtfs, 'passThrough1', STOP_ID)).toBe(false)
  })

  it('returns false for an unknown trip id rather than throwing', () => {
    expect(isInboundFeeder(gtfs, 'nonexistent', STOP_ID)).toBe(false)
    expect(isOutboundFrom(gtfs, 'nonexistent', STOP_ID)).toBe(false)
  })

  it('isDepartureTerminus: true for a stop that is both some trip\'s terminal and some trip\'s first-boardable stop (Educación-shaped)', () => {
    expect(isDepartureTerminus(gtfs, STOP_ID)).toBe(true)
  })

  it('isDepartureTerminus: false for a stop that is only ever a terminal (arrival-only terminus, no outbound trips start there)', () => {
    const arrivalOnlyGtfs = buildRealisticGtfs({
      inboundOnly: [
        { stopSequence: 1, stopId: 'bUCR_9_01', isBoardable: true },
        { stopSequence: 5, stopId: 'bUCR_9_99', isBoardable: false } // terminal, nothing departs from here
      ]
    })
    expect(isDepartureTerminus(arrivalOnlyGtfs, 'bUCR_9_99')).toBe(false)
  })

  it('isDepartureTerminus: false for a stop that is only ever a first-boardable stop (no inbound feeder ends there)', () => {
    const departureOnlyGtfs = buildRealisticGtfs({
      outboundOnly: [
        { stopSequence: 1, stopId: 'bUCR_9_01', isBoardable: true }, // first boardable, nothing terminates here
        { stopSequence: 5, stopId: 'bUCR_9_99', isBoardable: false }
      ]
    })
    expect(isDepartureTerminus(departureOnlyGtfs, 'bUCR_9_01')).toBe(false)
  })

  it('isDepartureTerminus: false for an ordinary mid-route stop', () => {
    expect(isDepartureTerminus(gtfs, 'bUCR_0_06')).toBe(false)
  })
})

describe('matchArrivalsToSlots', () => {
  it('(a) on-time bus: predicted arrival + buffer <= scheduled -> scheduled time wins', () => {
    const slots = [{ tripId: 'out-0800', scheduledEpoch: NOW }]
    const arrivals = [arrival('v1', 'in-0757', NOW - 180, 120)] // 3 min early, real turnaround pattern
    const result = matchArrivalsToSlots(slots, arrivals, DEFAULT_PARAMS)

    expect(result.get('out-0800')).toEqual({
      slotTripId: 'out-0800',
      scheduledEpoch: NOW,
      estimatedDeparture: NOW, // max(NOW, NOW-180+60) = NOW
      vehicleId: 'v1',
      uncertaintySeconds: 120
    })
  })

  it('(b) late bus: predicted arrival + buffer > scheduled -> departure pushed out', () => {
    const slots = [{ tripId: 'out-0800', scheduledEpoch: NOW }]
    const arrivals = [arrival('v1', 'in-0757', NOW + 300)] // 5 min late
    const result = matchArrivalsToSlots(slots, arrivals, DEFAULT_PARAMS)

    const matched = result.get('out-0800')
    expect(matched).toBeDefined()
    expect(matched!.estimatedDeparture).toBe(NOW + 300 + 60) // max(NOW, NOW+360) = NOW+360
    expect(matched!.estimatedDeparture).toBeGreaterThan(matched!.scheduledEpoch)
  })

  it('(c) no-feeder slot: no arrival within the match window -> no map entry, schedule kept by caller', () => {
    const slots = [{ tripId: 'out-0620', scheduledEpoch: NOW }] // e.g. first pull-out of the day
    const result = matchArrivalsToSlots(slots, [], DEFAULT_PARAMS)
    expect(result.has('out-0620')).toBe(false)
    expect(result.size).toBe(0)
  })

  it('(c) no-feeder slot: an arrival exists but falls outside both windows -> still no entry', () => {
    const slots = [{ tripId: 'out-0800', scheduledEpoch: NOW }]
    // Arrives 30 minutes after scheduled — beyond maxLayoverS (1200s/20min).
    const arrivals = [arrival('v1', 'in-far', NOW + 1800)]
    const result = matchArrivalsToSlots(slots, arrivals, DEFAULT_PARAMS)
    expect(result.has('out-0800')).toBe(false)
  })

  it('(d) irregular ~18-minute layover still matches, within maxLayoverS', () => {
    // Mirrors the documented 08:35 dep <- 08:17 arr irregular-turnaround
    // shape: the feeder's predicted arrival lands 18 minutes off the slot's
    // scheduled time, comfortably inside the default 20-minute maxLayoverS
    // window but well outside a tight few-minute tolerance.
    const slots = [{ tripId: 'out-0835', scheduledEpoch: NOW }]
    const arrivals = [arrival('v1', 'in-0817', NOW + 18 * 60)] // 1080s < 1200s maxLayoverS
    const result = matchArrivalsToSlots(slots, arrivals, DEFAULT_PARAMS)

    expect(result.get('out-0835')).toBeDefined()
    expect(result.get('out-0835')!.vehicleId).toBe('v1')
  })

  it('an arrival exactly at the maxLayoverS boundary still matches (inclusive <=)', () => {
    const params: TerminusParams = { boardingBufferS: 60, maxLayoverS: 1200, maxEarlyS: 300 }
    const slots = [{ tripId: 's1', scheduledEpoch: NOW }]
    const arrivals = [arrival('v1', 't1', NOW + 1200)]
    const result = matchArrivalsToSlots(slots, arrivals, params)
    expect(result.has('s1')).toBe(true)
  })

  it('an arrival exactly at the maxEarlyS boundary still matches (inclusive >=)', () => {
    const params: TerminusParams = { boardingBufferS: 60, maxLayoverS: 1200, maxEarlyS: 300 }
    const slots = [{ tripId: 's1', scheduledEpoch: NOW }]
    const arrivals = [arrival('v1', 't1', NOW - 300)]
    const result = matchArrivalsToSlots(slots, arrivals, params)
    expect(result.has('s1')).toBe(true)
  })

  it('(f) post-midnight service day: epoch-based matching is unaffected by the local-day boundary', () => {
    // A late-night departure at 00:20 local time the *next* calendar day,
    // fed by a bus predicted to arrive at 00:17 — both expressed as raw
    // Unix epoch seconds (as agencyLocalDay/nextDepartures already resolve
    // them), crossing real midnight in UTC-6 (America/Costa_Rica).
    const midnightCrossingScheduled = Date.UTC(2026, 7, 25, 6, 20, 0) / 1000 // 2026-08-25 00:20 CR time
    const feederArrival = midnightCrossingScheduled - 180 // 00:17 CR time, 3 min early

    const slots = [{ tripId: 'out-0020', scheduledEpoch: midnightCrossingScheduled }]
    const arrivals = [arrival('v1', 'in-0017', feederArrival)]
    const result = matchArrivalsToSlots(slots, arrivals, DEFAULT_PARAMS)

    expect(result.get('out-0020')?.estimatedDeparture).toBe(midnightCrossingScheduled)
  })

  it('(g) unknown/ADDED trip inbound arrival still participates in matching by time proximity alone', () => {
    // The matcher has no opinion on whether a tripId exists in the static
    // schedule (extractInboundArrivals already fails an ADDED trip open) —
    // it only reasons about scheduledEpoch vs predictedArrival.
    const slots = [{ tripId: 'out-0800', scheduledEpoch: NOW }]
    const arrivals = [arrival('v9', 'brand-new-added-trip', NOW - 120)]
    const result = matchArrivalsToSlots(slots, arrivals, DEFAULT_PARAMS)

    expect(result.get('out-0800')).toMatchObject({ vehicleId: 'v9' })
  })

  it('greedily assigns the earliest unclaimed qualifying arrival to each slot in scheduled order, never double-claiming', () => {
    const slots = [
      { tripId: 'out-1', scheduledEpoch: NOW },
      { tripId: 'out-2', scheduledEpoch: NOW + 600 }
    ]
    const arrivals = [
      arrival('vA', 'in-A', NOW + 590), // could plausibly fit either slot's window
      arrival('vB', 'in-B', NOW - 60)
    ]
    const result = matchArrivalsToSlots(slots, arrivals, DEFAULT_PARAMS)

    // Slot 1 (processed first) claims the earliest qualifying arrival (vB);
    // slot 2 is left with the remaining one (vA), not double-booked.
    expect(result.get('out-1')?.vehicleId).toBe('vB')
    expect(result.get('out-2')?.vehicleId).toBe('vA')
  })

  it('an unmatched arrival (no qualifying slot) is silently ignored', () => {
    const slots = [{ tripId: 'out-1', scheduledEpoch: NOW }]
    const arrivals = [
      arrival('vA', 'in-A', NOW - 60), // matches out-1
      arrival('vB', 'in-B', NOW - 90) // would also match out-1, but out-1 is claimed by the earlier arrival
    ]
    const result = matchArrivalsToSlots(slots, arrivals, DEFAULT_PARAMS)

    expect(result.size).toBe(1)
    // Earliest unclaimed qualifying arrival wins: vB (NOW-90) sorts before vA (NOW-60).
    expect(result.get('out-1')?.vehicleId).toBe('vB')
  })

  it('handles an empty slots array without throwing', () => {
    expect(() => matchArrivalsToSlots([], [arrival('v1', 't1', NOW)], DEFAULT_PARAMS)).not.toThrow()
    expect(matchArrivalsToSlots([], [arrival('v1', 't1', NOW)], DEFAULT_PARAMS).size).toBe(0)
  })

  it('handles an empty arrivals array without throwing', () => {
    const slots = [{ tripId: 'out-1', scheduledEpoch: NOW }]
    expect(() => matchArrivalsToSlots(slots, [], DEFAULT_PARAMS)).not.toThrow()
    expect(matchArrivalsToSlots(slots, [], DEFAULT_PARAMS).size).toBe(0)
  })
})
