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

export interface FetchRealtimeOptions {
  databusBaseUrl: string
  fetchTimeoutMs: number
  staleThresholdSeconds: number
}

export async function fetchRealtimeArrivals(
  gtfs: GtfsData,
  stopId: string,
  nowEpochSeconds: number,
  limit: number,
  options: FetchRealtimeOptions
): Promise<RealtimeResult> {
  const url = `${options.databusBaseUrl.replace(/\/$/, '')}/feed/realtime/trip_updates.json`

  let feed: DatabusTripUpdateFeed
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.fetchTimeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error(`trip_updates fetch failed: ${response.status} ${response.statusText}`)
      feed = (await response.json()) as DatabusTripUpdateFeed
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    console.warn('[realtime] feed fetch failed:', err)
    return { healthy: false, arrivals: [] }
  }

  return deriveArrivalsFromFeed(feed, gtfs, stopId, nowEpochSeconds, limit, options.staleThresholdSeconds)
}
