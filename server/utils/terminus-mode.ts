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

/** Default lookback window: 20 minutes, enough to cover observed irregular layovers (~18 min). */
const DEFAULT_LOOKBACK_SECONDS = 1200

/**
 * Pure: given an already-fetched trip_updates feed, produce the terminus
 * board — scheduled outbound slots from `nextDepartures`, each either left
 * as-is (no matched feeder: today's plain-schedule look) or annotated with
 * `estimated: true` / `scheduledEta` / a pushed-out `eta` when a matched
 * inbound feeder exists (§6).
 *
 * The lookback window allows recently-passed slots to appear when a late
 * feeder is still boarding (predicted + buffer > now). Passed slots with
 * no live feeder are dropped, preserving today's "departed on time" behavior.
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
  params: TerminusParams,
  lookbackSeconds = DEFAULT_LOOKBACK_SECONDS
): Arrival[] {
  try {
    // Fetch slots with a lookback window so recently-passed outbound slots are included.
    // Request extra slots because passed ones will be filtered out again below.
    const extra = 6
    const scheduled = nextDepartures(gtfs, stopId, timeZone, nowEpochSeconds - lookbackSeconds, limit + extra)
    if (scheduled.length === 0) return []

    const slots: ScheduledSlot[] = scheduled.map(a => ({ tripId: a.tripId, scheduledEpoch: a.eta }))
    const inbound = extractInboundArrivals(feed, gtfs, stopId, nowEpochSeconds)
    const matches = matchArrivalsToSlots(slots, inbound, params)

    // Post-process each slot: future slots stay, passed slots only if matched and not yet departed.
    const results: Arrival[] = []
    for (const a of scheduled) {
      const match = matches.get(a.tripId)

      if (!match) {
        // No matched feeder: future slots stay as plain schedule; passed slots are dropped.
        if (a.eta >= nowEpochSeconds) {
          results.push(a)
        }
        continue
      }

      // Matched: compute estimated departure.
      const estimatedDeparture = match.estimatedDeparture

      // If the bus already left (estimated <= now), drop the passed slot.
      if (estimatedDeparture <= nowEpochSeconds && a.eta < nowEpochSeconds) {
        continue
      }

      // Bus is still boarding or future: show the estimated time.
      results.push({
        ...a,
        eta: estimatedDeparture,
        etaMinutes: Math.max(0, Math.floor((estimatedDeparture - nowEpochSeconds) / 60)),
        estimated: true,
        scheduledEta: match.scheduledEpoch,
        uncertaintySeconds: match.uncertaintySeconds
      })
    }

    // Sort by eta ascending and take the first `limit`.
    results.sort((x, y) => x.eta - y.eta)
    return results.slice(0, limit)
  } catch (err) {
    console.warn('[terminus] prediction pipeline failed, degrading:', err)
    return []
  }
}
