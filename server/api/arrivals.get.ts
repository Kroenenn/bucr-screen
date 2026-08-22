import type { ArrivalsResponse } from '../../shared/types'
import { nextDemoDepartures } from '../utils/demo-mode'
import { fetchRealtimeArrivals } from '../utils/realtime-mode'
import { nextDepartures } from '../utils/schedule-mode'

export default defineEventHandler(async (event): Promise<ArrivalsResponse> => {
  setResponseHeader(event, 'Cache-Control', 'no-store')

  const config = useRuntimeConfig()
  const nowEpochSeconds = Math.floor(Date.now() / 1000)

  const gtfs = await getGtfsData().catch((err) => {
    throw createError({
      statusCode: 503,
      statusMessage: 'GTFS schedule data unavailable',
      data: { cause: String(err) },
    })
  })

  const stopName = gtfs.stops.get(config.stopId)?.name ?? config.stopId

  if (config.operationMode === 'fake') {
    return {
      stopId: config.stopId,
      stopName,
      source: 'schedule',
      realtimeFallback: false,
      arrivals: nextDepartures(gtfs, config.stopId, config.stopDirectionId, nowEpochSeconds, config.public.maxArrivals),
      generatedAt: nowEpochSeconds,
    }
  }

  if (config.operationMode === 'demo') {
    return {
      stopId: config.stopId,
      stopName,
      source: 'demo',
      realtimeFallback: false,
      arrivals: nextDemoDepartures(gtfs, config.stopId, config.stopDirectionId, nowEpochSeconds, config.public.maxArrivals, {
        departingGraceSeconds: config.demoDepartingGraceSeconds,
      }),
      generatedAt: nowEpochSeconds,
    }
  }

  // "real" mode: try live data first, automatically fall back to the
  // schedule when Databus is unreachable or stale (see PLAN.md).
  const realtime = await fetchRealtimeArrivals(gtfs, config.stopId, config.stopDirectionId, nowEpochSeconds, config.public.maxArrivals, {
    databusBaseUrl: config.databusBaseUrl,
    fetchTimeoutMs: config.realtimeFetchTimeoutMs,
    staleThresholdSeconds: config.realtimeStaleThresholdSeconds,
  })

  if (realtime.healthy) {
    return {
      stopId: config.stopId,
      stopName,
      source: 'realtime',
      realtimeFallback: false,
      arrivals: realtime.arrivals,
      generatedAt: nowEpochSeconds,
    }
  }

  return {
    stopId: config.stopId,
    stopName,
    source: 'schedule',
    realtimeFallback: true,
    arrivals: nextDepartures(gtfs, config.stopId, config.stopDirectionId, nowEpochSeconds, config.public.maxArrivals),
    generatedAt: nowEpochSeconds,
  }
})
