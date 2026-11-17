import { chmod, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Where everything of one installation lives (one account for now). */
export interface DataLayout {
  readonly dataDir: string
  readonly configFile: string
  readonly accountDir: string
  readonly dbFile: string
  readonly authDir: string
  /** The QR of a link in progress. A pairing credential: written only while linking, deleted after. */
  readonly qrFile: string
  /** Held by the running daemon (host, pid and a heartbeat in its mtime). */
  readonly lockFile: string
  /** Present while the daemon must not use the account (see `blocked.ts`). Inside account/, so unlink deletes it. */
  readonly blockedFile: string
}

export const DIR_MODE = 0o700
export const FILE_MODE = 0o600

export interface PathEnvironment {
  readonly env: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly home?: string
}

/**
 * The data directory: MSUM_DATA_DIR when set, else the default of the operating system (macOS
 * ~/Library/Application Support/message-summarize, Linux $XDG_DATA_HOME or ~/.local/share/message-summarize, Windows
 * %APPDATA%). Always absolute.
 */
export function resolveDataDir({ env, platform = process.platform, home = homedir() }: PathEnvironment): string {
  const explicit = env.MSUM_DATA_DIR
  if (explicit !== undefined && explicit.trim() !== '') return resolve(explicit)
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'message-summarize')
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'message-summarize')
  const xdg = env.XDG_DATA_HOME
  return join(
    xdg !== undefined && xdg.trim() !== '' ? resolve(xdg) : join(home, '.local', 'share'),
    'message-summarize',
  )
}

/** Config at the root; everything of the account under account/ (a second account will be a sibling). */
export function layoutOf(dataDir: string): DataLayout {
  const accountDir = join(dataDir, 'account')
  return {
    dataDir,
    configFile: join(dataDir, 'config.json'),
    accountDir,
    dbFile: join(accountDir, 'db.sqlite'),
    authDir: join(accountDir, 'auth'),
    qrFile: join(dataDir, 'qr.png'),
    lockFile: join(dataDir, 'daemon.pid'),
    blockedFile: join(accountDir, 'blocked.json'),
  }
}

/**
 * Creates the directories with mode 0700 (RNF-04), and tightens them when they already existed with looser ones.
 * Windows has no POSIX modes: there the chmod is skipped.
 */
export async function ensureDataDirs(layout: DataLayout): Promise<void> {
  for (const dir of [layout.dataDir, layout.accountDir, layout.authDir]) {
    await mkdir(dir, { recursive: true, mode: DIR_MODE })
    if (process.platform !== 'win32') await chmod(dir, DIR_MODE)
  }
}

export interface PermissionProblem {
  readonly path: string
  /** Octal, for example "755". */
  readonly mode: string
}

/**
 * The directories of the layout that exist and are accessible to someone other than the owner. For `doctor`. (The
 * database and the session files are tightened to 0600 by their own adapters when they are opened.)
 */
export async function loosePermissions(layout: DataLayout): Promise<PermissionProblem[]> {
  if (process.platform === 'win32') return []
  const problems: PermissionProblem[] = []
  for (const dir of [layout.dataDir, layout.accountDir, layout.authDir]) {
    const info = await stat(dir).catch(() => null)
    if (info === null) continue
    const mode = info.mode & 0o777
    if ((mode & 0o077) !== 0) problems.push({ path: dir, mode: mode.toString(8) })
  }
  return problems
}
