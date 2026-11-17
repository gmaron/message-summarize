import { readFile, rm, writeFile } from 'node:fs/promises'
import type { BlockedReason } from '../infrastructure/i18n/index.js'
import { FILE_MODE } from './paths.js'

export type { BlockedReason }

const REASONS: readonly BlockedReason[] = [
  'loggedOut',
  'forbidden',
  'replaced',
  'socketFailed',
  'notLinked',
  'mismatch',
  'noAccount',
]

/** `account/blocked.json`: why the daemon stopped using the account, and when (epoch ms). */
export interface Blocked {
  readonly reason: BlockedReason
  readonly at: number
}

/**
 * The marker of an account the daemon must not use (logged out, refused, replaced, wrong account...). While it
 * exists, a daemon restarted by a supervisor logs the reason and stays idle instead of reconnecting in a loop, which
 * is what could get the number banned. It holds a fixed reason code and a time, nothing else.
 */
export async function readBlocked(file: string): Promise<Blocked | null> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as { reason?: unknown; at?: unknown }
    if (REASONS.includes(data.reason as BlockedReason) && typeof data.at === 'number') {
      return { reason: data.reason as BlockedReason, at: data.at }
    }
    // Present but unreadable: still blocked, for a reason that asks to link again.
    return { reason: 'notLinked', at: 0 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { reason: 'notLinked', at: 0 }
  }
}

export async function writeBlocked(file: string, reason: BlockedReason, at: number): Promise<void> {
  await writeFile(file, `${JSON.stringify({ reason, at })}\n`, { mode: FILE_MODE })
}

export async function clearBlocked(file: string): Promise<void> {
  await rm(file, { force: true })
}

/** Reasons that linking again fixes: `msum link` clears them. The others need `msum daemon --retry`. */
export const FIXED_BY_LINKING: readonly BlockedReason[] = ['loggedOut', 'notLinked', 'mismatch', 'noAccount']
