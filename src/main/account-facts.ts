import { existsSync } from 'node:fs'
import type { AppConfig } from './config.js'
import { type CommandContext, maskAccount } from './context.js'
import type { AccountLayout } from './paths.js'
import { createRuntime } from './runtime.js'

/** What an account's database says about it, for `status` and the web. */
export interface AccountFacts {
  /** The linked number, masked (never the full one), or null when nothing is linked. */
  readonly masked: string | null
  /** Where the last digest ended (epoch ms), or null when there has been none. */
  readonly pointer: number | null
  /** Parts waiting to be delivered. */
  readonly pending: number
}

/**
 * Reads the facts of an account without creating anything: with no database yet the account is simply not linked. It
 * opens the database for the time of the read, so it is safe next to a running daemon (as `status` already is).
 */
export async function readAccountFacts(
  ctx: Pick<CommandContext, 'env' | 'clock'>,
  account: AccountLayout,
  config: AppConfig,
): Promise<AccountFacts> {
  if (!existsSync(account.dbFile)) return { masked: null, pointer: null, pending: 0 }
  const runtime = createRuntime({ layout: account, config, env: ctx.env, clock: ctx.clock, summarizer: null })
  try {
    const bound = runtime.identity.get()
    return {
      masked: bound === null ? null : maskAccount(bound),
      pointer: await runtime.store.getPointer(),
      pending: runtime.store.pendingOutbox().length,
    }
  } finally {
    runtime.close()
  }
}
