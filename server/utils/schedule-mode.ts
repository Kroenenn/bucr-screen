/**
 * "fake" mode: next departures computed purely from the static GTFS
 * Schedule, minus current time. Also used as the automatic fallback inside
 * "real" mode when the Databus feed is unreachable or stale.
 *
 * Pure function over a GtfsData snapshot + epoch seconds, deliberately
 * side-effect free — see tests/schedule-mode.test.ts for the tricky part
 * (service-day resolution, calendar_dates exceptions, post-midnight trips).
 */

import type { Arrival } from '../../shared/types'
import { activeServiceIds, type GtfsData } from './gtfs'
import { agencyLocalDay } from './time'

export function nextDepartures(
  gtfs: GtfsData,
  stopId: string,
  timeZone: string,
  nowEpochSeconds: number,
  limit: number
): Arrival[] {
  const today = agencyLocalDay(nowEpochSeconds, timeZone)
  const yesterday = agencyLocalDay(nowEpochSeconds - 86400, timeZone)

  const todayActive = activeServiceIds(gtfs, today.dateStr, today.weekday)
  const yesterdayActive = activeServiceIds(gtfs, yesterday.dateStr, yesterday.weekday)

  const stopTimes = gtfs.stopTimesByStop.get(stopId) ?? []

  const candidates: Array<{ epoch: number, tripId: string, routeId: string, headsign: string, viaMilla: boolean }> = []

  for (const st of stopTimes) {
    if (!st.isBoardable) continue // trip ends here, or pickup_type forbids it — see GtfsStopTime.isBoardable

    const trip = gtfs.trips.get(st.tripId)
    if (!trip) continue

    // Capped at < 24h: a >= 24:00:00 stop_time under *today's* service_id
    // represents tomorrow's post-midnight continuation, which belongs to
    // tomorrow's own board, not today's — the "yesterday" branch below is
    // what surfaces today's post-midnight continuation of a prior service.
    if (st.departureSeconds < 86400 && todayActive.has(trip.serviceId)) {
      candidates.push({
        epoch: today.midnightEpochSeconds + st.departureSeconds,
        tripId: trip.tripId,
        routeId: trip.routeId,
        headsign: trip.headsign || trip.routeId,
        viaMilla: trip.isMilla
      })
    }

    // A stop_time >= 24:00:00 belongs to the *previous* service day's trip
    // (e.g. a 25:30:00 departure is really 01:30 the next calendar day).
    if (st.departureSeconds >= 86400 && yesterdayActive.has(trip.serviceId)) {
      candidates.push({
        epoch: yesterday.midnightEpochSeconds + st.departureSeconds,
        tripId: trip.tripId,
        routeId: trip.routeId,
        headsign: trip.headsign || trip.routeId,
        viaMilla: trip.isMilla
      })
    }
  }

  return candidates
    .filter(c => c.epoch >= nowEpochSeconds)
    .sort((a, b) => a.epoch - b.epoch)
    .slice(0, limit)
    .map(c => ({
      tripId: c.tripId,
      routeId: c.routeId,
      headsign: c.headsign,
      eta: c.epoch,
      etaMinutes: Math.max(0, Math.floor((c.epoch - nowEpochSeconds) / 60)),
      viaMilla: c.viaMilla
    }))
}
