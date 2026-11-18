import { type BlockedReason, clearBlocked, FIXED_BY_LINKING, readBlocked } from './blocked.js'
import type { AccountLayout } from './paths.js'

export type RetryOutcome =
  /** There was no block. */
  | { readonly result: 'notBlocked' }
  /** The block is one that only linking fixes: it was kept. */
  | { readonly result: 'needsRelink'; readonly reason: BlockedReason }
  /** The block was cleared. */
  | { readonly result: 'cleared'; readonly reason: BlockedReason }

/**
 * Clears the block of an account if retrying can fix it: a connection the platform refused or replaced, or a socket
 * that failed. A block that linking fixes (logged out from the phone, another account, no phone number, nothing
 * linked) is kept: retrying would only be blocked again, and reconnecting a dead session is what could get a number
 * banned. Shared by `msum retry` and `msum daemon --retry`, so both clear exactly the same reasons.
 */
export async function retryBlock(account: Pick<AccountLayout, 'blockedFile'>): Promise<RetryOutcome> {
  const marker = await readBlocked(account.blockedFile)
  if (marker === null) return { result: 'notBlocked' }
  if (FIXED_BY_LINKING.includes(marker.reason)) return { result: 'needsRelink', reason: marker.reason }
  await clearBlocked(account.blockedFile)
  return { result: 'cleared', reason: marker.reason }
}
