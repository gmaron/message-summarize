import { getCatalog } from '../../infrastructure/i18n/index.js'
import { EXIT_FAILURE, EXIT_USAGE } from '../../interfaces/cli/run.js'
import type { AppConfig } from '../config/config.js'
import { languageHint } from '../config/config.js'
import { importConfigSchedules } from '../config/schedules.js'
import { type CommandContext, type LoadedConfig, loadConfigOrReport } from '../context.js'
import {
  type AccountPolicy,
  type Installation,
  isDirectory,
  openInstallation,
  selectAccount,
} from '../installation/accounts.js'
import { type AccountLayout, accountLayoutOf, ensureAccountDirs, unsafeAccountPath } from '../installation/paths.js'

/** What a command that works on one account gets. The command closes the installation when it is done. */
export interface PreparedAccount extends LoadedConfig {
  readonly installation: Installation
  readonly account: AccountLayout
  readonly config: AppConfig
  /** This call created the account (its directory and record): `link` rolls it back if nothing gets linked. */
  readonly created: boolean
}

export interface PrepareOptions {
  /** The caller already holds the daemon lock. */
  readonly lockHeld?: boolean
  /** The directory of the account may be missing (`unlink` of a row whose directory is gone). */
  readonly allowMissingDir?: boolean
}

/** The catalog in the language of the installation config, for messages printed before an account is chosen. */
export async function installationCatalog(ctx: CommandContext) {
  return getCatalog(await languageHint(ctx.layout.configFile))
}

/**
 * The steps every account command starts with: open the installation (migrating the old layout and reconciling
 * `app.db` with the directories), choose the account from `--account` (see `selectAccount`), create it when the
 * policy says so, and load its effective configuration. On a problem it prints the reason and returns the exit code.
 */
export async function prepareAccount(
  ctx: CommandContext,
  requested: string | null,
  policy: AccountPolicy,
  options: PrepareOptions = {},
): Promise<PreparedAccount | { readonly exit: number }> {
  const rootCatalog = await installationCatalog(ctx)
  const texts = rootCatalog.cli
  const opened = await openInstallation({ layout: ctx.layout, clock: ctx.clock, lockHeld: options.lockHeld === true })
  if (!opened.ok) {
    ctx.io.err(texts.legacyDaemonRunning(opened.pid))
    return { exit: EXIT_FAILURE }
  }
  const { installation } = opened
  const fail = (code: number, line: string): { readonly exit: number } => {
    installation.close()
    ctx.io.err(line)
    return { exit: code }
  }
  try {
    const known = installation.accounts().map((row) => row.id)
    const selection = selectAccount(known, requested, policy)
    if (!selection.ok) {
      switch (selection.kind) {
        case 'unknown':
          return fail(EXIT_USAGE, texts.accounts.unknown(selection.id, selection.known.join(', ')))
        case 'none':
          return fail(EXIT_USAGE, texts.accounts.none)
        case 'ambiguous':
          return fail(EXIT_USAGE, texts.accounts.ambiguous(selection.known.join(', ')))
      }
    }
    const layout = accountLayoutOf(ctx.layout, selection.id)
    // A link where the directory should be: nothing is created, tightened or deleted through it.
    if ((await unsafeAccountPath(layout)) !== null)
      return fail(EXIT_FAILURE, texts.accounts.notADirectory(selection.id))
    if (!selection.exists) await installation.createAccount(selection.id)
    else if (!isDirectory(layout.dir)) {
      if (policy === 'existing' && options.allowMissingDir !== true) {
        return fail(EXIT_FAILURE, texts.accounts.missingDir(selection.id))
      }
      // `link` and `daemon` re-create what is missing; `unlink` only cleans the row.
      if (policy !== 'existing') await ensureAccountDirs(layout)
    }
    const loaded = await loadConfigOrReport(ctx, layout)
    if (loaded === null) {
      installation.close()
      return { exit: EXIT_USAGE }
    }
    importConfigSchedules(installation, layout.id, loaded.config)
    return { ...loaded, installation, account: layout, created: !selection.exists }
  } catch (error) {
    installation.close()
    throw error
  }
}

export const isPrepared = (value: PreparedAccount | { readonly exit: number }): value is PreparedAccount =>
  'installation' in value
