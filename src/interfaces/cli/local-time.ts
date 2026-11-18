/** A wall-clock date and time with no zone, as typed by a person: "2026-11-17 09:30". */
export interface LocalDateTime {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
}

const PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/

/** Parses "YYYY-MM-DD HH:MM" (a "T" instead of the space is accepted). Null when it is not a real date and time. */
export function parseLocalDateTime(text: string): LocalDateTime | null {
  const match = PATTERN.exec(text.trim())
  if (match === null) return null
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number]
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute))
  const real =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute
  return real ? { year, month, day, hour, minute } : null
}

/** Offset of the zone from UTC at an instant, in ms (positive east of Greenwich). */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant))
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(instant / 1000) * 1000
}

/**
 * The instant (epoch ms) at which the clocks of `timeZone` show `local`. In the hour that does not exist (daylight
 * saving starts) it gives the instant just after the jump; in the hour that happens twice, the first one.
 */
export function zonedToEpoch(local: LocalDateTime, timeZone: string): number {
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)
  let guess = wall - offsetAt(wall, timeZone)
  // The offset at the first guess can differ from the one at the wall time near a change: correct once.
  guess = wall - offsetAt(guess, timeZone)
  return guess
}
