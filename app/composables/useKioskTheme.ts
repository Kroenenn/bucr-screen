/**
 * Kiosk screens default to dark (readable from across a room) independent
 * of any system/browser preference — so this is a deliberate manual toggle,
 * not `prefers-color-scheme`. `useState` (resets on reload, not persisted)
 * so a display power-cycling always comes back dark rather than remembering
 * whatever a previous visitor left it on — same rationale as infobus-web's
 * feat/bucr-static-site useKioskTheme.
 *
 * Writes the choice onto `<html data-theme>` (not a class on some inner
 * element) so main.css's `:root[data-theme='light']` override reaches the
 * page background/color too, not just the content inside one container.
 */
export function useKioskTheme() {
  const theme = useState<'dark' | 'light'>('kiosk-theme', () => 'dark')

  useHead({
    htmlAttrs: { 'data-theme': theme }
  })

  function toggle() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  return { theme, toggle }
}
