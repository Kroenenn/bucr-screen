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
    // Opt-in terminus-departure prediction (see
    // design/realtime-terminus-prediction.md) -- default OFF so a
    // deployment at a non-terminus stop, or one that hasn't verified this
    // feature, is unaffected. Only takes effect in "real" mode, and only
    // when NUXT_STOP_ID is itself a departure terminus (auto-detected, see
    // terminus-prediction.ts's isDepartureTerminus) and the trip_updates
    // feed is healthy -- otherwise behavior is identical to today.
    terminusPrediction: false,
    // Fixed buffer added to a matched inbound feeder's predicted terminus
    // arrival before it can count as the estimated departure time -- "boards
    // and departs immediately" plus a small safety margin (§3).
    terminusBoardingBufferSeconds: 60,
    // Upper bound on how much later than a slot's scheduled time a
    // candidate feeder's predicted arrival may be and still match that slot
    // (covers the observed ~18min irregular-layover case, §6).
    terminusMaxLayoverSeconds: 1200,
    // Upper bound on how much earlier than a slot's scheduled time a
    // candidate feeder's predicted arrival may be and still match that slot
    // (an arrival much earlier more likely feeds an earlier slot, §6).
    terminusMaxEarlySeconds: 300,
    // Lookback window for recently-passed outbound slots, in seconds. A slot
    // scheduled in the past can still appear if its inbound feeder's
    // predicted arrival + buffer is still in the future (bus is late and
    // boarding). Default 20 minutes covers observed irregular layovers.
    terminusDepartureLookbackSeconds: 1200,
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
      maxArrivals: 4
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
