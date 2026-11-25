import { type Schedule, scheduleToCron, type Weekday } from '../../domain/schedule.js'
import type { Catalog } from '../../infrastructure/i18n/index.js'
import { nextRunOf } from '../../infrastructure/scheduling/croner-scheduler.js'

/** When a schedule runs next after `now` (epoch ms), in the time zone of the account, or null. */
export function nextRunAt(schedule: Schedule, timezone: string, now: number): number | null {
  return nextRunOf(scheduleToCron(schedule), timezone, new Date(now))?.getTime() ?? null
}

/** The soonest next run among the schedules, or null when there are none. */
export function earliestNextRun(schedules: readonly Schedule[], timezone: string, now: number): number | null {
  const times = schedules.map((schedule) => nextRunAt(schedule, timezone, now)).filter((t): t is number => t !== null)
  return times.length === 0 ? null : Math.min(...times)
}

/** The days of a schedule for the user: "every day", "weekdays", "weekends" or the names, Monday first. */
export function describeDays(texts: Catalog['cli']['schedule'], days: readonly Weekday[]): string {
  const key = [...days].sort((a, b) => a - b).join()
  if (key === '0,1,2,3,4,5,6') return texts.everyDay
  if (key === '1,2,3,4,5') return texts.workdays
  if (key === '0,6') return texts.weekend
  const mondayFirst = [1, 2, 3, 4, 5, 6, 0].filter((day) => days.includes(day as Weekday))
  return mondayFirst.map((day) => texts.dayName(day)).join(', ')
}
