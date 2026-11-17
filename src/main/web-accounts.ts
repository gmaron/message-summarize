import type { Language } from '../infrastructure/i18n/index.js'
import { readAccountFacts } from './account-facts.js'
import { type Installation, isDirectory } from './accounts.js'
import { type BlockedReason, readBlocked } from './blocked.js'
import { languageHint, loadEffectiveConfig, systemTimezone } from './config.js'
import type { CommandContext } from './context.js'
import type { AccountState } from './daemon-host.js'
import { linkLockHolder } from './link-lock.js'
import { accountLayoutOf } from './paths.js'
import { earliestNextRun } from './schedule-format.js'
import type { UnitState } from './unit-state.js'

/** One account as the web shows it (RF-04, RF-71). Never the full number, never anything of the messages. */
export interface AccountView {
  readonly id: string
  readonly state: UnitState
  /** Epoch ms of the last change of state, or null when the daemon has not looked at the account yet. */
  readonly since: number | null
  readonly blockedReason: BlockedReason | null
  /** "+54*******0009", or null when nothing is linked. */
  readonly maskedNumber: string | null
  /** Where the last digest ended (epoch ms), or null when there has been none. */
  readonly lastDigest: number | null
  /** The soonest next run of the account's schedules (epoch ms), or null. */
  readonly nextRun: number | null
  readonly timezone: string
  readonly language: Language
  /** False when the account's configuration is invalid: the daemon leaves it idle and the fields above are partial. */
  readonly configValid: boolean
}

/** What the web needs to know about the installation. */
export interface AccountsSource {
  readonly ctx: Pick<CommandContext, 'env' | 'layout' | 'clock'>
  readonly installation: Installation
  /** The live state (in memory) of the daemon's accounts. */
  readonly host: { accountState(id: string): AccountState | null; isLinking(id: string): boolean }
}

/**
 * Every account of the installation with its live state. The state comes from the running host's memory, not from
 * `state.json` (that is for other processes); an account the host has not looked at yet is `idle`. A block that is on
 * disk but not yet in the host's state (the host only just started) is still reported.
 */
export async function describeAccounts(source: AccountsSource): Promise<AccountView[]> {
  const { ctx, installation, host } = source
  const now = ctx.clock.now()
  const views: AccountView[] = []
  for (const { id } of installation.accounts()) {
    const account = accountLayoutOf(ctx.layout, id)
    const live = host.accountState(id)
    const state = live?.state ?? 'idle'
    const blockedReason =
      live !== null ? live.blockedReason : ((await readBlocked(account.blockedFile))?.reason ?? null)
    const base = { id, state, since: live?.since ?? null, blockedReason }
    const loaded = await loadEffectiveConfig(ctx.layout.configFile, account.configFile)
    if (!loaded.ok) {
      views.push({
        ...base,
        maskedNumber: null,
        lastDigest: null,
        nextRun: null,
        timezone: systemTimezone(),
        language: await languageHint(ctx.layout.configFile, account.configFile),
        configValid: false,
      })
      continue
    }
    const config = loaded.value
    // Nothing of an account is opened while `link` or `unlink` holds it (the directory is that process's), nor when its
    // directory or database is gone: opening it would recreate it. The daemon's own link of the account is not another
    // process: reading its facts is what shows the number once it is bound.
    const untouchable = (!host.isLinking(id) && (await linkLockHolder(account)) !== null) || !isDirectory(account.dir)
    const facts = untouchable
      ? { masked: null, pointer: null, pending: 0 }
      : await readAccountFacts(ctx, account, config)
    views.push({
      ...base,
      maskedNumber: facts.masked,
      lastDigest: facts.pointer,
      nextRun: earliestNextRun(
        installation.schedules.list(id).map((stored) => stored.schedule),
        config.timezone,
        now,
      ),
      timezone: config.timezone,
      language: config.language,
      configValid: true,
    })
  }
  return views
}
