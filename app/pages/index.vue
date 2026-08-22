<script setup lang="ts">
const { public: publicConfig } = useRuntimeConfig()
const { data, error, lastSuccessAt } = useArrivals()
const { time, date } = useKioskClock()

const isStale = computed(() => {
  if (!lastSuccessAt.value) return false
  const staleAfterMs = publicConfig.refreshIntervalSeconds * 1000 * 3
  return Date.now() - lastSuccessAt.value > staleAfterMs
})

const hasEverLoaded = computed(() => data.value !== null)
</script>

<template>
  <div class="screen">
    <header class="screen__header">
      <div class="screen__route">
        <span class="screen__route-badge">bUCR</span>
        <h1 class="screen__stop-name">{{ data?.stopName ?? 'Cargando parada…' }}</h1>
      </div>

      <div class="screen__clock-block">
        <ClientOnly>
          <ThemeToggle class="screen__theme-toggle" />
        </ClientOnly>
        <ClientOnly>
          <div class="screen__clock">
            <span class="screen__clock-time">{{ time }}</span>
            <span class="screen__clock-date">{{ date }}</span>
            <span class="screen__clock-refresh">
              <span class="screen__clock-refresh-dot" />
              Actualizaciones cada minuto
              <span v-if="data?.realtimeFallback" class="screen__clock-refresh-dot" />
            </span>
          </div>
        </ClientOnly>
      </div>
    </header>

    <div class="screen__status-bar">
      <ModeBadge v-if="data" :source="data.source" />
      <span v-if="isStale" class="screen__stale-hint">actualizando…</span>
    </div>

    <main class="screen__board">
      <TransitionGroup v-if="data && data.arrivals.length > 0" tag="div" name="arrival-list" class="arrival-list">
        <ArrivalRow v-for="arrival in data.arrivals" :key="arrival.tripId" :arrival="arrival" />
      </TransitionGroup>

      <p v-else-if="data && data.arrivals.length === 0" class="screen__empty">
        No hay más salidas programadas por hoy.
      </p>

      <p v-else-if="error && !hasEverLoaded" class="screen__empty screen__empty--error">
        No se pudo cargar la información de salidas.
      </p>

      <p v-else class="screen__empty">Cargando información de salidas…</p>
    </main>

    <footer class="screen__footer">Bus interno de la Universidad de Costa Rica — bus.ucr.ac.cr</footer>
  </div>
</template>

<style scoped>
.screen {
  height: 100vh;
  width: 100vw;
  display: flex;
  flex-direction: column;
  padding: clamp(1.25rem, 3vw, 3rem);
  gap: clamp(0.75rem, 1.6vw, 1.5rem);
}

.screen__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.5rem;
  flex-wrap: wrap;
}

.screen__route {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.screen__route-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-weight: 800;
  font-size: clamp(1rem, 1.8vw, 1.4rem);
  letter-spacing: 0.04em;
  padding: 0.4em 0.9em;
  border-radius: 0.6em;
  background: var(--color-blue-600);
  color: #fff;
}

.screen__stop-name {
  margin: 0;
  font-size: clamp(2.4rem, 5vw, 4.2rem);
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1;
}

.screen__clock-block {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.6rem;
}

.screen__clock {
  text-align: right;
}

.screen__clock-time {
  display: block;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: clamp(2.4rem, 5vw, 4.2rem);
  font-weight: 800;
}

.screen__clock-date {
  display: block;
  color: var(--color-ink-muted);
  font-size: clamp(0.9rem, 1.4vw, 1.2rem);
}

.screen__clock-refresh {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5em;
  margin-top: 0.35rem;
  color: var(--color-ink-faint);
  font-size: clamp(0.75rem, 1.1vw, 0.95rem);
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

.screen__board {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 1rem;
  padding: 0 clamp(1rem, 2vw, 2rem);
}

.arrival-list {
  position: relative;
}

.arrival-list-move,
.arrival-list-enter-active,
.arrival-list-leave-active {
  transition: opacity 0.4s ease, transform 0.4s ease;
}

.arrival-list-enter-from,
.arrival-list-leave-to {
  opacity: 0;
}

.arrival-list-enter-from {
  transform: translateY(-16px);
}

.arrival-list-leave-to {
  transform: translateY(16px);
}

/* Takes the leaving row out of normal flow so the remaining rows can smoothly
   slide into its place (the standard Vue TransitionGroup list-removal technique). */
.arrival-list-leave-active {
  position: absolute;
  width: 100%;
}

.screen__empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-ink-muted);
  font-size: clamp(1.2rem, 2vw, 1.8rem);
  text-align: center;
}

.screen__empty--error {
  color: var(--color-error);
}

.screen__footer {
  text-align: center;
  color: var(--color-ink-faint);
  font-size: clamp(0.75rem, 1vw, 0.95rem);
}
</style>
