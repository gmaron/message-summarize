import type { AccountArg } from '../../interfaces/cli/args.js'
import { EXIT_FAILURE, EXIT_OK } from '../../interfaces/cli/run.js'
import { installationCatalog, isPrepared, prepareAccount } from '../account-command.js'
import type { CommandContext } from '../context.js'
import { runningDaemonPid } from '../daemon-lock.js'

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
 * remove it there. It refuses while a daemon runs (it would keep using what is being deleted), and asks first unless
 * `--yes`.
 */
export async function unlinkCommand(
  ctx: CommandContext,
  args: { readonly yes: boolean } & AccountArg,
): Promise<number> {
  const { io } = ctx
  const daemonPid = await runningDaemonPid(ctx.layout.lockFile)
  if (daemonPid !== null) {
    io.err((await installationCatalog(ctx)).cli.daemonRunning(daemonPid))
    return EXIT_FAILURE
  }
  const prepared = await prepareAccount(ctx, args.account, 'existing', { allowMissingDir: true })
  if (!isPrepared(prepared)) return prepared.exit
  const { installation, account, catalog } = prepared
  const texts = catalog.cli
  try {
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
  }
}
