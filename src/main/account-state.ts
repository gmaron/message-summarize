import { existsSync } from 'node:fs'
import { openDatabase, SqliteAccountIdentity } from '../infrastructure/persistence/sqlite/index.js'
import { type Blocked, readBlocked } from './blocked.js'
import { hasSession, maskAccount } from './context.js'
import type { AccountLayout } from './paths.js'

export interface AccountState {
  /** The account is bound in its database and its session is registered. */
  readonly linked: boolean
  /** The bound number, masked (see `maskAccount`): never the full number. Null when nothing is bound. */
  readonly masked: string | null
  readonly blocked: Blocked | null
}

/**
 * What `accounts` and `status` say about one account, read without a configuration and without creating anything:
 * with no database yet the account is simply not linked.
 */
export async function readAccountState(account: AccountLayout): Promise<AccountState> {
  let bound: string | null = null
  if (existsSync(account.dbFile)) {
    const db = openDatabase(account.dbFile)
    try {
      bound = new SqliteAccountIdentity(db).get()
    } finally {
      db.close()
    }
  }
  return {
    linked: bound !== null && (await hasSession(account)),
    masked: bound === null ? null : maskAccount(bound),
    blocked: await readBlocked(account.blockedFile),
  }
}
