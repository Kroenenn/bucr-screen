/**
 * Shared between server/ and app/ — kept dependency-free (no Nuxt/Vue/Node
 * imports) so it can be imported from either side.
 */

export type ArrivalSource = 'realtime' | 'schedule' | 'demo'

/** `NUXT_OPERATION_MODE` — chooses where arrivals come from. See server/api/arrivals.get.ts. */
export type OperationMode = 'real' | 'fake' | 'demo'

export interface Arrival {
  tripId: string
  routeId: string
  /** Display destination, e.g. "Odontología". Falls back to the route name when unknown. */
  headsign: string
  /** Unix seconds. */
  eta: number
  /** Whole minutes until arrival, floored, never negative. */
  etaMinutes: number
  /**
   * True when this trip takes the longer "milla universitaria" loop
   * instead of the direct route — same destination headsign either way, so
   * without this a rider can't tell the two apart. Set in every mode (it's
   * a schedule fact, not mode-specific behavior) — matches infobus-web's
   * "con milla" badge.
   */
  viaMilla: boolean
  /**
   * True only for "demo" mode's deliberate post-departure display window
   * (see server/utils/demo-mode.ts) — MBTA's own Real-Time Display
   * Guidelines say a prediction should stop being shown once it goes
   * negative, so "real"/"fake" never set this; it exists purely so demo
   * mode can showcase a state real signage normally hides. Always paired
   * with etaMinutes === 0.
   */
  departing?: boolean
  /** Only present for realtime arrivals — seconds of GTFS-RT uncertainty. */
  uncertaintySeconds?: number
}

export interface ArrivalsResponse {
  stopId: string
  stopName: string
  source: ArrivalSource
  /** True only in "real" mode when the realtime feed was unhealthy and we fell back. */
  realtimeFallback: boolean
  arrivals: Arrival[]
  generatedAt: number
  /**
   * Branding read from the GTFS feed (routes.txt/agency.txt) rather than
   * hardcoded, so it follows the feed without a redeploy. Values fall back
   * only when the feed genuinely has none, e.g. a cold start before the
   * first successful fetch.
   *
   * `routeShortName` is the logo's accessible name; `routeLongName` and
   * `agencyUrl` render the footer. `routeColor`/`routeTextColor` (hex, no
   * leading "#") are exposed but unused by the current UI.
   */
  routeShortName: string
  routeLongName: string
  routeColor: string
  routeTextColor: string
  agencyName: string
  agencyUrl: string
}
