import type { AccountArg } from '../../interfaces/cli/args.js'
import { EXIT_FAILURE, EXIT_OK } from '../../interfaces/cli/run.js'
import { isPrepared, prepareAccount } from '../account-command.js'
import { daemonUsing } from '../account-use.js'
import { isDirectory } from '../accounts.js'
import type { CommandContext } from '../context.js'
import { acquireLinkLock } from '../link-lock.js'

/**
 * `msum unlink [--account <id>]`: forgets the account and DELETES everything that belongs to it (RF-51, RF-03): its
 * whole directory `accounts/<id>/`, that is the database with its messages, digests, outbox and account binding (and
 * its -wal and -shm files), the WhatsApp session, the blocked marker and its optional config.json, and then its row
 * in `app.db`. Nothing of any other account is touched. The messages and digests of one account must never end up in
 * the digests of another, and the pending parts must never be delivered anywhere. The installation configuration stays.
 *
 * The directory goes first and the row after: a crash in between leaves a row with no directory, which `doctor`
 * reports and a second `unlink` cleans (the other order would leave a directory that the next start registers again).
 *
 * The session is deleted here; the linked device still shows in the phone's "Linked devices", and the user is told to
 * remove it there. It refuses for an account the running daemon is using (it would keep using what is being deleted);
 * an account the daemon leaves idle (not linked, or blocked) can be removed while it runs. It takes the link lock of
 * the account, so the daemon cannot start it meanwhile, and it asks first unless `--yes`.
 */
export async function unlinkCommand(
  ctx: CommandContext,
  args: { readonly yes: boolean } & AccountArg,
): Promise<number> {
  const { io } = ctx
  const prepared = await prepareAccount(ctx, args.account, 'existing', { allowMissingDir: true })
  if (!isPrepared(prepared)) return prepared.exit
  const { installation, account, catalog } = prepared
  const texts = catalog.cli
  // An account the running daemon is using (linked, not blocked) is not deleted under it: refused at once, before
  // anything is taken. One it leaves idle (not linked, or blocked) can be removed while it runs.
  const using = await daemonUsing(ctx.layout, account)
  if (using !== null) {
    installation.close()
    io.err(texts.unlink.activeInDaemon(account.id, using))
    return EXIT_FAILURE
  }
  // Held while the account is looked at and deleted: the daemon does not start it meanwhile, and a `link` waits.
  const lock = isDirectory(account.dir) ? await acquireLinkLock(account) : null
  if (lock !== null && !lock.ok) {
    installation.close()
    io.err(texts.unlink.beingLinked(account.id, lock.pid, account.linkLockFile))
    return EXIT_FAILURE
  }
  try {
    await ctx.afterLock?.()
    // The authoritative check, under the lock.
    const daemonPid = await daemonUsing(ctx.layout, account)
    if (daemonPid !== null) {
      io.err(texts.unlink.activeInDaemon(account.id, daemonPid))
      return EXIT_FAILURE
    }
    if (!args.yes && !(await ctx.confirm(texts.unlink.confirm(account.id)))) {
      io.err(texts.unlink.cancelled)
      return EXIT_FAILURE
    }
    await installation.deleteAccount(account.id)
    ctx.logger.info('account.unlinked', {})
    io.out(texts.unlink.done(account.id))
    return EXIT_OK
  } finally {
    installation.close()
    await lock?.release()
  }
}
