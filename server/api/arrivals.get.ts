import type { ArrivalsResponse } from '../../shared/types'
import type { GtfsData } from '../utils/gtfs'
import { nextDemoDepartures } from '../utils/demo-mode'
import { fetchRealtimeArrivals } from '../utils/realtime-mode'
import { nextDepartures } from '../utils/schedule-mode'

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
  // Databus is unreachable or stale.
  const realtime = await fetchRealtimeArrivals(gtfs, config.stopId, nowEpochSeconds, config.public.maxArrivals, {
    databusBaseUrl: config.databusBaseUrl,
    fetchTimeoutMs: config.realtimeFetchTimeoutMs,
    staleThresholdSeconds: config.realtimeStaleThresholdSeconds
  })

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
