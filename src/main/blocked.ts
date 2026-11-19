import { readFile, rm } from 'node:fs/promises'
import type { BlockedReason } from '../infrastructure/i18n/index.js'
import { writeFileAtomic } from './atomic-write.js'

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
  // Atomic: a reader (or a crash) must not leave an empty marker, which reads as `notLinked` and loses the reason.
  await writeFileAtomic(file, `${JSON.stringify({ reason, at })}\n`)
}

export async function clearBlocked(file: string): Promise<void> {
  await rm(file, { force: true })
}

/**
 * Reasons for which WhatsApp itself asked to wait (refused, 403; replaced, 440): reconnecting at once is what can get a
 * number banned. The web's retry waits `WEB_RETRY_MIN_WAIT_MS` after the block for these (see `DaemonHost.retryAccount`).
 * `msum retry` and `msum daemon --retry` do not wait: they are typed, deliberate commands of someone at the terminal.
 */
export const WAIT_BEFORE_RETRY: readonly BlockedReason[] = ['forbidden', 'replaced']
export const WEB_RETRY_MIN_WAIT_MS = 30 * 60_000

/** Reasons that linking again fixes: `msum link` clears them. The others need `msum daemon --retry`. */
export const FIXED_BY_LINKING: readonly BlockedReason[] = ['loggedOut', 'notLinked', 'mismatch', 'noAccount']
