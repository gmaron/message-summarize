import { err, ok, type Result } from './result.js'

/** A day of the week as cron numbers it: 0 is Sunday, 6 is Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export const ALL_WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6]
/** Monday to Friday. */
export const WORKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5]
export const WEEKEND: readonly Weekday[] = [6, 0]

/**
 * When a digest runs (RF-60): on some days of the week, at a local wall-clock time. The time zone is not part of it:
 * it belongs to the account (RF-62), so the same schedule follows the account's daylight saving changes.
 * `days` is never empty, sorted and without repeats; `hour` is 0..23 and `minute` 0..59.
 */
export interface Schedule {
  readonly days: readonly Weekday[]
  readonly hour: number
  readonly minute: number
}

export type ScheduleIssue = 'noDays' | 'invalidDay' | 'invalidTime'

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** "07:30" or "7:30" as hour and minute, or null. */
export function parseTime(text: string): { readonly hour: number; readonly minute: number } | null {
  const match = TIME.exec(text.trim())
  return match === null ? null : { hour: Number(match[1]), minute: Number(match[2]) }
}

/** The time of a schedule as "HH:MM". */
export function formatTime(schedule: Pick<Schedule, 'hour' | 'minute'>): string {
  return `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
}

const isWeekday = (value: number): value is Weekday => Number.isInteger(value) && value >= 0 && value <= 6

/** Builds a schedule, checking it: at least one day, every day 0..6, a real time. */
export function makeSchedule(days: Iterable<number>, time: string): Result<Schedule, ScheduleIssue> {
  const set = new Set<number>()
  for (const day of days) {
    if (!isWeekday(day)) return err('invalidDay')
    set.add(day)
  }
  if (set.size === 0) return err('noDays')
  const parsed = parseTime(time)
  if (parsed === null) return err('invalidTime')
  return ok({ days: [...set].sort((a, b) => a - b) as Weekday[], ...parsed })
}

/**
 * The cron expression the scheduler runs: minute, hour, any day of the month, any month, the days of the week.
 *
 * Daylight saving (RF-62) is the scheduler's job, in the account's time zone, and is pinned by tests: the local time
 * stays the same across a clock change; a time that does not exist that day (02:30 when the clock jumps from 02:00 to
 * 03:00) runs once at the first valid time after the gap; a time that happens twice runs once, at the first.
 */
export function scheduleToCron(schedule: Schedule): string {
  const days = schedule.days.length === 7 ? '*' : schedule.days.join(',')
  return `${schedule.minute} ${schedule.hour} * * ${days}`
}

const DAY_NAMES: Readonly<Record<string, number>> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

/** A cron day of the week (number 0..7 or an English abbreviation) as a number, 7 being Sunday too. */
function cronDay(text: string): number | null {
  if (/^\d$/.test(text)) return Number(text) <= 7 ? Number(text) : null
  return DAY_NAMES[text.toLowerCase()] ?? null
}

/**
 * The schedule a cron expression stands for, when it is one: a fixed minute and hour, any day of the month and any
 * month, and any list or range of days of the week. Anything else (steps, several times, a day of the month, a month,
 * nicknames, a seconds field) is not representable and gives null.
 */
export function cronToSchedule(expression: string): Schedule | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null
  // `?` ("no specific day") is a star in the day-of-month field.
  if ((dayOfMonth !== '*' && dayOfMonth !== '?') || month !== '*') return null
  const days = new Set<number>()
  if (dayOfWeek === '*') for (const day of ALL_WEEKDAYS) days.add(day)
  else {
    for (const item of dayOfWeek.split(',')) {
      const range = /^([^-]+)(?:-([^-]+))?$/.exec(item)
      if (range === null) return null
      const from = cronDay(range[1] as string)
      // `sun` at the END of a range is the seventh day (`mon-sun`), as `7` is.
      const endsOnSunday = range[2] !== undefined && range[2].toLowerCase() === 'sun' && from !== null && from > 0
      const to = endsOnSunday ? 7 : range[2] === undefined ? from : cronDay(range[2])
      if (from === null || to === null || from > to) return null
      for (let day = from; day <= to; day++) days.add(day % 7)
    }
  }
  const made = makeSchedule(days, `${hour}:${minute.padStart(2, '0')}`)
  return made.ok ? made.value : null
}

/**
 * One schedule per distinct time, with the union of the days of every schedule at that time, ordered by time. Two
 * schedules at 07:00 on different days are the single job "07:00 on both days", so the scheduler never has two jobs
 * that fire at the same instant.
 */
export function mergeByTime(schedules: readonly Schedule[]): Schedule[] {
  const byTime = new Map<string, { hour: number; minute: number; days: Set<number> }>()
  for (const { days, hour, minute } of schedules) {
    const key = `${hour}:${minute}`
    const entry = byTime.get(key) ?? { hour, minute, days: new Set<number>() }
    for (const day of days) entry.days.add(day)
    byTime.set(key, entry)
  }
  return [...byTime.values()]
    .sort((a, b) => a.hour - b.hour || a.minute - b.minute)
    .map(({ hour, minute, days }) => ({ days: [...days].sort((a, b) => a - b) as Weekday[], hour, minute }))
}

/** True when two schedules run at the same times. */
export const sameSchedule = (a: Schedule, b: Schedule): boolean =>
  a.hour === b.hour && a.minute === b.minute && a.days.join() === b.days.join()
