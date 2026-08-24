import type { ArrivalsResponse } from '../../shared/types'
import type { GtfsData } from '../utils/gtfs'
import { nextDemoDepartures } from '../utils/demo-mode'
import { deriveArrivalsFromFeed, fetchTripUpdateFeed, isFeedFresh, type FetchRealtimeOptions } from '../utils/realtime-mode'
import { nextDepartures } from '../utils/schedule-mode'
import { deriveTerminusArrivals } from '../utils/terminus-mode'
import { isDepartureTerminus } from '../utils/terminus-prediction'

/** Real branding straight from routes.txt/agency.txt — see ArrivalsResponse. */
function brandingMeta(gtfs: GtfsData, routeId: string | undefined) {
  const route = (routeId && gtfs.routes.get(routeId)) || gtfs.routes.values().next().value || null
  return {
    routeShortName: route?.shortName ?? '',
    routeLongName: route?.longName ?? '',
    routeColor: route?.color ?? '000000',
    routeTextColor: route?.textColor ?? 'FFFFFF',
    agencyName: gtfs.agency?.name ?? '',
    agencyUrl: gtfs.agency?.url ?? ''
  }
}

export default defineEventHandler(async (event): Promise<ArrivalsResponse> => {
  setResponseHeader(event, 'Cache-Control', 'no-store')

  const config = useRuntimeConfig()
  const nowEpochSeconds = Math.floor(Date.now() / 1000)

  const gtfs = await getGtfsData().catch((err) => {
    throw createError({
      statusCode: 503,
      statusMessage: 'GTFS schedule data unavailable',
      data: { cause: String(err) }
    })
  })

  const stopName = gtfs.stops.get(config.stopId)?.name ?? config.stopId
  // agency_timezone from the feed itself (agency.txt) — not a hardcoded
  // offset, see server/utils/time.ts. Falls back only if the feed is
  // somehow missing agency.txt entirely.
  const timeZone = gtfs.agency?.timezone ?? 'America/Costa_Rica'

  if (config.operationMode === 'fake') {
    const arrivals = nextDepartures(gtfs, config.stopId, timeZone, nowEpochSeconds, config.public.maxArrivals)
    return {
      stopId: config.stopId,
      stopName,
      source: 'schedule',
      realtimeFallback: false,
      arrivals,
      generatedAt: nowEpochSeconds,
      ...brandingMeta(gtfs, arrivals[0]?.routeId)
    }
  }

  if (config.operationMode === 'demo') {
    const arrivals = nextDemoDepartures(gtfs, config.stopId, nowEpochSeconds, config.public.maxArrivals, {
      cycleSeconds: config.demoCycleSeconds,
      departingGraceSeconds: config.demoDepartingGraceSeconds
    })
    return {
      stopId: config.stopId,
      stopName,
      source: 'demo',
      realtimeFallback: false,
      arrivals,
      generatedAt: nowEpochSeconds,
      ...brandingMeta(gtfs, arrivals[0]?.routeId)
    }
  }

  // "real" mode: try live data first, falling back to the schedule when
  // Databus is unreachable or stale. Fetch trip_updates exactly once — both
  // the plain realtime path below and the (opt-in) terminus-prediction path
  // read from the same fetched feed rather than each fetching it themselves.
  const realtimeOptions: FetchRealtimeOptions = {
    databusBaseUrl: config.databusBaseUrl,
    fetchTimeoutMs: config.realtimeFetchTimeoutMs,
    staleThresholdSeconds: config.realtimeStaleThresholdSeconds
  }
  const tripUpdateFeed = await fetchTripUpdateFeed(realtimeOptions)

  // Terminus-gated prediction (see design/realtime-terminus-prediction.md
  // §8 WS-C): only when explicitly opted in, the configured stop is
  // auto-detected as a departure terminus, and the feed is fresh. Any
  // failure inside deriveTerminusArrivals degrades to an empty array, so
  // this simply falls through to the plain realtime/schedule chain below —
  // never a regression versus today's behavior.
  if (
    tripUpdateFeed
    && config.terminusPrediction
    && isDepartureTerminus(gtfs, config.stopId)
    && isFeedFresh(tripUpdateFeed, nowEpochSeconds, config.realtimeStaleThresholdSeconds)
  ) {
    const terminusArrivals = deriveTerminusArrivals(
      tripUpdateFeed,
      gtfs,
      config.stopId,
      timeZone,
      nowEpochSeconds,
      config.public.maxArrivals,
      {
        boardingBufferS: config.terminusBoardingBufferSeconds,
        maxLayoverS: config.terminusMaxLayoverSeconds,
        maxEarlyS: config.terminusMaxEarlySeconds
      }
    )

    if (terminusArrivals.length > 0) {
      return {
        stopId: config.stopId,
        stopName,
        source: 'realtime',
        realtimeFallback: false,
        arrivals: terminusArrivals,
        generatedAt: nowEpochSeconds,
        ...brandingMeta(gtfs, terminusArrivals[0]?.routeId)
      }
    }
  }

  const realtime = tripUpdateFeed
    ? deriveArrivalsFromFeed(tripUpdateFeed, gtfs, config.stopId, nowEpochSeconds, config.public.maxArrivals, config.realtimeStaleThresholdSeconds)
    : { healthy: false, arrivals: [] }

  if (realtime.healthy) {
    return {
      stopId: config.stopId,
      stopName,
      source: 'realtime',
      realtimeFallback: false,
      arrivals: realtime.arrivals,
      generatedAt: nowEpochSeconds,
      ...brandingMeta(gtfs, realtime.arrivals[0]?.routeId)
    }
  }

  const fallbackArrivals = nextDepartures(gtfs, config.stopId, timeZone, nowEpochSeconds, config.public.maxArrivals)
  return {
    stopId: config.stopId,
    stopName,
    source: 'schedule',
    realtimeFallback: true,
    arrivals: fallbackArrivals,
    generatedAt: nowEpochSeconds,
    ...brandingMeta(gtfs, fallbackArrivals[0]?.routeId)
  }
})
