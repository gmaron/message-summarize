/** A date and time in a time zone (the account's), in the locale of the page. A zone the browser does not know is ignored. */
/** True for the zones that are UTC itself (what a container has when no zone is set). */
export const isUtcZone = (zone: string): boolean => zone === 'UTC' || zone === 'Etc/UTC' || zone === 'Etc/UCT'

export function formatDateTime(epochMs: number, timezone: string, locale: string): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone }).format(epochMs)
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(epochMs)
  }
}

/** The name of a day of the week (0 is Sunday) in the locale of the page. */
export function weekdayName(day: number, locale: string, style: 'short' | 'long' | 'narrow'): string {
  // 7 January 2024 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(Date.UTC(2024, 0, 7 + day))
}

/** A percentage of progress as a whole number from 0 to 100, or null when the value is not a number (unknown progress). */
export function percentOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, Math.round(value)))
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** The calendar day of a moment in a zone, as a number of days (so two moments can be compared by day). */
function dayNumber(epochMs: number, timezone: string): number {
  const parts = (zone: string | undefined) =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(zone ? { timeZone: zone } : {}),
    })
      .format(epochMs)
      .split('-')
      .map(Number)
  let numbers: number[]
  try {
    numbers = parts(timezone)
  } catch {
    numbers = parts(undefined)
  }
  return Math.floor(Date.UTC(numbers[0] ?? 1970, (numbers[1] ?? 1) - 1, numbers[2] ?? 1) / 86_400_000)
}

/** The time of day in a zone: "9:00", "19:30" (24 hours, with no zero before the hour). */
export function formatTime(epochMs: number, timezone: string, locale: string): string {
  const options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }
  let text: string
  try {
    text = new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone }).format(epochMs)
  } catch {
    text = new Intl.DateTimeFormat(locale, options).format(epochMs)
  }
  return text.replace(/^0(?=\d:)/, '')
}

/**
 * The day of a moment for a person: today, yesterday and tomorrow by name, a nearby day by its weekday and number,
 * the rest by its date. Words come from the browser's own calendar data (`Intl`), in the language of the page.
 */
export function dayName(epochMs: number, timezone: string, locale: string, now: number): string {
  const diff = dayNumber(epochMs, timezone) - dayNumber(now, timezone)
  if (Math.abs(diff) <= 1) return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(diff, 'day')
  const options: Intl.DateTimeFormatOptions =
    Math.abs(diff) < 7 ? { weekday: 'short', day: 'numeric' } : { day: 'numeric', month: 'short' }
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone }).format(epochMs)
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(epochMs)
  }
}

/** "Today", "Yesterday", "Thu 20": the chip over a message. */
export const dayChip = (epochMs: number, timezone: string, locale: string, now: number): string =>
  capitalize(dayName(epochMs, timezone, locale, now))

/** "today 19:00", "tomorrow 9:00": when something happens, short. */
export const whenText = (epochMs: number, timezone: string, locale: string, now: number): string =>
  `${dayName(epochMs, timezone, locale, now)} ${formatTime(epochMs, timezone, locale)}`

/** The same with the first letter up: "Today 9:00". */
export const whenTitle = (epochMs: number, timezone: string, locale: string, now: number): string =>
  capitalize(whenText(epochMs, timezone, locale, now))
