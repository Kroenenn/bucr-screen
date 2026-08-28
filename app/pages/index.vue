<script setup lang="ts">
const { public: publicConfig } = useRuntimeConfig()
const { data, error, lastSuccessAt } = useArrivals()
const { now, time, seconds, dateParts } = useKioskClock()

// Depends on `now` (the 1s clock tick), not a bare Date.now(): a plain
// Date.now() call isn't a reactive dependency, so this computed would only
// re-evaluate at the moment a poll succeeded — exactly when the delta is
// ~0 — and the hint would never appear, however long the feed was down.
const isStale = computed(() => {
  if (!lastSuccessAt.value) return false
  const staleAfterMs = publicConfig.refreshIntervalSeconds * 1000 * 3
  return now.value.getTime() - lastSuccessAt.value > staleAfterMs
})

const hasEverLoaded = computed(() => data.value !== null)

// Strips "https://" and a trailing slash for display — agency_url from the
// feed is "https://bus.ucr.ac.cr/", the footer just wants "bus.ucr.ac.cr".
const agencyUrlDisplay = computed(() => data.value?.agencyUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') ?? '')
</script>

<template>
  <div class="screen">
    <!--
      A single row (route | clock | toggle) via grid, not two stacked rows:
      the clock sitting in its own row underneath cost as much height as the
      logo row itself. Sharing the row means the header's height is just
      whichever of the two is taller, not both added together — the
      difference goes straight to the board.
    -->
    <header class="screen__header">
      <div class="screen__route">
        <!--
          Two raster variants rather than one recolored in CSS. Both stay in
          the DOM with CSS picking per theme; swapping `src` reactively would
          re-request an image on every toggle.
        -->
        <img
          class="screen__route-logo screen__route-logo--dark"
          src="/logo-bucr-blanco.png"
          :alt="data?.routeShortName || 'bUCR'"
        >
        <img
          class="screen__route-logo screen__route-logo--light"
          src="/logo-bucr.png"
          :alt="data?.routeShortName || 'bUCR'"
        >
        <h1 class="screen__stop-name">
          {{ data?.stopName ?? 'Cargando parada…' }}
        </h1>
      </div>

      <!--
        Time beside the date/refresh stack, not above it: a digital-clock
        layout rather than three stacked lines. Putting the date and refresh
        text next to the time instead of under it means the time's height —
        not three lines — is what drives the row, so it can run bigger
        without regrowing the header.

        No <ClientOnly> here (or on ThemeToggle below): both `now` (this
        composable) and `theme` (useKioskTheme) are `useState`, so the
        server's value round-trips through the Nuxt payload and hydration
        reuses it rather than recomputing — server and client agree on the
        very first frame, no mismatch. <ClientOnly> was hiding that first
        frame entirely, so the whole header (and everything below it, since
        the board's cqh sizing depends on the header's real height) visibly
        popped in and resized right after hydration on every refresh.
      -->
      <div class="screen__clock">
        <span class="screen__clock-time">
          {{ time }}<span
            class="screen__clock-seconds"
          >:{{ seconds }}</span>
        </span>
        <div class="screen__clock-meta">
          <span class="screen__clock-date">
            <span class="screen__clock-date-weekday">{{ dateParts.weekday }},</span>
            <span class="screen__clock-date-rest">{{ dateParts.rest }}</span>
          </span>
          <span class="screen__clock-refresh">
            <span class="screen__clock-refresh-dot" />
            Actualizaciones cada minuto
            <span
              v-if="data?.realtimeFallback"
              class="screen__clock-refresh-dot"
            />
          </span>
        </div>
      </div>

      <ThemeToggle class="screen__theme-toggle" />
    </header>

    <div class="screen__status-bar">
      <ModeBadge
        v-if="data"
        :source="data.source"
      />
      <span
        v-if="isStale"
        class="screen__stale-hint"
      >actualizando…</span>
    </div>

    <!--
      .screen__board is an invisible sizing box (still `flex: 1`, still the
      cqh reference for ArrivalRow — see the container-type comment below):
      it always claims the *full* leftover height, whether or not the card
      inside it uses all of it. .screen__board-card is what's actually
      visible, and it's sized to its own content, not stretched to fill
      .screen__board — so the card ends right after the last row instead of
      trailing off into empty surface when there's slack to spare.
    -->
    <main class="screen__board">
      <div class="screen__board-card">
        <div
          v-if="data && data.arrivals.length > 0"
          class="screen__board-header"
        >
          <span>Destino</span>
          <span>Próximas salidas</span>
        </div>

        <div
          v-if="data && data.arrivals.length > 0"
          class="arrival-list"
        >
          <ArrivalRow
            v-for="arrival in data.arrivals"
            :key="arrival.tripId"
            :arrival="arrival"
          />
        </div>

        <p
          v-else-if="data && data.arrivals.length === 0"
          class="screen__empty"
        >
          No hay más salidas programadas por hoy.
        </p>

        <p
          v-else-if="error && !hasEverLoaded"
          class="screen__empty screen__empty--error"
        >
          No se pudo cargar la información de salidas.
        </p>

        <p
          v-else
          class="screen__empty"
        >
          Cargando información de salidas…
        </p>
      </div>
    </main>

    <footer class="screen__footer">
      {{ data?.routeLongName || 'Bus interno de la Universidad de Costa Rica' }} — {{ agencyUrlDisplay || 'bus.ucr.ac.cr' }}
    </footer>
  </div>
</template>

<style scoped>
.screen {
  --screen-pad: clamp(1.25rem, 3vw, 3rem);
  height: 100vh;
  width: 100vw;
  display: flex;
  flex-direction: column;
  padding: var(--screen-pad);
  gap: clamp(0.6rem, 1.2vw, 1.1rem);
}

.screen__header {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 1.25rem;
}

.screen__route {
  display: flex;
  align-items: center;
  gap: 1rem;
  justify-self: start;
  min-width: 0;
}

/* The real bUCR mark, shared with infobus-web. Only one variant is ever
   displayed; `display: none` (rather than opacity/visibility) means assistive
   tech ignores the hidden one, so the visible logo's alt text is the only one
   announced. Dark is the kiosk default, so the white variant shows unless the
   viewer explicitly toggles light. */
.screen__route-logo {
  height: clamp(2.6rem, 5vw, 4.2rem);
  width: auto;
  flex-shrink: 0;
}

.screen__route-logo--light {
  display: none;
}

:root[data-theme='light'] .screen__route-logo--dark {
  display: none;
}

:root[data-theme='light'] .screen__route-logo--light {
  display: block;
}

/* stopname-tracked-caps: uppercase, wide tracking, kept at the same weight/
   size so it balances against the clock rather than dominating it. */
.screen__stop-name {
  margin: 0;
  font-size: clamp(2.4rem, 5vw, 4.2rem);
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  line-height: 1;
}

.screen__clock {
  display: flex;
  align-items: center;
  gap: 0.6em;
}

/* clock-proportional-light: proportional sans at a light weight with airy
   tracking, in place of the heavy mono/tabular treatment — reads as a calmer,
   more editorial clock. */
.screen__clock-time {
  font-family: var(--font-sans);
  font-variant-numeric: normal;
  font-size: clamp(2.4rem, 5.2vw, 6rem);
  font-weight: 300;
  letter-spacing: 0.01em;
  line-height: 1;
  color: var(--color-ink);
}

.screen__clock-meta {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

/* date-uppercase-tracked: weekday over "23 de agosto" on two right-aligned
   lines, all-caps, mono, wide tracking — a signage/label register. */
.screen__clock-date {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  text-align: right;
  gap: 0.1em;
  font-family: var(--font-mono);
  font-size: clamp(0.95rem, 1.5vw, 1.4rem);
  line-height: 1.15;
  text-transform: uppercase;
  letter-spacing: 0.16em;
}

/* clock-secs-gray: faint :SS trailing the HH:MM, at the same light weight as
   the clock so it reads as a quiet secondary detail. */
.screen__clock-seconds {
  font-size: 0.4em;
  font-weight: 300;
  color: var(--color-ink-faint);
  margin-left: 2px;
}

/* date-uppercase-tracked: weekday carries slightly more weight/ink than the
   day-month remainder, both inline on the single tracked line. */
.screen__clock-date-weekday {
  color: var(--color-ink-muted);
  font-weight: 700;
}

.screen__clock-date-rest {
  color: var(--color-ink-faint);
  font-weight: 600;
}

.screen__clock-refresh {
  display: flex;
  align-items: center;
  gap: 0.5em;
  color: var(--color-ink-faint);
  font-size: clamp(0.6rem, 0.8vw, 0.75rem);
  line-height: 1.1;
}

.screen__clock-refresh-dot {
  width: 0.45em;
  height: 0.45em;
  border-radius: 50%;
  background: var(--color-ink-faint);
  animation: clock-refresh-pulse 1.6s ease-in-out infinite;
}

@keyframes clock-refresh-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.screen__status-bar {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.screen__stale-hint {
  color: var(--color-ink-faint);
  font-size: 0.9rem;
  font-style: italic;
}

/*
 * container-type: size turns this into a query container: ArrivalRow sizes
 * its padding/type in `cqh` (% of *this* box's height), not the viewport's.
 * That's what lets `maxArrivals` rows run as large as the *available* space
 * allows, with no scroll and no clipping, regardless of the kiosk's actual
 * screen resolution — vw/vh alone can't do that because they don't know how
 * much height the header/footer/status-bar chrome already ate. Rows don't
 * have to fully consume that space, though — see .screen__board-card.
 */
.screen__board {
  container-type: size;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* The actual visible card — sized to its own content (no flex-grow), not
   stretched to fill .screen__board, so it ends right after the last row
   instead of showing bare surface below it when there's leftover height. */
.screen__board-card {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 1rem;
  padding: 0 clamp(1rem, 2vw, 2rem);
}

/* Bold and full-contrast on purpose — these are the labels that teach a
   first-time viewer what the big words/numbers under them mean, so they need
   to win the eye's attention, not fade into the furniture like the clock's
   secondary text does. Second label right-aligned to sit over the eta
   column, same as "Destino" sits over the headsigns. */
.screen__board-header {
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  padding-top: clamp(0.6rem, 4cqh, 1.5rem);
  padding-bottom: clamp(0.3rem, 1.5cqh, 0.6rem);
  font-family: var(--font-mono);
  font-size: clamp(1.05rem, 1.8vw, 1.5rem);
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-ink);
}

/*
 * Plain div, not TransitionGroup: Vue's TransitionGroup repositions any row
 * whose index changed via FLIP, and a departing trip getting promoted to the
 * "SALIENDO" slot (always index 0, see demo-mode.ts) can jump several rows
 * at once. Even with no move/leave CSS transition defined, the leaving row's
 * absolutely-positioned "static position" was landing on top of an existing
 * row instead of its own old slot — two different trips' text rendering in
 * the same space. A plain re-render (rows just appear/disappear/reorder
 * instantly with each poll) has no positioning math to get wrong, at the
 * cost of the add/remove animation. The per-row "SALIENDO" blink (in
 * ArrivalRow.vue) still runs — that one only ever animates a row in place.
 */
.arrival-list {
  position: relative;
}

.screen__empty {
  padding: clamp(2rem, 6cqh, 4rem) 0;
  color: var(--color-ink-muted);
  font-size: clamp(1.2rem, 2vw, 1.8rem);
  text-align: center;
}

.screen__empty--error {
  color: var(--color-error);
}

/* Same brand gradient as infobus-web's header — fixed in both themes, like
   the header's blue-900 → blue-600 there, so it reads as the same brand
   element regardless of the kiosk's light/dark toggle. Full-bleed: negative
   margins cancel out `.screen`'s own padding so the bar runs edge-to-edge
   instead of sitting inset as a rounded box. */
.screen__footer {
  text-align: center;
  color: rgba(255, 255, 255, 0.85);
  background: linear-gradient(to right, var(--color-blue-900), var(--color-blue-600));
  margin: 0 calc(var(--screen-pad) * -1) calc(var(--screen-pad) * -1);
  padding: clamp(0.6rem, 1.2vw, 1rem) var(--screen-pad);
  font-size: clamp(0.8rem, 1.1vw, 1rem);
}
</style>
