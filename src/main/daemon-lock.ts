import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { FILE_MODE } from './paths.js'

/** True when a process with this pid exists (permission denied still means it exists). */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** How often the daemon rewrites the mtime of the lock to show it is alive. */
export const HEARTBEAT_MS = 30_000
/** A lock held by ANOTHER host (a shared volume) is taken over only when it has had no heartbeat for this long. */
export const FOREIGN_LOCK_STALE_MS = 60 * 60_000

export interface LockEnvironment {
  /** Whether a process with this pid exists on THIS host. */
  readonly isAlive?: (pid: number) => boolean
  readonly host?: string
  readonly now?: () => number
}

interface LockContent {
  readonly pid: number
  readonly host: string
}

async function readLock(file: string): Promise<LockContent | null> {
  let raw: string
  try {
    raw = (await readFile(file, 'utf8')).trim()
  } catch {
    return null
  }
  try {
    const data = JSON.parse(raw) as { pid?: unknown; host?: unknown } | number
    if (typeof data === 'object' && data !== null) {
      if (Number.isInteger(data.pid) && (data.pid as number) > 0 && typeof data.host === 'string') {
        return { pid: data.pid as number, host: data.host }
      }
      return null
    }
  } catch {
    // not JSON: maybe an old lock
  }
  // an old lock with the bare pid
  const pid = Number.parseInt(raw, 10)
  return Number.isInteger(pid) && pid > 0 ? { pid, host: '' } : null
}

/**
 * Who holds the lock, or null when nobody does. A lock of this host is held while its pid is alive. A lock of another
 * host (the data directory on a shared volume) cannot be checked, so it is held unless its mtime, refreshed by the
 * holder's heartbeat, is older than an hour. A stale or unreadable file counts as nobody.
 */
async function holderOf(file: string, env: Required<LockEnvironment>): Promise<LockContent | null> {
  const lock = await readLock(file)
  if (lock === null) return null
  if (lock.host === '' || lock.host === env.host) return env.isAlive(lock.pid) ? lock : null
  const info = await stat(file).catch(() => null)
  return info !== null && env.now() - info.mtimeMs < FOREIGN_LOCK_STALE_MS ? lock : null
}

const withDefaults = (env: LockEnvironment): Required<LockEnvironment> => ({
  isAlive: env.isAlive ?? processIsAlive,
  host: env.host ?? hostname(),
  now: env.now ?? Date.now,
})

/** The pid of the daemon that holds the lock, or null when none is running. */
export async function runningDaemonPid(file: string, env: LockEnvironment = {}): Promise<number | null> {
  return (await holderOf(file, withDefaults(env)))?.pid ?? null
}

export type DaemonLock =
  | {
      readonly ok: true
      release(): Promise<void> /** Refreshes the mtime: "still alive". */
      heartbeat(): Promise<void>
    }
  | { readonly ok: false; readonly pid: number }

/**
 * One daemon per installation: two sockets with the same credentials kick each other out (WhatsApp closes the older
 * one with 440). The lock is a file with the host name and pid of the daemon. Its mtime is the heartbeat.
 * A file whose holder is gone (see `holderOf`) is stale and is taken over.
 */
export async function acquireDaemonLock(
  file: string,
  pid: number = process.pid,
  env: LockEnvironment = {},
): Promise<DaemonLock> {
  const resolved = withDefaults(env)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, `${JSON.stringify({ pid, host: resolved.host })}\n`, { flag: 'wx', mode: FILE_MODE })
      return {
        ok: true,
        release: async () => {
          const lock = await readLock(file)
          if (lock?.pid === pid && lock.host === resolved.host) await rm(file, { force: true })
        },
        heartbeat: async () => {
          const now = new Date(resolved.now())
          await utimes(file, now, now).catch(() => undefined)
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const holder = await holderOf(file, resolved)
    if (holder !== null && !(holder.pid === pid && (holder.host === resolved.host || holder.host === ''))) {
      return { ok: false, pid: holder.pid }
    }
    await rm(file, { force: true })
  }
  throw new Error('could not take the daemon lock')
}
