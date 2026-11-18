import { chmodSync, closeSync, existsSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, type Migration, migrate } from './migrations.js'

/** The connection type of this adapter. Nothing outside `infrastructure/persistence/sqlite` should need it. */
export type Database = DatabaseSync

export interface OpenDatabaseOptions {
  /** Milliseconds a statement waits for a lock held by another connection. Default 5000. */
  readonly busyTimeoutMs?: number
  /** Replaces the migration list. For tests of the migration runner only. */
  readonly migrations?: readonly Migration[]
}

const OWNER_ONLY = 0o600

/** The -wal and -shm files hold message content too: owner only, like the main file (RNF-04). */
function tightenSideFiles(path: string): void {
  if (process.platform === 'win32') return
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(path + suffix)) chmodSync(path + suffix, OWNER_ONLY)
  }
}

/**
 * Opens (creating it when missing) the database file of ONE account and brings its schema up to date.
 * The caller decides the path (the composition root, one file per account).
 *
 * - The file is created with permissions 0600 and tightened to 0600 when it already existed (RNF-04), and so are
 *   existing `-wal` and `-shm` files (SQLite gives new ones the mode of the main file). Windows has no POSIX modes: there the call is a no-op.
 * - WAL journal (RNF-08), foreign keys on, busy timeout.
 * - Pending migrations run before this returns (RNF-16).
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  if (!existsSync(path)) closeSync(openSync(path, 'a', OWNER_ONLY))
  if (process.platform !== 'win32') chmodSync(path, OWNER_ONLY)
  tightenSideFiles(path)
  const db = new DatabaseSync(path)
  try {
    // The busy timeout goes first: switching to WAL needs a lock too.
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 5000)}`)
    const mode = (db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string }).journal_mode
    if (mode.toLowerCase() !== 'wal') throw new Error(`Could not switch the database to WAL (journal mode is ${mode})`)
    db.exec('PRAGMA foreign_keys = ON')
    tightenSideFiles(path)
    migrate(db, options.migrations ?? MIGRATIONS)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}
