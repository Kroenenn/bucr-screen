/**
 * Ticks once a second. Renders using the browser's own local time/locale —
 * on the kiosk Pi that's expected to be Costa Rica time (see
 * deploy/raspberry-pi/README.md for setting the device timezone correctly).
 * `useState` (not a ref) so a client-side navigation wouldn't restart it,
 * though this app currently only has the one page.
 */
export function useKioskClock() {
  const now = useState<Date>('kiosk-clock', () => new Date())

  if (import.meta.client) {
    const interval = setInterval(() => {
      now.value = new Date()
    }, 1000)
    onScopeDispose(() => clearInterval(interval))
  }

  const time = computed(() =>
    now.value.toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit', hour12: false })
  )
  // Keyed on the calendar day, not on `now` directly: the displayed date
  // changes once a day, so depending on the raw tick would re-run
  // toLocaleDateString 86,400 times a day for a value that changes once.
  const dayKey = computed(() => now.value.toDateString())
  const date = computed(() => {
    // toLocaleDateString gives "sábado, 22 de agosto" — capitalize only the
    // leading letter (CSS text-transform: capitalize would wrongly title-case
    // "de" too, which isn't how Spanish dates are written).
    const raw = new Date(dayKey.value).toLocaleDateString('es-CR', { weekday: 'long', day: 'numeric', month: 'long' })
    return raw.charAt(0).toUpperCase() + raw.slice(1)
  })

  // `now` is exported so other computeds can depend on the tick and stay
  // reactive to the passage of time — see index.vue's `isStale`, which
  // otherwise silently caches forever (a plain `Date.now()` call inside a
  // computed is not a reactive dependency).
  return { now, time, date }
}
