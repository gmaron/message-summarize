import { cronToSchedule, type Schedule, sameSchedule } from '../../domain/schedule.js'
import type { Installation } from '../installation/accounts.js'
import type { AppConfig } from './config.js'

/** What importing the `schedules` of the configuration did for one account. */
export interface ScheduleImport {
  /** False when the account had been imported before: nothing was done. */
  readonly done: boolean
  readonly imported: number
}

/** The expressions of `schedules` that cannot be a `Schedule` (steps, several times, a day of the month...). */
export function unrepresentableCrons(config: Pick<AppConfig, 'schedules'>): string[] {
  return config.schedules.filter((expression) => cronToSchedule(expression) === null)
}

/**
 * Once per account, turns the `schedules` of its effective configuration into schedules in `app.db` (RF-60). The ones
 * that are not representable are not imported (`doctor` reports them). Afterwards the key is ignored, so a schedule the
 * user deletes later does not come back, and the configuration file is never rewritten.
 */
export function importConfigSchedules(
  installation: Installation,
  accountId: string,
  config: Pick<AppConfig, 'schedules'>,
): ScheduleImport {
  const found: Schedule[] = []
  for (const expression of config.schedules) {
    const schedule = cronToSchedule(expression)
    if (schedule !== null && !found.some((other) => sameSchedule(other, schedule))) {
      found.push(schedule)
    }
  }
  const done = installation.schedules.importOnce(accountId, found)
  return { done, imported: done ? found.length : 0 }
}
