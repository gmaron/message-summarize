import type { AccountArg } from '../../interfaces/cli/args.js'
import { EXIT_FAILURE, EXIT_OK } from '../../interfaces/cli/run.js'
import type { CommandContext } from '../context.js'
import { isDirectory } from '../installation/accounts.js'
import { FIXED_BY_LINKING, readBlocked } from '../installation/blocked.js'
import { retryBlock } from '../installation/retry.js'
import { acquireLinkLock } from '../link/lock.js'
import { isPrepared, prepareAccount } from './account-command.js'

/**
 * `msum retry [--account <id>]`: clears the block of an account that the daemon stopped using because the platform
 * refused or replaced the connection, or the socket failed (the reasons `daemon --retry` has always cleared, through
 * the same code). The running daemon sees the marker gone on its next look at the installation (a few seconds) and
 * connects the account again; nothing here needs the daemon to stop, and nothing here connects.
 *
 * A block that linking fixes (logged out from the phone, another account, no phone number) is not cleared: retrying
 * would only be blocked again, so the command says to link again instead.
 *
 * It takes the link lock of the account while it works: it must not clear a block under a `link` or `unlink` that is
 * working on the same account, and the daemon leaves the account alone meanwhile.
 */
export async function retryCommand(ctx: CommandContext, args: AccountArg): Promise<number> {
  const prepared = await prepareAccount(ctx, args.account, 'existing')
  if (!isPrepared(prepared)) return prepared.exit
  const { installation, account, catalog } = prepared
  const texts = catalog.cli.retry
  // Nothing to clear (an account the daemon is using is not blocked), or nothing retrying can fix: said at once,
  // without taking the lock. The check under the lock below is the one that counts.
  const early = await readBlocked(account.blockedFile)
  if (early === null) {
    installation.close()
    ctx.io.out(texts.notBlocked(account.id))
    return EXIT_OK
  }
  if (FIXED_BY_LINKING.includes(early.reason)) {
    installation.close()
    ctx.io.err(texts.needsRelink(account.id))
    return EXIT_FAILURE
  }
  const lock = isDirectory(account.dir) ? await acquireLinkLock(account) : null
  if (lock !== null && !lock.ok) {
    installation.close()
    ctx.io.err(texts.beingLinked(account.id, lock.pid, account.linkLockFile))
    return EXIT_FAILURE
  }
  try {
    await ctx.afterLock?.()
    const outcome = await retryBlock(account)
    if (outcome.result === 'notBlocked') {
      ctx.io.out(texts.notBlocked(account.id))
      return EXIT_OK
    }
    if (outcome.result === 'needsRelink') {
      ctx.io.err(texts.needsRelink(account.id))
      return EXIT_FAILURE
    }
    ctx.logger.info('account.retried', { account: account.id, reason: outcome.reason })
    ctx.io.out(texts.done(account.id))
    return EXIT_OK
  } finally {
    installation.close()
    await lock?.release()
  }
}
