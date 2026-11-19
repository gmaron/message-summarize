import { makeSchedule, type ScheduleIssue } from '../../../domain/schedule.js'
import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
import { ApiError } from './api.js'
import { weekdayName } from './format.js'
import { fmt } from './i18n.js'

/** Monday first, as the page shows the week; the API numbers the days from Sunday (0). */
export const UI_DAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0]
export const EVERY_DAY: readonly number[] = [0, 1, 2, 3, 4, 5, 6]
export const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5]

export interface ScheduleDraft {
  readonly days: readonly number[]
  readonly time: string
}

export const newDraft = (): ScheduleDraft => ({ days: EVERY_DAY, time: '09:00' })

const sorted = (days: readonly number[]): number[] => [...new Set(days)].sort((a, b) => a - b)

export function sameDays(a: readonly number[], b: readonly number[]): boolean {
  const left = sorted(a)
  const right = sorted(b)
  return left.length === right.length && left.every((day, index) => day === right[index])
}

/** The draft with a day switched on or off. */
export function toggleDay(draft: ScheduleDraft, day: number): ScheduleDraft {
  const days = draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day]
  return { ...draft, days: sorted(days) }
}

/** The days in the order the page shows them. */
export const inUiOrder = (days: readonly number[]): number[] => UI_DAY_ORDER.filter((day) => days.includes(day))

/** Checked as the daemon checks it (`makeSchedule`), so a mistake shows before the request. Null when it is fine. */
export function validateDraft(draft: ScheduleDraft): ScheduleIssue | null {
  const made = makeSchedule(draft.days, draft.time)
  return made.ok ? null : made.error
}

/** The issue code of a refused schedule (a 422 `invalidSchedule`), or null when the error is another. */
export function scheduleIssueOf(error: unknown): ScheduleIssue | null {
  if (!(error instanceof ApiError) || error.code !== 'invalidSchedule') return null
  const issue = error.issue
  return issue === 'noDays' || issue === 'invalidDay' || issue === 'invalidTime' ? issue : null
}

/** What a set of days is called when it has a name of its own. */
export function presetOf(days: readonly number[]): 'everyDay' | 'weekdays' | null {
  if (sameDays(days, EVERY_DAY)) return 'everyDay'
  if (sameDays(days, WEEKDAYS)) return 'weekdays'
  return null
}

/** The days of a schedule as a person reads them: "Every day", "Weekdays" or the short names in the page's order. */
export function dayLabel(days: readonly number[], texts: WebTexts): string {
  const preset = presetOf(days)
  if (preset !== null) return texts.ui.schedules[preset]
  return inUiOrder(days)
    .map((day) => weekdayName(day, texts.locale, 'short'))
    .join(texts.ui.text.listSeparator)
}

/** "9:00" for "09:00": the way the page says a time. */
export const shortTime = (time: string): string => time.replace(/^0(?=\d:)/, '')

/**
 * What the schedules say in one line: "Every day · 9:00 and 19:00". Schedules that do not share their days are listed
 * one by one ("9:00 Every day; 12:30 Weekdays"). Empty text when there are none.
 */
export function scheduleSummary(
  schedules: readonly { days: readonly number[]; time: string }[],
  texts: WebTexts,
): string {
  if (schedules.length === 0) return ''
  const sortedByTime = [...schedules].sort((a, b) => a.time.localeCompare(b.time))
  const first = sortedByTime[0]
  if (first !== undefined && sortedByTime.every((one) => sameDays(one.days, first.days))) {
    const times = sortedByTime.map((one) => shortTime(one.time))
    const joined =
      times.length === 1
        ? (times[0] ?? '')
        : `${times.slice(0, -1).join(texts.ui.text.listSeparator)} ${texts.ui.schedules.and} ${times[times.length - 1]}`
    return fmt(texts.ui.schedules.summary, { days: dayLabel(first.days, texts), times: joined })
  }
  return sortedByTime
    .map((one) => fmt(texts.ui.schedules.summaryItem, { time: shortTime(one.time), days: dayLabel(one.days, texts) }))
    .join(texts.ui.schedules.summarySeparator)
}
