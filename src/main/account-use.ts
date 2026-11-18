import { readBlocked } from './blocked.js'
import { hasSession } from './context.js'
import { runningDaemonPid } from './daemon-lock.js'
import type { AccountLayout, DataLayout } from './paths.js'

/**
 * The pid of the running daemon when it is USING the account, else null. The daemon uses an account when it is linked
 * (a registered session) and not blocked: that is when it has, or is about to have, a connection open for it. `link`
 * and `unlink` refuse such an account (it owns its session), and `retry` has nothing to do with it.
 *
 * It is decided from the files, so any process can ask. Commands ask once before taking the link lock, to refuse early
 * without touching anything, and once more under the lock, which is the check that counts.
 */
export async function daemonUsing(
  layout: Pick<DataLayout, 'lockFile'>,
  account: Pick<AccountLayout, 'blockedFile' | 'authDir'>,
): Promise<number | null> {
  const pid = await runningDaemonPid(layout.lockFile)
  if (pid === null) return null
  if ((await readBlocked(account.blockedFile)) !== null) return null
  return (await hasSession(account)) ? pid : null
}
