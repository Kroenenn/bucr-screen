/**
 * "demo" mode: replays the stop's real GTFS schedule, compressed into a short
 * cycle. Every departure — time, headsign, "con milla" — comes from the real
 * stop_times of the stop's richest service pattern. Only the *pace* is
 * synthetic: a full day is replayed at `spanSeconds / cycleSeconds` speed,
 * because bUCR's real gaps run 20-40 minutes.
 *
 * `etaMinutes` is expressed as if the compressed clock were the real one, so
 * a row reading "8 min" means the timetable has 8 real minutes to the next
 * departure. That keeps the countdown looking like genuine bUCR spacing.
 * `departingGraceSeconds` uses the same schedule-equivalent unit, so its
 * real-world visibility depends on `cycleSeconds`: heavier compression makes
 * the "departing" state flash by faster.
 *
 * The represented day loops: once the last trip of the schedule has come and
 * gone, upcoming departures are drawn from the *next* lap of the same
 * schedule (see the `dayOffset` loop below) instead of the board tapering off
 * to fewer and fewer rows near "end of service". A demo kiosk display is
 * meant to be watched continuously — an empty-looking board once every
 * `cycleSeconds` would read as broken, not as a realistic close of service.
 * `limit` rows are shown at (very close to) all times.
 *
 * The "departing" state is demo-only: MBTA's Real-Time Display Guidelines say
 * to drop a prediction once it goes negative, so "real"/"fake" remove a trip
 * the moment it departs.
 * https://www.mbta.com/developers/real-time-display-guidelines
 */

import type { Arrival } from '../../shared/types'
import type { GtfsData } from './gtfs'

export interface DemoOptions {
  /** Real seconds for one full compressed replay of the represented day's real schedule. */
  cycleSeconds: number
  /** Schedule-equivalent seconds (same unit as etaMinutes) a departed trip stays visible as "departing" before removal. */
  departingGraceSeconds: number
}

interface DemoTrip {
  tripId: string
  routeId: string
  headsign: string
  viaMilla: boolean
  /** Real schedule seconds-since-midnight, from the actual stop_times entry. */
  departureSeconds: number
}

/**
 * Picks the service_id with the most boardable departures at the stop —
 * the richest, most representative real service in the data — independent
 * of which calendar dates it's actually valid for (so demo mode works on
 * any day/time, not just when that service is really running), then
 * returns its real stop_times, sorted, unmodified.
 */
function buildDemoSchedule(gtfs: GtfsData, stopId: string): DemoTrip[] | null {
  const stopTimes = (gtfs.stopTimesByStop.get(stopId) ?? []).filter(st => st.isBoardable)
  if (stopTimes.length === 0) return null

  const countByService = new Map<string, number>()
  for (const st of stopTimes) {
    const trip = gtfs.trips.get(st.tripId)
    if (!trip) continue
    countByService.set(trip.serviceId, (countByService.get(trip.serviceId) ?? 0) + 1)
  }

  let bestServiceId: string | null = null
  let bestCount = 0
  for (const [serviceId, count] of countByService) {
    if (count > bestCount) {
      bestServiceId = serviceId
      bestCount = count
    }
  }
  if (!bestServiceId) return null

  const trips: DemoTrip[] = []
  for (const st of stopTimes) {
    const trip = gtfs.trips.get(st.tripId)
    if (!trip || trip.serviceId !== bestServiceId) continue
    trips.push({
      tripId: trip.tripId,
      routeId: trip.routeId,
      headsign: trip.headsign || trip.routeId,
      viaMilla: trip.isMilla,
      departureSeconds: st.departureSeconds
    })
  }
  trips.sort((a, b) => a.departureSeconds - b.departureSeconds)

  return trips.length > 0 ? trips : null
}

export function nextDemoDepartures(
  gtfs: GtfsData,
  stopId: string,
  realEpochSeconds: number,
  limit: number,
  options: DemoOptions
): Arrival[] {
  const trips = buildDemoSchedule(gtfs, stopId)
  if (!trips || trips.length === 0) return []

  const first = trips[0]!
  const last = trips[trips.length - 1]!
  const spanSeconds = Math.max(1, last.departureSeconds - first.departureSeconds)
  const speedMultiplier = spanSeconds / options.cycleSeconds

  const secondsIntoCycle = Math.floor(realEpochSeconds * speedMultiplier) % spanSeconds
  const simulatedNow = first.departureSeconds + secondsIntoCycle

  const result: Arrival[] = []

  // The most recently departed trip (by compressed schedule position, if
  // any), shown as "departing" only while still within its grace window —
  // not forced to always be present, see the file header.
  let mostRecentlyDeparted: DemoTrip | null = null
  for (const t of trips) {
    if (t.departureSeconds >= simulatedNow) break
    mostRecentlyDeparted = t
  }
  if (mostRecentlyDeparted) {
    const secondsSince = simulatedNow - mostRecentlyDeparted.departureSeconds
    if (secondsSince <= options.departingGraceSeconds) {
      result.push({
        tripId: mostRecentlyDeparted.tripId,
        routeId: mostRecentlyDeparted.routeId,
        headsign: mostRecentlyDeparted.headsign,
        viaMilla: mostRecentlyDeparted.viaMilla,
        eta: realEpochSeconds - secondsSince / speedMultiplier,
        etaMinutes: 0,
        departing: true
      })
    }
  }

  // `dayOffset` walks virtual laps of the same schedule (0 = today, 1 =
  // today's trips repeating "tomorrow", ...) so the board keeps filling up
  // to `limit` instead of running dry near the end of a lap — see the file
  // header. `lastEffectiveDeparture` enforces strictly-increasing departure
  // times across that seam: since `spanSeconds` is defined as exactly
  // `last.departureSeconds - first.departureSeconds`, lap N's last trip and
  // lap N+1's first trip land on the exact same instant, and without this
  // check that instant would be pushed twice.
  let lastEffectiveDeparture = -Infinity
  let dayOffset = 0
  while (result.length < limit && dayOffset < 1000) {
    for (const t of trips) {
      const effectiveDeparture = t.departureSeconds + dayOffset * spanSeconds
      if (effectiveDeparture < simulatedNow) continue
      if (effectiveDeparture <= lastEffectiveDeparture) continue
      const secondsUntil = effectiveDeparture - simulatedNow
      result.push({
        tripId: t.tripId,
        routeId: t.routeId,
        headsign: t.headsign,
        viaMilla: t.viaMilla,
        eta: realEpochSeconds + secondsUntil / speedMultiplier,
        etaMinutes: Math.max(0, Math.floor(secondsUntil / 60)),
        departing: false
      })
      lastEffectiveDeparture = effectiveDeparture
      if (result.length >= limit) break
    }
    dayOffset++
  }

  return result
}
