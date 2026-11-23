import { execFile } from 'node:child_process'
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

/** The recorded start of a daemon and the one the OS reports for the same pid differ by rounding (`ps` rounds to seconds). */
export const START_TOLERANCE_MS = 5_000

/** Field 22 (starttime, ticks since boot) of the content of /proc/<pid>/stat. The comm field may hold spaces and ')'. */
export function parseProcStatStartTicks(stat: string): number | null {
  const rest = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)
  // `rest` begins at field 3 (state), so field 22 is rest[19]
  const ticks = Number(rest[19])
  return rest.length > 19 && Number.isInteger(ticks) && ticks >= 0 ? ticks : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The `ps -o lstart=` format ("Mon Nov 23 11:32:04 2026", local time) as epoch ms. */
export function parsePsLstart(text: string): number | null {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text)
  const month = m === null ? -1 : MONTHS.indexOf(m[1] as string)
  if (m === null || month < 0) return null
  return new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime()
}

/**
 * When the process with this pid started (epoch ms), or null when it cannot be told. Only macOS and other Unix ask
 * `ps` (local, no shell, short timeout): the start it prints is stored at fork, so a later clock step does not move it.
 * Linux does NOT use this (`/proc` offers boot-relative ticks, and turning them into epoch needs `btime`, which moves
 * with every wall clock step): see `linuxIdentityOf`. Windows: unknown.
 */
export async function processStartedAt(pid: number): Promise<number | null> {
  if (process.platform === 'linux' || process.platform === 'win32') return null
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        'ps',
        ['-o', 'lstart=', '-p', String(pid)],
        { timeout: 3_000, env: { ...process.env, LC_ALL: 'C' } },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      )
    })
    return parsePsLstart(out.trim())
  } catch {
    return null
  }
}

/** What identifies a process on Linux without the wall clock: its start in ticks since boot, and which boot. */
export interface LinuxIdentity {
  readonly ticks: number
  readonly bootId: string
}

/** The identity of a pid from /proc, or null when it cannot be read (not Linux, gone, no permission). */
export async function linuxIdentityOf(pid: number): Promise<LinuxIdentity | null> {
  if (process.platform !== 'linux') return null
  try {
    const ticks = parseProcStatStartTicks(await readFile(`/proc/${pid}/stat`, 'utf8'))
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    return ticks === null || bootId === '' ? null : { ticks, bootId }
  } catch {
    return null
  }
}

export interface LockEnvironment {
  /** Whether a process with this pid exists on THIS host. */
  readonly isAlive?: (pid: number) => boolean
  readonly host?: string
  readonly now?: () => number
  /** When the process with this pid started (epoch ms), or null when unknown. Detects a pid reused after a restart. */
  readonly startedAt?: (pid: number) => Promise<number | null> | number | null
  /** Linux only: the start of the pid in ticks since boot and the boot id, or null when unknown. No wall clock involved. */
  readonly linuxIdentity?: (pid: number) => Promise<LinuxIdentity | null> | LinuxIdentity | null
}

interface LockContent {
  readonly pid: number
  readonly host: string
  /** Epoch ms when the holder started, as the OS reports it. Absent in old locks. */
  readonly started?: number
  /** Linux: start of the holder in ticks since boot, and the boot id. Immune to wall clock steps. */
  readonly ticks?: number
  readonly bootId?: string
}

interface ReadLock {
  readonly lock: LockContent | null
  /** The file content exactly as read, or null when there was no file. */
  readonly raw: string | null
}

async function readLockRaw(file: string): Promise<ReadLock> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { lock: null, raw: null }
  }
  return { lock: parseLock(text.trim()), raw: text }
}

async function readLock(file: string): Promise<LockContent | null> {
  return (await readLockRaw(file)).lock
}

function parseLock(raw: string): LockContent | null {
  try {
    const data = JSON.parse(raw) as
      | { pid?: unknown; host?: unknown; started?: unknown; ticks?: unknown; bootId?: unknown }
      | number
    if (typeof data === 'object' && data !== null) {
      if (Number.isInteger(data.pid) && (data.pid as number) > 0 && typeof data.host === 'string') {
        return {
          pid: data.pid as number,
          host: data.host,
          ...(typeof data.started === 'number' && Number.isFinite(data.started) ? { started: data.started } : {}),
          ...(typeof data.ticks === 'number' && Number.isInteger(data.ticks) && typeof data.bootId === 'string'
            ? { ticks: data.ticks, bootId: data.bootId }
            : {}),
        }
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
 * Who holds the lock, or null when nobody does (`raw` is the file content the verdict is about). A lock of this host is
 * held while its pid is alive, unless that pid is not the process that took the lock: the pid was reused (a container
 * restart keeps the host name, a reboot restarts the pid counter), so the holder is gone.
 * - Linux lock (`ticks` and `bootId`): another boot id means another boot, so stale; the same boot with other start
 *   ticks means a reused pid, so stale. Both values are clock independent. Unreadable: held.
 * - Other lock with `started` (macOS `ps`, or the uptime of the own process): stale when the pid started more than
 *   START_TOLERANCE_MS after it. Unreadable: held.
 * - Old lock or bare pid: held while alive.
 * A heartbeat that stopped is NOT a reason to take over (a sleeping laptop stops the heartbeat of a live daemon).
 * A lock of another host (the data directory on a shared volume) cannot be checked, so it is held unless its mtime,
 * refreshed by the holder's heartbeat, is older than an hour. An unreadable file counts as nobody.
 */
async function judge(
  file: string,
  env: Required<LockEnvironment>,
): Promise<{ holder: LockContent | null; raw: string | null }> {
  const { lock, raw } = await readLockRaw(file)
  if (lock === null) return { holder: null, raw }
  if (lock.host === '' || lock.host === env.host) {
    if (!env.isAlive(lock.pid)) return { holder: null, raw }
    if (lock.ticks !== undefined && lock.bootId !== undefined) {
      const now = await Promise.resolve(env.linuxIdentity(lock.pid)).catch(() => null)
      const reused = now !== null && (now.bootId !== lock.bootId || now.ticks !== lock.ticks)
      return { holder: reused ? null : lock, raw }
    }
    if (lock.started === undefined) return { holder: lock, raw }
    const actual = await Promise.resolve(env.startedAt(lock.pid)).catch(() => null)
    return { holder: actual !== null && actual > lock.started + START_TOLERANCE_MS ? null : lock, raw }
  }
  const info = await stat(file).catch(() => null)
  return { holder: info !== null && env.now() - info.mtimeMs < FOREIGN_LOCK_STALE_MS ? lock : null, raw }
}

const holderOf = async (file: string, env: Required<LockEnvironment>): Promise<LockContent | null> =>
  (await judge(file, env)).holder

const withDefaults = (env: LockEnvironment): Required<LockEnvironment> => ({
  isAlive: env.isAlive ?? processIsAlive,
  host: env.host ?? hostname(),
  now: env.now ?? Date.now,
  startedAt: env.startedAt ?? processStartedAt,
  linuxIdentity: env.linuxIdentity ?? linuxIdentityOf,
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
  // the same readers as for other pids, so the recorded and the re-read values are comparable. On Linux only the
  // clock independent identity is recorded; elsewhere the start epoch (the uptime is the fallback for our own pid).
  const identity = await Promise.resolve(resolved.linuxIdentity(pid)).catch(() => null)
  const started =
    identity !== null
      ? null
      : ((await Promise.resolve(resolved.startedAt(pid)).catch(() => null)) ??
        (pid === process.pid ? Math.round(Date.now() - process.uptime() * 1000) : null))
  const content = JSON.stringify({
    pid,
    host: resolved.host,
    ...(identity !== null ? { ticks: identity.ticks, bootId: identity.bootId } : {}),
    ...(started !== null ? { started } : {}),
  })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(file, `${content}\n`, { flag: 'wx', mode: FILE_MODE })
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
    const { holder, raw } = await judge(file, resolved)
    if (holder !== null && !(holder.pid === pid && (holder.host === resolved.host || holder.host === ''))) {
      return { ok: false, pid: holder.pid }
    }
    // The verdict took time (it may have asked the OS). Remove the file only if it is still the one judged stale: in
    // between, another daemon may have replaced it. If it changed, judge again on the next turn.
    if ((await readLockRaw(file)).raw === raw) await rm(file, { force: true })
  }
  throw new Error('could not take the daemon lock')
}
