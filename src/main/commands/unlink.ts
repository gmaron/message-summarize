import { rm } from 'node:fs/promises'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../../interfaces/cli/run.js'
import { type CommandContext, loadConfigOrReport } from '../context.js'
import { runningDaemonPid } from '../daemon-lock.js'

/**
 * `msum unlink`: forgets the account and DELETES everything that belongs to it (RF-51, RF-03): the whole `account/`
 * directory, that is the database with its messages, digests, outbox and account binding (and its -wal and -shm
 * files), the WhatsApp session and the blocked marker. The messages and digests of one account must never end up in
 * the digests of another, and the pending parts must never be delivered anywhere. The configuration stays.
 *
 * The session is deleted here; the linked device still shows in the phone's "Linked devices", and the user is told to
 * remove it there. It refuses while a daemon runs (it would keep using what is being deleted), and asks first unless
 * `--yes`.
 */
export async function unlinkCommand(ctx: CommandContext, args: { readonly yes: boolean }): Promise<number> {
  const loaded = await loadConfigOrReport(ctx)
  if (loaded === null) return EXIT_USAGE
  const texts = loaded.catalog.cli
  const { io, layout } = ctx

  const daemonPid = await runningDaemonPid(layout.lockFile)
  if (daemonPid !== null) {
    io.err(texts.daemonRunning(daemonPid))
    return EXIT_FAILURE
  }
  if (!args.yes && !(await ctx.confirm(texts.unlink.confirm))) {
    io.err(texts.unlink.cancelled)
    return EXIT_FAILURE
  }
  await rm(layout.accountDir, { recursive: true, force: true })
  await rm(layout.qrFile, { force: true })
  ctx.logger.info('account.unlinked', {})
  io.out(texts.unlink.done)
  return EXIT_OK
}
