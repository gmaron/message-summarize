import { isValidAccountId } from '../../../domain/account-id.js'
import { type Database, openDatabase } from './database.js'
import type { Migration } from './migrations.js'

/** Platforms an account can belong to. A new platform is a new value here, with no migration. */
export type AccountPlatform = 'whatsapp'
const PLATFORMS: readonly string[] = ['whatsapp']

export interface AccountRecord {
  readonly id: string
  readonly platform: AccountPlatform
  /** ISO 8601, UTC. */
  readonly createdAt: string
}

/**
 * Migrations of `app.db`, the installation-wide database (RNF-16). It has its own `schema_version`, separate from
 * the databases of the accounts. It never holds messages: only what the installation itself needs to know.
 */
export const APP_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'Accounts of the installation',
    sql: `
-- One row per account. The data of an account lives in accounts/<id>/; this table says which accounts exist.
CREATE TABLE accounts (
  id         TEXT PRIMARY KEY CHECK (id <> ''),
  platform   TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
]

/** Opens (creating it when missing) the installation database: 0600, WAL, migrated. */
export function openAppDatabase(path: string): Database {
  return openDatabase(path, { migrations: APP_MIGRATIONS })
}

/**
 * The accounts of the installation, in `app.db`. A row whose id is not a valid account id (written by hand, or by a
 * newer program) is never returned as an account, because an id becomes a path: `invalidIds` lists those rows so
 * `doctor` can report them.
 */
export class SqliteAccountRegistry {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** Valid accounts, ordered by id. */
  list(): AccountRecord[] {
    const rows = this.db.prepare('SELECT id, platform, created_at FROM accounts ORDER BY id').all() as {
      id: string
      platform: string
      created_at: string
    }[]
    return rows
      .filter((row) => isValidAccountId(row.id) && PLATFORMS.includes(row.platform))
      .map((row) => ({ id: row.id, platform: row.platform as AccountPlatform, createdAt: row.created_at }))
  }

  /** Rows that are not valid accounts: an invalid id or an unknown platform. */
  invalidIds(): string[] {
    const rows = this.db.prepare('SELECT id, platform FROM accounts ORDER BY id').all() as {
      id: string
      platform: string
    }[]
    return rows.filter((row) => !isValidAccountId(row.id) || !PLATFORMS.includes(row.platform)).map((row) => row.id)
  }

  has(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id) !== undefined
  }

  /** Registers an account. Returns false when it was already registered (nothing changes). */
  register(id: string, platform: AccountPlatform = 'whatsapp'): boolean {
    if (!isValidAccountId(id)) throw new RangeError('invalid account id')
    const result = this.db
      .prepare('INSERT INTO accounts (id, platform, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING')
      .run(id, platform, new Date(this.now()).toISOString())
    return Number(result.changes) > 0
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }
}
