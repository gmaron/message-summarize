import { acquireDaemonLock, type DaemonLock, type LockEnvironment, runningDaemonPid } from './daemon-lock.js'
import type { AccountLayout } from './paths.js'

/** How often a running `link` refreshes its lock, as the daemon does for its own. */
export const LINK_HEARTBEAT_MS = 30_000

/**
 * The lock of an account while `msum link` (or `msum unlink`) works on it: `accounts/<id>/link.lock`, with the same
 * format and rules as the daemon lock (host, pid, a heartbeat in the mtime; a lock whose process is gone is taken
 * over). While it is held by a live process the daemon does not start, and stops, the unit of that account, so the
 * daemon never opens a socket with credentials that `link` is still writing, and never uses what `unlink` deletes.
 */
export function acquireLinkLock(
  account: Pick<AccountLayout, 'linkLockFile'>,
  pid?: number,
  env?: LockEnvironment,
): Promise<DaemonLock> {
  return acquireDaemonLock(account.linkLockFile, pid, env)
}

/** The pid of the process that holds the link lock of the account, or null when nobody does. */
export function linkLockHolder(
  account: Pick<AccountLayout, 'linkLockFile'>,
  env?: LockEnvironment,
): Promise<number | null> {
  return runningDaemonPid(account.linkLockFile, env)
}
