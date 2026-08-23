import type { ArrivalsResponse } from '../../shared/types'

/**
 * Fetches /api/arrivals via useAsyncData (SSR-blocking on first load, so the
 * kiosk's very first paint already has real data instead of a "Cargando…"
 * flash) and re-polls on a client-side interval after that.
 *
 * useAsyncData keeps the previous successful `data` around while a refresh
 * is in flight or failing — a kiosk screen should never flash to
 * blank/error just because one poll cycle hiccuped. `lastSuccessAt` lets
 * the UI show a subtle "desactualizado" hint once staleness crosses a
 * threshold instead.
 *
 * The poll interval isn't fixed: once a response's `source` is known,
 * "demo" mode switches to `public.demoRefreshIntervalSeconds` (faster) —
 * its compressed clock can advance many schedule-minutes per real second
 * (see demo-mode.ts), so it needs closer polling to read smoothly instead
 * of jumping in large steps between refreshes.
 */
export function useArrivals() {
  const { public: publicConfig } = useRuntimeConfig()

  const { data, error, refresh } = useAsyncData<ArrivalsResponse>('arrivals', () => $fetch('/api/arrivals'))

  const lastSuccessAt = useState<number | null>('arrivals-last-success', () => (data.value ? Date.now() : null))
  watch(data, (value) => {
    if (value) lastSuccessAt.value = Date.now()
  })

  if (import.meta.client) {
    let intervalId: ReturnType<typeof setInterval> | undefined

    const applyIntervalSeconds = (seconds: number) => {
      if (intervalId) clearInterval(intervalId)
      intervalId = setInterval(() => refresh(), seconds * 1000)
    }

    applyIntervalSeconds(publicConfig.refreshIntervalSeconds)

    watch(
      () => data.value?.source,
      (source) => {
        applyIntervalSeconds(source === 'demo' ? publicConfig.demoRefreshIntervalSeconds : publicConfig.refreshIntervalSeconds)
      }
    )

    onScopeDispose(() => {
      if (intervalId) clearInterval(intervalId)
    })
  }

  return { data, error, lastSuccessAt, refresh }
}
