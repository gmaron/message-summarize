import { EXIT_FAILURE, EXIT_OK } from '../../interfaces/cli/run.js'
import type { CommandContext } from '../context.js'
import { readAccountState } from '../installation/account-state.js'
import { isDirectory, openInstallation } from '../installation/accounts.js'
import { accountLayoutOf } from '../installation/paths.js'
import { installationCatalog } from './account-command.js'

/**
 * `msum accounts`: one line per account of the installation with its id, its platform and its state: linked (with
 * the number masked, as `status` shows it), not linked, blocked (with the reason) or with its directory missing.
 * It prints no secrets and creates no account.
 */
export async function accountsCommand(ctx: CommandContext): Promise<number> {
  const texts = (await installationCatalog(ctx)).cli
  const opened = await openInstallation({ layout: ctx.layout, clock: ctx.clock })
  if (!opened.ok) {
    ctx.io.err(texts.legacyDaemonRunning(opened.pid))
    return EXIT_FAILURE
  }
  const { installation } = opened
  try {
    const rows = installation.accounts()
    if (rows.length === 0) {
      ctx.io.out(texts.accounts.empty)
      return EXIT_OK
    }
    const width = Math.max(...rows.map((row) => row.id.length))
    ctx.io.out(texts.accounts.header)
    for (const row of rows) {
      const account = accountLayoutOf(ctx.layout, row.id)
      let state: string
      if (!isDirectory(account.dir)) state = texts.accounts.missingDirState
      else {
        const found = await readAccountState(account)
        if (found.blocked !== null)
          state = texts.accounts.blocked(texts.blockedReasons[found.blocked.reason](account.id))
        else if (found.linked) state = texts.accounts.linked(found.masked ?? '')
        else state = texts.accounts.notLinked
      }
      ctx.io.out(texts.accounts.row(row.id.padEnd(width), row.platform, state))
    }
    return EXIT_OK
  } finally {
    installation.close()
  }
}
