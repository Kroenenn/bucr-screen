/**
 * "real" mode: poll Databus's GTFS-RT `trip_updates.json` feed over plain
 * HTTP (Databus exposes no WebSocket for it) and derive arrivals for one stop.
 *
 * Deliberately never throws: any failure (network, timeout, stale feed, or
 * simply no matching stop_time_update entries) resolves to
 * `{ healthy: false }` so the caller (server/api/arrivals.get.ts) can fall
 * back to the GTFS schedule without special-casing errors.
 */

import type { Arrival } from '../../shared/types'
import type { GtfsData } from './gtfs'

export interface DatabusTripUpdateFeed {
  header?: { timestamp?: number }
  entity?: Array<{
    id: string
    trip_update?: {
      timestamp?: number
      trip: { trip_id: string, route_id: string, direction_id?: number }
      stop_time_update?: Array<{
        stop_sequence?: number
        stop_id: string
        arrival?: { time?: number, uncertainty?: number }
        departure?: { time?: number, uncertainty?: number }
      }>
    }
  }>
}

export interface RealtimeResult {
  healthy: boolean
  arrivals: Arrival[]
}

/** Arrivals that departed within this window are still shown (avoids the row vanishing mid-poll-cycle right at 0 minutes). */
const DEPARTURE_GRACE_SECONDS = 30

/**
 * Pure: turns an already-fetched feed into a RealtimeResult. No network, no
 * runtime config — this is the part worth unit testing directly.
 */
export function deriveArrivalsFromFeed(
  feed: DatabusTripUpdateFeed,
  gtfs: GtfsData,
  stopId: string,
  nowEpochSeconds: number,
  limit: number,
  staleThresholdSeconds: number
): RealtimeResult {
  const feedAgeSeconds = nowEpochSeconds - (feed.header?.timestamp ?? 0)
  if (feedAgeSeconds > staleThresholdSeconds) {
    console.warn(`[realtime] feed is stale (${feedAgeSeconds}s old), treating as unhealthy`)
    return { healthy: false, arrivals: [] }
  }

  // Trips that, per the *static* schedule, aren't boarding opportunities at
  // this stop (last stop of the trip, or pickup_type forbids it — see
  // GtfsStopTime.isBoardable). A live trip_id absent from the static
  // schedule (e.g. an ADDED trip) is allowed through rather than guessed
  // at — failing open beats hiding real data.
  const nonBoardableTripIds = new Set(
    (gtfs.stopTimesByStop.get(stopId) ?? []).filter(st => !st.isBoardable).map(st => st.tripId)
  )

  const candidates: Arrival[] = []
  for (const entity of feed.entity ?? []) {
    const tu = entity.trip_update
    if (!tu) continue
    if (nonBoardableTripIds.has(tu.trip.trip_id)) continue

    for (const stu of tu.stop_time_update ?? []) {
      if (stu.stop_id !== stopId) continue

      const etaEpoch = stu.arrival?.time ?? stu.departure?.time
      if (etaEpoch == null) continue

      const trip = gtfs.trips.get(tu.trip.trip_id)
      candidates.push({
        tripId: tu.trip.trip_id,
        routeId: tu.trip.route_id,
        headsign: trip?.headsign || tu.trip.route_id,
        eta: etaEpoch,
        etaMinutes: Math.max(0, Math.floor((etaEpoch - nowEpochSeconds) / 60)),
        // Static lookup wins when available; fall back to bUCR's own
        // trip_id convention (same one gtfs.ts uses) rather than assuming
        // "not milla" for a trip the static schedule doesn't know about.
        viaMilla: trip?.isMilla ?? tu.trip.trip_id.includes('con_milla'),
        uncertaintySeconds: stu.arrival?.uncertainty ?? stu.departure?.uncertainty
      })
    }
  }

  candidates.sort((a, b) => a.eta - b.eta)
  const upcoming = candidates.filter(c => c.eta >= nowEpochSeconds - DEPARTURE_GRACE_SECONDS)

  // No matching entries is treated as unhealthy (not "no service today") so
  // the caller falls back to the schedule, which can always show the next
  // scheduled trip even outside the window Databus currently has runs for.
  if (upcoming.length === 0) return { healthy: false, arrivals: [] }

  return { healthy: true, arrivals: upcoming.slice(0, limit) }
}

export interface InboundArrival {
  /** entity.id — the run's vehicle id. */
  vehicleId: string
  tripId: string
  /** Unix seconds — arrival.time at the terminus (falls back to departure.time). */
  predictedArrival: number
  /** arrival.uncertainty, when present. */
  uncertaintySeconds?: number
}

/**
 * Pure: picks out inbound-feeder predictions for a departure terminus (see
 * design/realtime-terminus-prediction.md §5) — entities whose trip_update
 * carries a stop_time_update at `stopId` that is that trip's *terminal*
 * stop, not just any stop it happens to pass. Never throws.
 *
 * Terminal-stop determination:
 *  - known trip (present in the static schedule): look up
 *    `gtfs.terminalStopIdByTrip.get(tripId)` (the trip's max-stop_sequence
 *    stop, computed once in gtfs.ts) and compare to `stopId`. This is the
 *    correct terminus definition. It is deliberately NOT the same
 *    `!isBoardable` signal `deriveArrivalsFromFeed` uses for
 *    "non-boardable" filtering: `isBoardable` is also false for a mid-route
 *    stop_time with `pickup_type=1`, which is not a terminus — reusing that
 *    signal here would misclassify a mid-route no-pickup stop as an inbound
 *    feeder's terminus. (`isInboundFeeder` in terminus-prediction.ts does
 *    the same `terminalStopIdByTrip` lookup; it isn't imported here to
 *    avoid a module cycle — terminus-prediction.ts already imports
 *    `InboundArrival` from this file.)
 *  - unknown/ADDED trip (fail open per §5): the static schedule has no
 *    opinion, so terminal-ness is judged from the entity's own
 *    stop_time_update array — `stopId`'s entry counts as terminal iff its
 *    stop_sequence is the max stop_sequence present in that same array.
 *    Matched by stop_sequence value, never array position (stop_sequence is
 *    non-contiguous on this feed).
 */
export function extractInboundArrivals(
  feed: DatabusTripUpdateFeed,
  gtfs: GtfsData,
  stopId: string,
  _nowEpochSeconds: number
): InboundArrival[] {
  const arrivals: InboundArrival[] = []
  for (const entity of feed.entity ?? []) {
    const tu = entity.trip_update
    if (!tu) continue

    const stopTimeUpdates = tu.stop_time_update ?? []
    const terminusUpdate = stopTimeUpdates.find(stu => stu.stop_id === stopId)
    if (!terminusUpdate) continue

    if (gtfs.trips.has(tu.trip.trip_id)) {
      // stopId is this trip's terminus iff it's the trip's max-stop_sequence
      // stop — NOT merely a non-boardable one (pickup_type=1 mid-route stops
      // are also non-boardable but aren't termini). See the doc comment above.
      if (gtfs.terminalStopIdByTrip.get(tu.trip.trip_id) !== stopId) continue
    } else {
      // Fail open: judge terminal-ness from this entity's own update array.
      const maxSequenceInEntity = Math.max(
        ...stopTimeUpdates.map(stu => stu.stop_sequence ?? Number.NEGATIVE_INFINITY)
      )
      if ((terminusUpdate.stop_sequence ?? Number.NEGATIVE_INFINITY) !== maxSequenceInEntity) continue
    }

    const etaEpoch = terminusUpdate.arrival?.time ?? terminusUpdate.departure?.time
    if (etaEpoch == null) continue

    arrivals.push({
      vehicleId: entity.id,
      tripId: tu.trip.trip_id,
      predictedArrival: etaEpoch,
      uncertaintySeconds: terminusUpdate.arrival?.uncertainty
    })
  }

  return arrivals
}

export interface FetchRealtimeOptions {
  databusBaseUrl: string
  fetchTimeoutMs: number
  staleThresholdSeconds: number
}

/**
 * Fetches and parses `trip_updates.json` over plain HTTP. Never throws:
 * network failure, timeout, non-2xx response, or unparseable JSON all
 * resolve to `null`, letting callers fall back without special-casing
 * errors — same never-throw posture as the rest of this module.
 *
 * Split out from `fetchRealtimeArrivals` so a caller that needs the raw
 * feed for more than one purpose (e.g. server/api/arrivals.get.ts's
 * terminus-prediction path, which both health-checks the feed and passes
 * it to `extractInboundArrivals`) can fetch it exactly once per request
 * instead of duplicating the network call.
 */
export async function fetchTripUpdateFeed(options: FetchRealtimeOptions): Promise<DatabusTripUpdateFeed | null> {
  const url = `${options.databusBaseUrl.replace(/\/$/, '')}/feed/realtime/trip_updates.json`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.fetchTimeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error(`trip_updates fetch failed: ${response.status} ${response.statusText}`)
      return (await response.json()) as DatabusTripUpdateFeed
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    console.warn('[realtime] feed fetch failed:', err)
    return null
  }
}

/**
 * Freshness-only health check on an already-fetched feed (no stop-specific
 * matching) — for a caller like the terminus-prediction path that doesn't
 * need `deriveArrivalsFromFeed`'s "has entries at this exact stop" notion of
 * health, since it reads inbound-feeder predictions at the terminus instead
 * of direct stop_time_update matches. Same staleness rule as
 * `deriveArrivalsFromFeed`. Never throws.
 */
export function isFeedFresh(feed: DatabusTripUpdateFeed, nowEpochSeconds: number, staleThresholdSeconds: number): boolean {
  const feedAgeSeconds = nowEpochSeconds - (feed.header?.timestamp ?? 0)
  return feedAgeSeconds <= staleThresholdSeconds
}

export async function fetchRealtimeArrivals(
  gtfs: GtfsData,
  stopId: string,
  nowEpochSeconds: number,
  limit: number,
  options: FetchRealtimeOptions
): Promise<RealtimeResult> {
  const feed = await fetchTripUpdateFeed(options)
  if (!feed) return { healthy: false, arrivals: [] }

  return deriveArrivalsFromFeed(feed, gtfs, stopId, nowEpochSeconds, limit, options.staleThresholdSeconds)
}
