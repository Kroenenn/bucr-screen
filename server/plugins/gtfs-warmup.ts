import { warmGtfsData } from '../utils/gtfs'

/**
 * Loads the GTFS feed at server start rather than on the first request, so a
 * cold start with no cache and no network (a Pi booting before its Wi-Fi
 * associates) resolves before anyone looks at the screen instead of showing
 * a 503.
 *
 * Non-blocking and never fatal — `getGtfsData()` still loads on demand, so a
 * failure here only costs the first request.
 */
export default defineNitroPlugin(() => {
  warmGtfsData()
    .then(() => console.info('[gtfs] warmup complete'))
    .catch(err => console.warn('[gtfs] warmup failed, will retry on first request:', err))
})
