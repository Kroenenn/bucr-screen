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
import { costaRicaLocalDay } from './time'

export function nextDepartures(
  gtfs: GtfsData,
  stopId: string,
  stopDirectionId: number,
  nowEpochSeconds: number,
  limit: number
): Arrival[] {
  const today = costaRicaLocalDay(nowEpochSeconds)
  const yesterday = costaRicaLocalDay(nowEpochSeconds - 86400)

  const todayActive = activeServiceIds(gtfs, today.dateStr, today.weekday)
  const yesterdayActive = activeServiceIds(gtfs, yesterday.dateStr, yesterday.weekday)

  const stopTimes = gtfs.stopTimesByStop.get(stopId) ?? []

  const candidates: Array<{ epoch: number; tripId: string; routeId: string; headsign: string; viaMilla: boolean }> = []

  for (const st of stopTimes) {
    const trip = gtfs.trips.get(st.tripId)
    if (!trip) continue

    // A trip running the *other* direction of the route only touches this
    // stop_id because it's a two-way terminus (e.g. bUCR's Educación stop
    // has trips ending there with trip_headsign "Educación" itself) — not
    // a boarding opportunity. direction_id === stopDirectionId is which
    // direction actually departs from here; a trip with no direction_id at
    // all is let through (fail open — GTFS makes the field optional).
    if (trip.directionId !== undefined && trip.directionId !== stopDirectionId) continue

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
        viaMilla: trip.isMilla,
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
        viaMilla: trip.isMilla,
      })
    }
  }

  return candidates
    .filter((c) => c.epoch >= nowEpochSeconds)
    .sort((a, b) => a.epoch - b.epoch)
    .slice(0, limit)
    .map((c) => ({
      tripId: c.tripId,
      routeId: c.routeId,
      headsign: c.headsign,
      eta: c.epoch,
      etaMinutes: Math.max(0, Math.floor((c.epoch - nowEpochSeconds) / 60)),
      viaMilla: c.viaMilla,
    }))
}
