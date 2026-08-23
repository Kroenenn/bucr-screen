/**
 * Local-day math driven by the GTFS feed's own `agency_timezone`
 * (agency.txt), via the platform `Intl` API — not a hardcoded offset.
 * Costa Rica happens to be a fixed UTC-6 (no DST since 1992), so a
 * hardcoded constant would give the same numeric answer today, but it
 * wouldn't be *derived from the feed*, and would silently go stale if the
 * feed's agency or timezone ever changed. `Intl.DateTimeFormat` handles
 * DST correctly too, for whatever future feed/timezone ends up here.
 */

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

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** @param timeZone IANA timezone, e.g. `gtfs.agency?.timezone` ("America/Costa_Rica"). */
export function agencyLocalDay(epochSeconds: number, timeZone: string): LocalDay {
  const date = new Date(epochSeconds * 1000)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short'
  }).formatToParts(date)

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''

  const year = get('year')
  const month = get('month')
  const day = get('day')
  // Some engines format midnight as hour "24" under hour12: false.
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  const second = Number(get('second'))
  const weekday = WEEKDAY_INDEX[get('weekday')] ?? 0

  const secondsSinceMidnight = hour * 3600 + minute * 60 + second

  return {
    dateStr: `${year}${month}${day}`,
    weekday,
    secondsSinceMidnight,
    midnightEpochSeconds: epochSeconds - secondsSinceMidnight
  }
}
