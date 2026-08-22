export default defineNuxtConfig({
  compatibilityDate: '2026-08-01',
  devtools: { enabled: false },
  ssr: true,
  // Nuxt 4 (matches infobus-web) defaults srcDir to 'app' and serverDir to
  // '<rootDir>/server' on its own — no override needed, unlike Nuxt 3 (see
  // PLAN.md's "Nuxt gotcha" note for what went wrong there).

  css: ['~/assets/css/main.css'],

  app: {
    head: {
      title: 'bUCR — Próximas salidas',
      htmlAttrs: { lang: 'es' },
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no' }],
    },
  },

  // Plain literal defaults only — no `process.env.X` reads here. Nuxt
  // resolves runtimeConfig from `process.env` itself, at *runtime*, via its
  // own `NUXT_<KEY>` convention (e.g. `operationMode` -> `NUXT_OPERATION_MODE`,
  // `public.maxArrivals` -> `NUXT_PUBLIC_MAX_ARRIVALS`). Reading process.env
  // directly here would instead bake the value in at *build* time, which
  // defeats the entire point of configuring the mode via .env on a Pi that
  // runs a pre-built Docker image — see .env.example for the actual var names.
  runtimeConfig: {
    // Server-only (not exposed to the client bundle).
    operationMode: 'real',
    stopId: 'bUCR_0_01',
    // Which GTFS direction_id actually departs from stopId — bUCR_0_01
    // (Educación) is a two-way terminus: direction 0 trips start there
    // (boardable), direction 1 trips end there (not boardable, but still
    // have a stop_time entry there since GTFS records the whole trip).
    // Change this alongside NUXT_STOP_ID if it's ever pointed elsewhere.
    stopDirectionId: 0,
    gtfsFeedUrl: 'https://feeds.simovi.org/bucr/schedule/gtfs.zip',
    gtfsRefreshIntervalSeconds: 21600,
    databusBaseUrl: 'https://databus.bucr.digital',
    realtimeStaleThresholdSeconds: 90,
    realtimeFetchTimeoutMs: 5000,
    gtfsCacheDir: '.data/gtfs-cache',
    // "demo" mode: how long a departed synthetic trip stays visible in its
    // "departing" state before being removed from the board.
    demoDepartingGraceSeconds: 180,

    // Exposed to the client bundle.
    public: {
      refreshIntervalSeconds: 15,
      maxArrivals: 5,
    },
  },

  typescript: {
    strict: true,
    typeCheck: false,
  },
})
