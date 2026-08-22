import type { ArrivalsResponse } from '../../shared/types'

/**
 * Fetches /api/arrivals via useAsyncData (SSR-blocking on first load, so the
 * kiosk's very first paint already has real data instead of a "Cargando…"
 * flash) and re-polls on a fixed client-side interval after that.
 *
 * useAsyncData keeps the previous successful `data` around while a refresh
 * is in flight or failing — a kiosk screen should never flash to
 * blank/error just because one poll cycle hiccuped. `lastSuccessAt` lets
 * the UI show a subtle "desactualizado" hint once staleness crosses a
 * threshold instead.
 */
export function useArrivals() {
  const { public: publicConfig } = useRuntimeConfig()

  const { data, error, refresh } = useAsyncData<ArrivalsResponse>('arrivals', () => $fetch('/api/arrivals'))

  const lastSuccessAt = useState<number | null>('arrivals-last-success', () => (data.value ? Date.now() : null))
  watch(data, (value) => {
    if (value) lastSuccessAt.value = Date.now()
  })

  if (import.meta.client) {
    const interval = setInterval(() => refresh(), publicConfig.refreshIntervalSeconds * 1000)
    onScopeDispose(() => clearInterval(interval))
  }

  return { data, error, lastSuccessAt, refresh }
}
