/**
 * URL-gated visual variant switch. `?board=synth7-zebra` (case-insensitive)
 * opts the kiosk into the "synth-weekday-est + zebra" look — everyone else
 * (no param, the normal live kiosk) renders exactly as before.
 *
 * `useState` keyed on the route query (read once, on first use) rather than
 * a live `computed` off `useRoute().query`: the query is identical on server
 * and client for a given URL, so seeding `useState` from it round-trips
 * through the Nuxt payload the same way `useKioskTheme`/`useKioskClock` do —
 * no hydration mismatch, and no risk of the variant flipping mid-session if
 * something downstream ever mutates the query.
 *
 * Mirrors `useKioskTheme`: writes the active variant onto `<html data-board>`
 * so main.css can key global variant CSS off `:root[data-board='synth7-zebra']`
 * and reach both the header (index.vue) and the rows (ArrivalRow.vue) without
 * fighting Vue's scoped-style boundaries.
 */
export type BoardVariant = 'synth7-zebra' | null

const SYNTH7_ZEBRA = 'synth7-zebra'

export function useBoardVariant() {
  const route = useRoute()

  const variant = useState<BoardVariant>('board-variant', () => {
    const raw = route.query.board
    const value = Array.isArray(raw) ? raw[0] : raw
    return typeof value === 'string' && value.toLowerCase() === SYNTH7_ZEBRA ? SYNTH7_ZEBRA : null
  })

  const isSynth7Zebra = computed(() => variant.value === SYNTH7_ZEBRA)

  useHead({
    htmlAttrs: { 'data-board': variant }
  })

  return { variant, isSynth7Zebra }
}
