/**
 * Liveness probe for the container healthcheck (see docker-compose.yml).
 *
 * Deliberately does NOT touch Databús or re-fetch the GTFS feed. A
 * healthcheck's job here is "is this process still serving requests, or has
 * it wedged" — not "is the upstream up." Reaching out to Databús every 30s
 * would both add pointless load to a service we don't control and, worse,
 * mark this container unhealthy (→ restart loop) exactly when the app is
 * doing the right thing: serving the static schedule while the live feed is
 * down. That fallback is the whole point of `real` mode.
 */
export default defineEventHandler((event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')

  return {
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    generatedAt: Math.floor(Date.now() / 1000)
  }
})
