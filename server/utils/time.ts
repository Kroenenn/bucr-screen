/**
 * Costa Rica has used a fixed UTC-6 offset (no DST) since 1992, so unlike
 * most timezone handling this can be a constant instead of an Intl lookup.
 * Kept explicit so nobody has to re-derive it when reading this code far
 * from Costa Rica.
 */
const COSTA_RICA_UTC_OFFSET_SECONDS = -6 * 3600

export interface LocalDay {
  /** GTFS date format, YYYYMMDD. */
  dateStr: string
  /** 0 = Sunday .. 6 = Saturday, matching Date.getUTCDay(). */
  weekday: number
  /** Seconds elapsed since local midnight. */
  secondsSinceMidnight: number
  /** The real (UTC) epoch second corresponding to local midnight of this day. */
  midnightEpochSeconds: number
}

export function costaRicaLocalDay(epochSeconds: number): LocalDay {
  const localEpoch = epochSeconds + COSTA_RICA_UTC_OFFSET_SECONDS
  const d = new Date(localEpoch * 1000)
  const secondsSinceMidnight = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()
  return {
    dateStr: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`,
    weekday: d.getUTCDay(),
    secondsSinceMidnight,
    midnightEpochSeconds: epochSeconds - secondsSinceMidnight,
  }
}
