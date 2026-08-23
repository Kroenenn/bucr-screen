export default defineNuxtConfig({
  modules: ['@nuxt/eslint'],
  ssr: true,
  devtools: { enabled: false },

  app: {
    head: {
      title: 'bUCR — Próximas salidas',
      htmlAttrs: { lang: 'es' },
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no' }],
      // Invisible on the kiosk itself (Chromium runs fullscreen, no tab bar)
      // — this is purely so the board is identifiable when someone opens it
      // on a laptop or phone to check on it.
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]
    }
  },
  // Nuxt 4 defaults srcDir to 'app' and serverDir to '<rootDir>/server',
  // so neither needs an override here.

  css: ['~/assets/css/main.css'],

  // Plain literal defaults only — no `process.env.X` reads here. Nuxt
  // resolves runtimeConfig from `process.env` itself, at *runtime*, via its
  // own `NUXT_<KEY>` convention (e.g. `operationMode` -> `NUXT_OPERATION_MODE`,
  // `public.maxArrivals` -> `NUXT_PUBLIC_MAX_ARRIVALS`). Reading process.env
  // directly here would instead bake the value in at *build* time, which
  // defeats the entire point of configuring the mode via .env on a Pi that
  // runs a pre-built Docker image — see .env.example for the actual var names.
  runtimeConfig: {
    // Server-only (not exposed to the client bundle).
    // 'fake' (schedule-only) rather than 'real': Databús has no implemented
    // path for a run to reach `runs:in_progress`, so its feed is always
    // empty, and real-time adds little at a departure terminus anyway. See
    // the README for the full reasoning.
    operationMode: 'fake',
    stopId: 'bUCR_0_01',
    gtfsFeedUrl: 'https://feeds.simovi.org/bucr/schedule/gtfs.zip',
    gtfsRefreshIntervalSeconds: 21600,
    // Deadline for downloading the static feed. Without one a hung feed host
    // stalls the shared in-flight load indefinitely (see gtfs.ts). More
    // generous than the Databús timeout below: this is a ~25 KB zip fetched
    // every 6 hours, not a per-request call.
    gtfsFetchTimeoutMs: 15000,
    databusBaseUrl: 'https://databus.bucr.digital',
    realtimeStaleThresholdSeconds: 90,
    realtimeFetchTimeoutMs: 5000,
    gtfsCacheDir: '.data/gtfs-cache',
    // "demo" mode: real seconds for one full compressed replay of the
    // represented day's real schedule (see demo-mode.ts).
    demoCycleSeconds: 900,
    // "demo" mode: how long a departed trip stays visible in its
    // "departing" state, in schedule-equivalent seconds (see demo-mode.ts
    // for why this isn't real wall-clock seconds).
    demoDepartingGraceSeconds: 180,

    // Exposed to the client bundle.
    public: {
      refreshIntervalSeconds: 15,
      // Demo mode's compressed clock can advance many schedule-minutes per
      // real second, so it needs faster polling than real/fake to read
      // smoothly instead of jumping in large steps.
      demoRefreshIntervalSeconds: 3,
      maxArrivals: 5
    }
  },

  compatibilityDate: '2026-08-01',

  typescript: {
    strict: true,
    typeCheck: false
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
