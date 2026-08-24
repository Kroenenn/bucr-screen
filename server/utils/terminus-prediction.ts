/**
 * Terminus prediction/matching core — the heart of the real-time
 * terminus-departure feature (see design/realtime-terminus-prediction.md
 * §4-§8, workstream WS-B).
 *
 * Pure module: no I/O, no runtime config, never throws. Consumes an
 * inbound-arrival prediction (WS-A's `InboundArrival`, read straight from
 * Databus's `trip_updates.json`) and pairs it against the static schedule's
 * upcoming outbound departure slots from a terminus stop, producing an
 * estimated departure that is never earlier than the timetable
 * (`estimated_departure = max(scheduled, predicted_arrival + BOARDING_BUFFER)`).
 */

import type { GtfsData } from './gtfs'
import type { InboundArrival } from './realtime-mode'

/**
 * True iff `tripId`'s terminal stop (its max stop_sequence stop_time — see
 * `GtfsData.terminalStopIdByTrip`) is `stopId`. Generic: correct for any
 * terminus, not just Educación. Returns false (never throws) for a trip id
 * the static schedule doesn't know about.
 */
export function isInboundFeeder(gtfs: GtfsData, tripId: string, stopId: string): boolean {
  return gtfs.terminalStopIdByTrip.get(tripId) === stopId
}

/**
 * True iff `tripId`'s first *boardable* stop_time (min stop_sequence among
 * boardable stops — see `GtfsData.firstBoardableStopIdByTrip`) is at
 * `stopId`. Returns false (never throws) for an unknown trip id.
 */
export function isOutboundFrom(gtfs: GtfsData, tripId: string, stopId: string): boolean {
  return gtfs.firstBoardableStopIdByTrip.get(tripId) === stopId
}

/**
 * True iff `stopId` is a **departure terminus**: some trip both starts
 * there (first boardable stop) *and* some trip ends there (terminal stop) —
 * the two-way-terminus auto-detection heuristic from
 * design/realtime-terminus-prediction.md §8 WS-C. Used to gate the terminus
 * prediction feature so it only ever activates for a stop shaped like
 * Educación (bUCR_0_01), never for an ordinary mid-route or arrival-only
 * stop. Never throws.
 *
 * `GtfsData.departureTerminusStopIds` is precomputed once per GTFS parse
 * (gtfs.ts), since this is otherwise a linear scan of both trip maps and
 * this function is called on every /api/arrivals request.
 */
export function isDepartureTerminus(gtfs: GtfsData, stopId: string): boolean {
  return gtfs.departureTerminusStopIds.has(stopId)
}

export interface TerminusParams {
  /** Fixed buffer added to a matched predicted arrival before it can count as the departure time. Default 60s. */
  boardingBufferS: number
  /** Upper bound on how much later than a slot's scheduledEpoch a candidate arrival's predictedArrival may be and still match that slot. Default 1200s (20min). */
  maxLayoverS: number
  /** Upper bound on how much earlier than a slot's scheduledEpoch a candidate arrival's predictedArrival may be and still match that slot (an arrival much earlier than a slot more likely feeds an earlier one). Default 300s (5min). */
  maxEarlyS: number
}

/** The stock v1 parameters from design/realtime-terminus-prediction.md §3/§6. */
export const DEFAULT_TERMINUS_PARAMS: TerminusParams = {
  boardingBufferS: 60,
  maxLayoverS: 1200,
  maxEarlyS: 300
}

export interface ScheduledSlot {
  tripId: string
  scheduledEpoch: number
}

export interface EstimatedDeparture {
  slotTripId: string
  scheduledEpoch: number
  /** max(scheduledEpoch, predictedArrival + boardingBufferS) — never earlier than the timetable. */
  estimatedDeparture: number
  vehicleId?: string
  uncertaintySeconds?: number
}

/**
 * Schedule-adjacency greedy match (§6): walks scheduled outbound departure
 * slots in ascending time order and, for each, claims the earliest
 * still-unclaimed inbound arrival whose predicted terminus arrival falls
 * within [scheduledEpoch - maxEarlyS, scheduledEpoch + maxLayoverS]. A slot
 * with no qualifying arrival gets no map entry — the caller keeps showing
 * the plain scheduled time for it (pull-outs with no feeder, first run of
 * the day, etc). An arrival that never qualifies for any slot is ignored.
 *
 * Pure and never throws: bad/empty input just yields an empty map.
 */
export function matchArrivalsToSlots(
  scheduledSlots: ScheduledSlot[],
  inboundArrivals: InboundArrival[],
  params: TerminusParams
): Map<string, EstimatedDeparture> {
  const result = new Map<string, EstimatedDeparture>()

  const sortedSlots = [...scheduledSlots].sort((a, b) => a.scheduledEpoch - b.scheduledEpoch)
  const sortedArrivals = [...inboundArrivals].sort((a, b) => a.predictedArrival - b.predictedArrival)
  const claimed = new Array<boolean>(sortedArrivals.length).fill(false)

  for (const slot of sortedSlots) {
    let matchIndex = -1
    for (let i = 0; i < sortedArrivals.length; i++) {
      if (claimed[i]) continue
      const candidate = sortedArrivals[i]
      if (!candidate) continue
      if (candidate.predictedArrival > slot.scheduledEpoch + params.maxLayoverS) continue
      if (candidate.predictedArrival < slot.scheduledEpoch - params.maxEarlyS) continue
      // sortedArrivals is ascending, so the first unclaimed qualifier here is the earliest one.
      matchIndex = i
      break
    }

    if (matchIndex === -1) continue

    const matched = sortedArrivals[matchIndex]
    if (!matched) continue
    claimed[matchIndex] = true
    result.set(slot.tripId, {
      slotTripId: slot.tripId,
      scheduledEpoch: slot.scheduledEpoch,
      estimatedDeparture: Math.max(slot.scheduledEpoch, matched.predictedArrival + params.boardingBufferS),
      vehicleId: matched.vehicleId,
      uncertaintySeconds: matched.uncertaintySeconds
    })
  }

  return result
}
