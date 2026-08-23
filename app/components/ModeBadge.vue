<script setup lang="ts">
import type { ArrivalSource } from '../../shared/types'

const props = defineProps<{
  source: ArrivalSource
}>()

// "EN VIVO" covers both genuinely-live data and the automatic schedule
// fallback: a distinct fallback badge reads as alarming to a general
// audience. The distinction isn't hidden, just moved — the API response
// still reports source/realtimeFallback, and index.vue marks an active
// fallback next to the refresh caption. Demo must stay visibly distinct.
const label = computed(() => (props.source === 'demo' ? 'DEMO' : 'EN VIVO'))
const tone = computed(() => (props.source === 'demo' ? 'demo' : 'live'))
</script>

<template>
  <span
    class="mode-badge"
    :class="`mode-badge--${tone}`"
  >
    <span
      v-if="tone === 'live'"
      class="mode-badge__dot"
    />
    {{ label }}
  </span>
</template>

<style scoped>
.mode-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.5em;
  font-family: var(--font-mono);
  font-weight: 600;
  letter-spacing: 0.12em;
  font-size: clamp(0.9rem, 1.4vw, 1.3rem);
  padding: 0.35em 0.85em;
  border-radius: 999px;
  border: 1px solid var(--color-border);
}

.mode-badge--live {
  color: var(--color-ok);
  border-color: rgba(53, 201, 140, 0.35);
  background: rgba(53, 201, 140, 0.08);
}

/* Deliberately not amber (the "live/attention" color) — a demo must never
   be visually mistaken for real live data if left running by accident. */
.mode-badge--demo {
  color: var(--color-blue-400);
  border-color: rgba(92, 161, 214, 0.4);
  background: rgba(92, 161, 214, 0.1);
}

.mode-badge__dot {
  width: 0.6em;
  height: 0.6em;
  border-radius: 50%;
  background: var(--color-ok);
  animation: pulse 1.6s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
</style>
