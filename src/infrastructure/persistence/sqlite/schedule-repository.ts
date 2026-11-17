import { formatTime, makeSchedule, type Schedule } from '../../../domain/schedule.js'
import type { Database } from './database.js'
import { inTransaction } from './transaction.js'

/** A schedule with the id the user refers to (`msum schedule rm <id>`). */
export interface StoredSchedule {
  readonly id: number
  readonly schedule: Schedule
}

/**
 * The schedules of the accounts, in `app.db` (RF-60, RF-61). The CLI and the daemon are different processes with their
 * own connections: a change made by one is seen by the other on its next read, which is how the daemon applies it
 * without a restart.
 *
 * It sits next to the account registry and is used by `main/` only. No use case of `application/` reads schedules (the
 * daemon, which is composition, decides when to run a digest), so there is no port for it; one is added the day a use
 * case needs it.
 *
 * A row that does not hold a valid schedule (written by hand) is not returned: it can never make the scheduler throw.
 */
export class SqliteScheduleRepository {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** The schedules of one account, in the order they were created. */
  list(accountId: string): StoredSchedule[] {
    const rows = this.db
      .prepare('SELECT id, days, time FROM schedules WHERE account_id = ? ORDER BY id')
      .all(accountId) as { id: number; days: string; time: string }[]
    const found: StoredSchedule[] = []
    for (const row of rows) {
      const made = makeSchedule(
        row.days === '' ? [] : row.days.split(',').map((day) => (/^\d$/.test(day) ? Number(day) : -1)),
        row.time,
      )
      if (made.ok) found.push({ id: Number(row.id), schedule: made.value })
    }
    return found
  }

  /** Adds a schedule to an account and returns its id. The account must be registered. */
  add(accountId: string, schedule: Schedule): number {
    const result = this.db
      .prepare('INSERT INTO schedules (account_id, days, time, created_at) VALUES (?, ?, ?, ?)')
      .run(accountId, schedule.days.join(','), formatTime(schedule), new Date(this.now()).toISOString())
    return Number(result.lastInsertRowid)
  }

  /** Removes a schedule of THIS account. False when the account has no schedule with that id (another account's is not touched). */
  remove(accountId: string, id: number): boolean {
    const result = this.db.prepare('DELETE FROM schedules WHERE id = ? AND account_id = ?').run(id, accountId)
    return Number(result.changes) > 0
  }

  /**
   * Imports the schedules of the configuration, once per account: when the account was not imported yet it inserts
   * `schedules` and marks it, in one transaction, and returns true. Afterwards it does nothing and returns false.
   */
  importOnce(accountId: string, schedules: readonly Schedule[]): boolean {
    return inTransaction(this.db, () => {
      const row = this.db.prepare('SELECT schedules_imported AS done FROM accounts WHERE id = ?').get(accountId) as
        | { done: number }
        | undefined
      if (row === undefined || row.done === 1) return false
      for (const schedule of schedules) this.add(accountId, schedule)
      this.db.prepare('UPDATE accounts SET schedules_imported = 1 WHERE id = ?').run(accountId)
      return true
    })
  }

  /** Whether the configuration schedules of this account were imported already. */
  imported(accountId: string): boolean {
    const row = this.db.prepare('SELECT schedules_imported AS done FROM accounts WHERE id = ?').get(accountId) as
      | { done: number }
      | undefined
    return row?.done === 1
  }
}
