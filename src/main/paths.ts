import { chmod, lstat, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isValidAccountId } from '../domain/account-id.js'

/** Where everything of one installation lives. The accounts are under `accounts/<id>/` (see `AccountLayout`). */
export interface DataLayout {
  readonly dataDir: string
  /** Installation-wide defaults. An account may override options in its own config.json. */
  readonly configFile: string
  /** The API keys of the installation (0600, never in config.json): `{ "openai": "...", ... }`. See `msum secret`. */
  readonly secretsFile: string
  /** The installation database: which accounts exist (and, later, their schedules). */
  readonly appDbFile: string
  readonly accountsDir: string
  /** The whisper models, shared by every account (`msum whisper download`). Not part of any account: unlink never touches it. */
  readonly modelsDir: string
  /** Held by the running daemon (host, pid and a heartbeat in its mtime). One daemon per installation. */
  readonly lockFile: string
  /** The single-account layout of the first versions: `account/`. Migrated to `accounts/default/` (see `accounts.ts`). */
  readonly legacyAccountDir: string
  /** The QR of the first versions lived at the root. A pairing credential: deleted when found. */
  readonly legacyQrFile: string
}

/** Everything that belongs to ONE account. Deleting `dir` deletes the account (RF-03). */
export interface AccountLayout {
  readonly id: string
  readonly dir: string
  readonly dbFile: string
  readonly authDir: string
  /** The audios downloaded for transcription (0700, files 0600). It is inside the account: unlink deletes it with the rest. */
  readonly mediaDir: string
  /** The models directory of the installation (see `DataLayout.modelsDir`), so a runtime can resolve `transcription.model`. */
  readonly modelsDir: string
  /** The QR of a link in progress. A pairing credential: written only while linking, deleted after. */
  readonly qrFile: string
  /** Present while the daemon must not use the account (see `blocked.ts`). */
  readonly blockedFile: string
  /** Optional overrides of the installation config.json. */
  readonly configFile: string
  /** Optional API keys of this account: they win over those of the installation (`secretsFile` of `DataLayout`). */
  readonly secretsFile: string
  /** The API keys of the installation, so a runtime can resolve a key without the `DataLayout`. */
  readonly installationSecretsFile: string
  /** Held by a running `msum link` of this account (pid and heartbeat, like the daemon lock): the daemon leaves the account alone meanwhile. */
  readonly linkLockFile: string
  /** What the daemon last said about the connection of this account (see `unit-state.ts`). */
  readonly stateFile: string
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

export function layoutOf(dataDir: string): DataLayout {
  return {
    dataDir,
    configFile: join(dataDir, 'config.json'),
    secretsFile: join(dataDir, 'secrets.json'),
    appDbFile: join(dataDir, 'app.db'),
    accountsDir: join(dataDir, 'accounts'),
    modelsDir: join(dataDir, 'models'),
    lockFile: join(dataDir, 'daemon.pid'),
    legacyAccountDir: join(dataDir, 'account'),
    legacyQrFile: join(dataDir, 'qr.png'),
  }
}

/**
 * The paths of one account. The id becomes a directory name, so it is validated here, the one place that builds the
 * path: an id that could climb out of `accounts/` (`..`, a slash) never gets this far. Throws on an invalid id.
 */
export function accountLayoutOf(layout: DataLayout, id: string): AccountLayout {
  if (!isValidAccountId(id)) throw new RangeError('invalid account id')
  const dir = join(layout.accountsDir, id)
  return {
    id,
    dir,
    dbFile: join(dir, 'db.sqlite'),
    authDir: join(dir, 'auth'),
    mediaDir: join(dir, 'media'),
    modelsDir: layout.modelsDir,
    qrFile: join(dir, 'qr.png'),
    blockedFile: join(dir, 'blocked.json'),
    configFile: join(dir, 'config.json'),
    secretsFile: join(dir, 'secrets.json'),
    installationSecretsFile: layout.secretsFile,
    linkLockFile: join(dir, 'link.lock'),
    stateFile: join(dir, 'state.json'),
  }
}

/** Thrown when a path that must be a real directory is a link or a file: nothing is created or tightened there. */
export class NotARealDirectoryError extends Error {
  constructor(readonly path: string) {
    super('not a real directory')
    this.name = 'NotARealDirectoryError'
  }
}

/** The first of `dirs` that exists and is not a real directory (a symbolic link is not one), or null. */
export async function firstNotRealDirectory(dirs: readonly string[]): Promise<string | null> {
  for (const dir of dirs) {
    const info = await lstat(dir).catch(() => null)
    if (info !== null && !info.isDirectory()) return dir
  }
  return null
}

async function ensureDirs(dirs: readonly string[]): Promise<void> {
  // Before any mkdir or chmod: a link must never make this code create or tighten something somewhere else.
  const bad = await firstNotRealDirectory(dirs)
  if (bad !== null) throw new NotARealDirectoryError(bad)
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true, mode: DIR_MODE })
    if (process.platform !== 'win32') await chmod(dir, DIR_MODE)
  }
}

/**
 * Creates the installation directories with mode 0700 (RNF-04), and tightens them when they already existed with
 * looser ones. Windows has no POSIX modes: there the chmod is skipped.
 */
export function ensureDataDirs(layout: DataLayout): Promise<void> {
  return ensureDirs([layout.dataDir, layout.accountsDir])
}

/** The same for the directories of one account. */
export function ensureAccountDirs(account: AccountLayout): Promise<void> {
  return ensureDirs([account.dir, account.authDir])
}

/** The path of the account that exists and is not a real directory (its directory or `auth/`), or null. */
export const unsafeAccountPath = (account: AccountLayout): Promise<string | null> =>
  firstNotRealDirectory([account.dir, account.authDir])

export interface PermissionProblem {
  readonly path: string
  /** Octal, for example "755". */
  readonly mode: string
}

/**
 * The directories of the installation and of the given accounts that exist and are accessible to someone other than
 * the owner. For `doctor`. (The databases and the session files are tightened to 0600 by their own adapters when they
 * are opened.)
 */
export async function loosePermissions(
  layout: DataLayout,
  accounts: readonly AccountLayout[] = [],
): Promise<PermissionProblem[]> {
  if (process.platform === 'win32') return []
  const problems: PermissionProblem[] = []
  const dirs = [
    layout.dataDir,
    layout.accountsDir,
    layout.modelsDir,
    ...accounts.flatMap((account) => [account.dir, account.authDir, account.mediaDir]),
  ]
  for (const dir of dirs) {
    const info = await stat(dir).catch(() => null)
    if (info === null) continue
    const mode = info.mode & 0o777
    if ((mode & 0o077) !== 0) problems.push({ path: dir, mode: mode.toString(8) })
  }
  return problems
}
