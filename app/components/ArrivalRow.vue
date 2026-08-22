<script setup lang="ts">
import type { Arrival } from '../../shared/types'

const props = defineProps<{
  arrival: Arrival
}>()

const state = computed(() => {
  // "ABORDANDO" (boarding), not "arriving" — this screen only ever shows
  // boardable departures (see the direction_id filtering in PLAN.md), so
  // "arriving" reads as if a bus were arriving *at* Educación, which is
  // exactly what was deliberately excluded. MBTA's own "Boarding"/BRD is
  // the same concept: the vehicle is at the stop right now.
  if (props.arrival.etaMinutes === 0) return { label: 'ABORDANDO', tone: 'now' }
  if (props.arrival.etaMinutes <= 3) return { label: 'PRÓXIMO', tone: 'soon' }
  return { label: '', tone: 'later' }
})
</script>

<template>
  <div class="arrival-row" :class="arrival.departing ? 'arrival-row--departing' : `arrival-row--${state.tone}`">
    <div class="arrival-row__destination">
      <span class="arrival-row__headsign">{{ arrival.headsign }}</span>
      <span v-if="arrival.viaMilla" class="arrival-row__badge">con milla</span>
    </div>

    <span v-if="arrival.departing" class="arrival-row__departing">
      <span class="arrival-row__departing-dot" />
      SALIENDO
    </span>
    <template v-else>
      <span v-if="state.label" class="arrival-row__state">{{ state.label }}</span>
      <span class="arrival-row__eta">
        <template v-if="arrival.etaMinutes === 0">ahora</template>
        <template v-else>
          {{ arrival.etaMinutes }}<span class="arrival-row__eta-unit">min</span>
        </template>
      </span>
    </template>
  </div>
</template>

<style scoped>
.arrival-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: baseline;
  gap: clamp(1rem, 2vw, 2rem);
  padding: clamp(0.9rem, 1.8vw, 1.6rem) 0;
  border-bottom: 1px solid var(--color-border);
}

.arrival-row:last-child {
  border-bottom: none;
}

.arrival-row__destination {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.6em;
  min-width: 0;
}

.arrival-row__headsign {
  font-size: clamp(1.6rem, 3.4vw, 2.6rem);
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--color-ink);
}

/* Neutral/subtle on purpose — informational, not an attention color like
   the amber "live"/"departing" language elsewhere on this row. Matches
   infobus-web's own "con milla" badge treatment. */
.arrival-row__badge {
  font-family: var(--font-mono);
  font-size: clamp(0.75rem, 1.1vw, 1rem);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--color-ink-muted);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 0.25em 0.75em;
  white-space: nowrap;
}

.arrival-row__state {
  font-family: var(--font-mono);
  font-size: clamp(0.8rem, 1.2vw, 1.1rem);
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--color-accent-text);
}

.arrival-row--now .arrival-row__eta {
  color: var(--color-accent-text);
}

.arrival-row__eta {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: clamp(2.2rem, 4.4vw, 3.6rem);
  font-weight: 800;
  color: var(--color-ink);
  white-space: nowrap;
}

.arrival-row__eta-unit {
  font-size: 0.45em;
  margin-left: 0.25em;
  color: var(--color-ink-muted);
}

/* Replaces the state + eta columns entirely — a departed trip doesn't get
   a countdown any more, it gets a status word, same idea as MBTA's
   "Boarding"/"Arriving" replacing the number instead of sitting next to it. */
.arrival-row__departing {
  grid-column: 2 / 4;
  justify-self: end;
  display: inline-flex;
  align-items: center;
  gap: 0.6em;
  font-family: var(--font-mono);
  font-weight: 800;
  font-size: clamp(1.3rem, 2.4vw, 2rem);
  letter-spacing: 0.1em;
  color: var(--color-accent-text);
}

.arrival-row__departing-dot {
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: var(--color-amber-500);
  animation: arrival-row-pulse 1.6s ease-in-out infinite;
}

@keyframes arrival-row-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
</style>
