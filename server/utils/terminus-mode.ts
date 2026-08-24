/**
 * WS-C — wires WS-A's inbound-arrival extraction and WS-B's slot matcher
 * into a single pure "terminus arrivals" pipeline: scheduled outbound slots
 * (nextDepartures) annotated with a matched inbound feeder's estimated
 * departure, when one exists (see design/realtime-terminus-prediction.md
 * §3/§6/§8 WS-C).
 *
 * Deliberately never throws: any failure inside the pipeline degrades to an
 * empty array so the caller (server/api/arrivals.get.ts) falls through to
 * its existing real/schedule fallback chain instead of a 500.
 */

import type { Arrival } from '../../shared/types'
import type { GtfsData } from './gtfs'
import { extractInboundArrivals, type DatabusTripUpdateFeed } from './realtime-mode'
import { nextDepartures } from './schedule-mode'
import { matchArrivalsToSlots, type ScheduledSlot, type TerminusParams } from './terminus-prediction'

/**
 * Pure: given an already-fetched trip_updates feed, produce the terminus
 * board — scheduled outbound slots from `nextDepartures`, each either left
 * as-is (no matched feeder: today's plain-schedule look) or annotated with
 * `estimated: true` / `scheduledEta` / a pushed-out `eta` when a matched
 * inbound feeder exists (§6).
 *
 * Returns `[]` (never throws) on any internal failure, or when there are no
 * scheduled slots to annotate — the caller treats that the same as "nothing
 * to show from this path" and falls through to its own fallback chain.
 */
export function deriveTerminusArrivals(
  feed: DatabusTripUpdateFeed,
  gtfs: GtfsData,
  stopId: string,
  timeZone: string,
  nowEpochSeconds: number,
  limit: number,
  params: TerminusParams
): Arrival[] {
  try {
    const scheduled = nextDepartures(gtfs, stopId, timeZone, nowEpochSeconds, limit)
    if (scheduled.length === 0) return []

    const slots: ScheduledSlot[] = scheduled.map(a => ({ tripId: a.tripId, scheduledEpoch: a.eta }))
    const inbound = extractInboundArrivals(feed, gtfs, stopId, nowEpochSeconds)
    const matches = matchArrivalsToSlots(slots, inbound, params)

    return scheduled.map((a): Arrival => {
      const match = matches.get(a.tripId)
      if (!match) return a // no qualifying feeder: keep the plain scheduled slot, unchanged.

      return {
        ...a,
        eta: match.estimatedDeparture,
        etaMinutes: Math.max(0, Math.floor((match.estimatedDeparture - nowEpochSeconds) / 60)),
        estimated: true,
        scheduledEta: match.scheduledEpoch,
        uncertaintySeconds: match.uncertaintySeconds
      }
    })
  } catch (err) {
    console.warn('[terminus] prediction pipeline failed, degrading:', err)
    return []
  }
}
