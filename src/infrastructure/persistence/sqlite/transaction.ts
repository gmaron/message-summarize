import type { Database } from './database.js'

let savepoints = 0

/**
 * Runs `work` atomically. Outside a transaction it takes the write lock up front (BEGIN IMMEDIATE) and commits.
 * Inside one it is re-entrant: it opens a SAVEPOINT, so a failure undoes only this call's writes and the error goes
 * on to the caller. When `work` throws, the original error is the one that surfaces, even when SQLite already
 * rolled the transaction back by itself (then there is nothing left to roll back).
 */
export function inTransaction<T>(db: Database, work: () => T): T {
  if (db.isTransaction) {
    const name = `sp_${++savepoints}`
    db.exec(`SAVEPOINT ${name}`)
    try {
      const result = work()
      db.exec(`RELEASE ${name}`)
      return result
    } catch (error) {
      if (db.isTransaction) {
        db.exec(`ROLLBACK TO ${name}`)
        db.exec(`RELEASE ${name}`)
      }
      throw error
    }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}
