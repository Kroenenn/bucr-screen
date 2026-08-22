/**
 * "demo" mode: a synthetic, endlessly-repeating departure sequence — NOT
 * derived from real stop_times spacing (bUCR's actual gaps run 20-35
 * minutes, far too slow to watch a full lifecycle in a demo). Destinations
 * and the route id are pulled from the real GTFS data (the stop's richest
 * service pattern) for realism; the *timing* is a fixed, dense pattern
 * (3-5 minute gaps, real-time paced — no acceleration) chosen specifically
 * so a viewer sees the full lifecycle — counting down, arriving, a distinct
 * "departing" state, removal from the list — within a few minutes of
 * watching, instead of the 20-30 minute gaps a real board here would have.
 *
 * The "departing" state is a deliberate departure from real transit
 * signage practice, not an oversight: MBTA's published Real-Time Display
 * Guidelines say a prediction should stop being shown entirely once it
 * goes negative ("the vehicle has already left the stop") — no lingering
 * post-departure state. See https://www.mbta.com/developers/real-time-display-guidelines.
 * "real" and "fake" mode follow that (prompt removal, no "departing" flag)
 * because they represent actual service, where showing a bus that's
 * already gone as "departing" would be misleading. Demo mode intentionally
 * keeps a departed trip visible for `departingGraceSeconds` specifically
 * to make that otherwise-instant, easy-to-miss transition visible to
 * someone watching a demo — see PLAN.md for the full reasoning.
 */

import type { Arrival } from '../../shared/types'
import type { GtfsData, GtfsTrip } from './gtfs'

/** Gap before each of the next 3 synthetic departures, then repeats: 3, 4, 5 minutes. */
const GAP_PATTERN_SECONDS = [180, 240, 300]
const PATTERN_SUM_SECONDS = GAP_PATTERN_SECONDS.reduce((sum, gap) => sum + gap, 0)
/** Seconds elapsed, within one pattern repetition, before the departure at each local index. */
const PATTERN_PREFIX_SECONDS = GAP_PATTERN_SECONDS.reduce<number[]>((prefixes, gap, i) => {
  prefixes.push(i === 0 ? 0 : prefixes[i - 1]! + GAP_PATTERN_SECONDS[i - 1]!)
  return prefixes
}, [])

export interface DemoOptions {
  /** How long a departed trip stays visible in its "departing" state before being removed. */
  departingGraceSeconds: number
}

interface DemoDestination {
  headsign: string
  viaMilla: boolean
}

interface DemoPattern {
  /**
   * Distinct (headsign, viaMilla) destinations from the stop's real,
   * richest service pattern, in first-seen order — kept as pairs rather
   * than bare headsign strings so a "con milla" trip (same headsign,
   * different route) is a distinct demo destination, not merged away.
   */
  destinations: DemoDestination[]
  routeId: string
}

/**
 * Picks the service_id with the most departures at the stop — the richest,
 * most representative pattern in the data — independent of which calendar
 * dates it's actually valid for, and extracts its distinct destinations.
 */
function buildDemoPattern(gtfs: GtfsData, stopId: string, stopDirectionId: number): DemoPattern | null {
  const stopTimes = gtfs.stopTimesByStop.get(stopId) ?? []
  if (stopTimes.length === 0) return null

  const countByService = new Map<string, number>()
  for (const st of stopTimes) {
    const trip = gtfs.trips.get(st.tripId)
    if (!trip) continue
    // A trip running the other direction only touches this stop_id as a
    // terminus (e.g. bUCR's Educación stop has trips ending there with
    // trip_headsign "Educación" itself) — not a real demo destination.
    if (trip.directionId !== undefined && trip.directionId !== stopDirectionId) continue
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

  const orderedTrips = stopTimes
    .filter((st) => gtfs.trips.get(st.tripId)?.serviceId === bestServiceId)
    .sort((a, b) => a.departureSeconds - b.departureSeconds)
    .map((st) => gtfs.trips.get(st.tripId))
    .filter((trip): trip is GtfsTrip => trip !== undefined)
    .filter((trip) => trip.directionId === undefined || trip.directionId === stopDirectionId)

  const destinations: DemoDestination[] = []
  const seen = new Set<string>()
  for (const trip of orderedTrips) {
    const headsign = trip.headsign || trip.routeId
    const key = `${headsign}|${trip.isMilla}`
    if (!seen.has(key)) {
      seen.add(key)
      destinations.push({ headsign, viaMilla: trip.isMilla })
    }
  }
  const firstTrip = orderedTrips[0]
  if (destinations.length === 0 || !firstTrip) return null

  return { destinations, routeId: firstTrip.routeId }
}

/** Departure time (real Unix seconds, mod the pattern) of the nth synthetic departure. */
function departureTimeForIndex(index: number): number {
  const cycles = Math.floor(index / GAP_PATTERN_SECONDS.length)
  const localIndex = index % GAP_PATTERN_SECONDS.length
  return cycles * PATTERN_SUM_SECONDS + PATTERN_PREFIX_SECONDS[localIndex]!
}

/** Index of the most recently departed (or currently departing) synthetic trip at time `now`. */
function currentIndexAt(now: number): number {
  const cycles = Math.floor(now / PATTERN_SUM_SECONDS)
  const remainder = now - cycles * PATTERN_SUM_SECONDS
  let localIndex = 0
  while (localIndex < GAP_PATTERN_SECONDS.length - 1 && remainder >= PATTERN_PREFIX_SECONDS[localIndex + 1]!) {
    localIndex++
  }
  return cycles * GAP_PATTERN_SECONDS.length + localIndex
}

function arrivalForIndex(pattern: DemoPattern, index: number, realEpochSeconds: number, departing: boolean): Arrival {
  const departureTime = departureTimeForIndex(index)
  const destination = pattern.destinations[index % pattern.destinations.length]!
  return {
    tripId: `demo-${index}`,
    routeId: pattern.routeId,
    headsign: destination.headsign,
    eta: departureTime,
    etaMinutes: Math.max(0, Math.floor((departureTime - realEpochSeconds) / 60)),
    viaMilla: destination.viaMilla,
    departing,
  }
}

export function nextDemoDepartures(
  gtfs: GtfsData,
  stopId: string,
  stopDirectionId: number,
  realEpochSeconds: number,
  limit: number,
  options: DemoOptions
): Arrival[] {
  const pattern = buildDemoPattern(gtfs, stopId, stopDirectionId)
  if (!pattern) return []

  const currentIndex = currentIndexAt(realEpochSeconds)
  const secondsSinceLastDeparture = realEpochSeconds - departureTimeForIndex(currentIndex)

  const result: Arrival[] = []
  let nextIndex = currentIndex

  if (secondsSinceLastDeparture <= options.departingGraceSeconds) {
    // Always exactly one trip visibly departing (or about to be) — this is
    // what guarantees "there's always a trip about to leave" rather than
    // leaving it to chance whether a poll lands during a departure window.
    result.push(arrivalForIndex(pattern, currentIndex, realEpochSeconds, true))
    nextIndex++
  } else {
    nextIndex++
  }

  while (result.length < limit) {
    result.push(arrivalForIndex(pattern, nextIndex, realEpochSeconds, false))
    nextIndex++
  }

  return result
}
