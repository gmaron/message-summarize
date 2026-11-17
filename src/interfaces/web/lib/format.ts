/** A date and time in a time zone (the account's), in the locale of the page. A zone the browser does not know is ignored. */
export function formatDateTime(epochMs: number, timezone: string, locale: string): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone }).format(epochMs)
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(epochMs)
  }
}

/** The name of a day of the week (0 is Sunday) in the locale of the page. */
export function weekdayName(day: number, locale: string, style: 'short' | 'long'): string {
  // 7 January 2024 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(Date.UTC(2024, 0, 7 + day))
}
