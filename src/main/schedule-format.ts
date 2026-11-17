import type { Weekday } from '../domain/schedule.js'
import type { Catalog } from '../infrastructure/i18n/index.js'

/** The days of a schedule for the user: "every day", "weekdays", "weekends" or the names, Monday first. */
export function describeDays(texts: Catalog['cli']['schedule'], days: readonly Weekday[]): string {
  const key = [...days].sort((a, b) => a - b).join()
  if (key === '0,1,2,3,4,5,6') return texts.everyDay
  if (key === '1,2,3,4,5') return texts.workdays
  if (key === '0,6') return texts.weekend
  const mondayFirst = [1, 2, 3, 4, 5, 6, 0].filter((day) => days.includes(day as Weekday))
  return mondayFirst.map((day) => texts.dayName(day)).join(', ')
}
