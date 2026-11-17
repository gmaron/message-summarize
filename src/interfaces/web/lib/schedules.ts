import { makeSchedule, type ScheduleIssue } from '../../../domain/schedule.js'
import { ApiError } from './api.js'

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
