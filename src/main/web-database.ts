import { existsSync } from 'node:fs'
import { type Database, openDatabase } from '../infrastructure/persistence/sqlite/index.js'
import { HttpError } from '../interfaces/http/router.js'
import { isDirectory } from './accounts.js'
import type { CommandContext } from './context.js'
import type { DaemonHost } from './daemon-host.js'
import { linkLockHolder } from './link-lock.js'
import { accountLayoutOf, unsafeAccountPath } from './paths.js'

export interface DatabaseAccessSource {
  readonly ctx: Pick<CommandContext, 'layout'>
  readonly host: DaemonHost
}

/**
 * How the web reads and writes an account's database: `work` runs on the one of the account's running unit, or on a
 * temporary connection (as a preview does: never while a link or a retry holds the account). The result is null when
 * the account has no database, which is never created here. `work` is synchronous: nothing else touches the
 * connection meanwhile.
 */
export function databaseAccess(
  source: DatabaseAccessSource,
): <T>(id: string, work: (db: Database) => T) => Promise<T | null> {
  const { host, ctx } = source
  return async function withDatabase<T>(id: string, work: (db: Database) => T): Promise<T | null> {
    const running = host.runtimeOf(id)
    if (running !== undefined) return work(running.db)
    if (host.isClaimed(id)) throw new HttpError(409, 'busy')
    const account = accountLayoutOf(ctx.layout, id)
    if ((await unsafeAccountPath(account)) !== null) throw new HttpError(500, 'internal')
    if ((await linkLockHolder(account)) !== null) throw new HttpError(409, 'beingLinked')
    if (!isDirectory(account.dir) || !existsSync(account.dbFile)) return null
    if (host.isStopping) throw new HttpError(503, 'unavailable')
    // Looked at again after the awaits: a link or a unit may have appeared meanwhile.
    if (host.isClaimed(id)) throw new HttpError(409, 'busy')
    const unit = host.runtimeOf(id)
    if (unit !== undefined) return work(unit.db)
    if ((await linkLockHolder(account)) !== null) throw new HttpError(409, 'beingLinked')
    const db = openDatabase(account.dbFile)
    try {
      return work(db)
    } finally {
      db.close()
    }
  }
}
