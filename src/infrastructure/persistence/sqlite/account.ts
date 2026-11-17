import type { AccountIdentity } from '../../../application/ports/account-identity.js'
import type { Database } from './database.js'

/** The AccountIdentity port on SQLite: one row in `account`, written once. */
export class SqliteAccountIdentity implements AccountIdentity {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  get(): string | null {
    const row = this.db.prepare('SELECT jid FROM account WHERE id = 1').get() as { jid: string } | undefined
    return row?.jid ?? null
  }

  bind(id: string): boolean {
    if (id === '') throw new RangeError('the account id is empty')
    // A single statement: it inserts only when there is no row, so two connections cannot both bind.
    this.db
      .prepare('INSERT INTO account (id, jid, linked_at) VALUES (1, ?, ?) ON CONFLICT (id) DO NOTHING')
      .run(id, this.now())
    return this.get() === id
  }
}
