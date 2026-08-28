<script setup lang="ts">
import type { Arrival } from '../../shared/types'

const props = defineProps<{
  arrival: Arrival
}>()

const state = computed(() => {
  // "ABORDANDO" (boarding), not "arriving": this screen only shows boardable
  // departures, so "arriving" would read as a bus pulling *into* the stop —
  // exactly the trips filtered out. etaMinutes === 0 means it's here now.
  if (props.arrival.etaMinutes === 0) return { label: 'ABORDANDO', tone: 'now' }
  if (props.arrival.etaMinutes <= 3) return { label: 'PRÓXIMO', tone: 'soon' }
  return { label: '', tone: 'later' }
})

// MBTA's Real-Time Display Guidelines (see demo-mode.ts): once a countdown
// reaches 60 minutes, switch from a raw minute count to hours + minutes —
// "104 min" is harder to read at a glance than "1 h 44 min".
const etaDisplay = computed(() => {
  const m = props.arrival.etaMinutes
  if (m < 60) return { hours: 0, minutes: m }
  return { hours: Math.floor(m / 60), minutes: m % 60 }
})

// est-badge-only: the green "estimado" pill is the sole estimated-data
// marker on this board, so the older "HH:MM → ~HH:MM" scheduled prefix is
// intentionally not shown.

// 🕐 scheduled-minutes glyph: non-estimated countdown rows with a numeric
// minutes value (not departing, not "ahora"/boarding, not estimated) get a
// small clock glyph before the number — estimated rows show the green pill
// instead, so the two markers never coexist on the same row.
const showSchedGlyph = computed(() =>
  !props.arrival.departing
  && !props.arrival.estimated
  && props.arrival.etaMinutes > 0
)
</script>

<template>
  <div
    class="arrival-row"
    :class="arrival.departing ? 'arrival-row--departing' : `arrival-row--${state.tone}`"
  >
    <div class="arrival-row__destination">
      <span class="arrival-row__headsign">{{ arrival.headsign }}</span>
      <span
        v-if="arrival.viaMilla"
        class="arrival-row__badge"
      >con milla</span>
      <span
        v-if="arrival.estimated"
        class="arrival-row__badge arrival-row__badge--estimated"
      >
        <span class="arrival-row__badge-dot" />
        estimado
      </span>
    </div>

    <span
      v-if="arrival.departing"
      class="arrival-row__departing"
    >
      <span class="arrival-row__departing-dot" />
      SALIENDO
    </span>
    <template v-else>
      <span
        v-if="state.label"
        class="arrival-row__state"
      >{{ state.label }}</span>
      <span class="arrival-row__eta">
        <span
          v-if="showSchedGlyph"
          class="arrival-row__sched-glyph"
        >🕐</span>
        <template v-if="arrival.etaMinutes === 0">ahora</template>
        <template v-else-if="etaDisplay.hours === 0">
          {{ etaDisplay.minutes }}<span class="arrival-row__eta-unit">min</span>
        </template>
        <template v-else>
          {{ etaDisplay.hours }}<span class="arrival-row__eta-unit">h</span><template v-if="etaDisplay.minutes > 0">{{ ' ' }}{{ etaDisplay.minutes }}<span class="arrival-row__eta-unit">min</span></template>
        </template>
      </span>
    </template>
  </div>
</template>

<style scoped>
/* Sized in cqh/cqi (query-container units, set on .screen__board in
   index.vue) rather than vh/vw: the board's height already accounts for
   whatever the header/footer/status-bar chrome took, so rows scaling off
   it — not the raw viewport — is what keeps `maxArrivals` rows filling the
   board with no scroll and no clipped last row. */
.arrival-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: baseline;
  gap: clamp(1rem, 3cqi, 2rem);
  padding: clamp(0.5rem, 4cqh, 2.1rem) 0;
  border-bottom: 1px solid var(--color-border);
}

.arrival-row:last-child {
  border-bottom: none;
}

/* The whole row blinks during the departing grace period — not just the
   small dot next to "SALIENDO" — so the row's imminent removal from the
   list reads as a warned countdown, not a sudden disappearance. */
.arrival-row--departing {
  animation: arrival-row-pulse 1.6s ease-in-out infinite;
}

.arrival-row__destination {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.6em;
  min-width: 0;
}

.arrival-row__headsign {
  font-size: clamp(1.6rem, 9.5cqh, 4.6rem);
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--color-ink);
}

/* Neutral/subtle on purpose — informational, not an attention color like
   the amber "live"/"departing" language elsewhere on this row. Matches
   infobus-web's own "con milla" badge treatment. */
.arrival-row__badge {
  font-family: var(--font-mono);
  font-size: clamp(0.75rem, 2.2cqh, 1rem);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--color-ink-muted);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 0.25em 0.75em;
  white-space: nowrap;
}

/* Green like ModeBadge's "EN VIVO" pill (--color-ok) — this row's eta came
   from a real-time terminus prediction, not the static timetable, so it
   borrows the same "live" color language rather than inventing a new one.
   Distinct from the neutral "con milla" badge above it, and from the
   amber "PRÓXIMO"/"SALIENDO" attention language, which means something
   different (urgency, not data provenance). */
.arrival-row__badge--estimated {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  color: var(--color-ok);
  border-color: rgba(53, 201, 140, 0.35);
  background: rgba(53, 201, 140, 0.08);
}

.arrival-row__badge-dot {
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: var(--color-ok);
  animation: arrival-row-pulse 1.6s ease-in-out infinite;
}

.arrival-row__state {
  font-family: var(--font-mono);
  font-size: clamp(0.85rem, 3.4cqh, 1.6rem);
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--color-accent-text);
}

.arrival-row--now .arrival-row__eta {
  color: var(--color-accent-text);
}

/* scheduled-minutes glyph: only rendered when showSchedGlyph is true (a
   non-estimated countdown row), so the element simply doesn't exist on
   estimated/departing rows. */
.arrival-row__sched-glyph {
  font-size: 0.5em;
  margin-right: 0.35em;
  opacity: 0.8;
  font-family: var(--font-sans);
}

.arrival-row__eta {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: clamp(2.2rem, 12cqh, 6rem);
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
  font-size: clamp(1.3rem, 6.5cqh, 3rem);
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
