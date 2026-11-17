import { lstatSync } from 'node:fs'
import { readdir, rename, rm } from 'node:fs/promises'
import type { Clock } from '../application/ports/clock.js'
import { DEFAULT_ACCOUNT_ID, isValidAccountId } from '../domain/account-id.js'
import {
  type AccountRecord,
  type Database,
  openAppDatabase,
  SqliteAccountRegistry,
  SqliteScheduleRepository,
} from '../infrastructure/persistence/sqlite/index.js'
import { acquireDaemonLock, type DaemonLock } from './daemon-lock.js'
import {
  type AccountLayout,
  accountLayoutOf,
  type DataLayout,
  ensureAccountDirs,
  ensureDataDirs,
  NotARealDirectoryError,
  unsafeAccountPath,
} from './paths.js'

/** What `app.db` and the directories of `accounts/` say about each other. */
export interface ReconcileReport {
  /** Directories with a valid id and no row: they were registered now (a crash between creating and registering). */
  readonly registered: readonly string[]
  /** Rows with no directory: reported by `doctor`, never deleted silently. */
  readonly missingDirs: readonly string[]
  /** Rows that are not valid accounts (an invalid id): never used as a path. */
  readonly invalidRows: readonly string[]
  /** Entries of `accounts/` that are not account directories (a name that is not a valid id, a file, a link). */
  readonly ignoredEntries: readonly string[]
  /** `account/` (old layout) and `accounts/default/` both exist: nothing was migrated. */
  readonly legacyConflict: boolean
}

/** The accounts of an installation, opened for a command. Close it when done. */
export interface Installation {
  readonly layout: DataLayout
  readonly registry: SqliteAccountRegistry
  /** The schedules of the accounts, on the same `app.db` connection. */
  readonly schedules: SqliteScheduleRepository
  readonly report: ReconcileReport
  /** Registered accounts (after reconciling), ordered by id. */
  accounts(): AccountRecord[]
  /** Creates the directories and the row of an account. The directory goes first: a crash leaves it to reconcile. */
  createAccount(id: string): Promise<AccountLayout>
  /** Deletes the directory of an account (everything it owns) and then its row, and nothing else. */
  deleteAccount(id: string): Promise<void>
  close(): void
}

export type OpenInstallationResult =
  | { readonly ok: true; readonly installation: Installation }
  /** The old layout needs migrating and a daemon holds the lock: its files must not move under it. */
  | { readonly ok: false; readonly reason: 'daemonRunning'; readonly pid: number }

export interface OpenInstallationOptions {
  readonly layout: DataLayout
  readonly clock: Clock
  /** True when the caller already holds the daemon lock (the daemon command): the migration does not take it. */
  readonly lockHeld?: boolean
}

/** A real directory: a symbolic link is not one (nothing is followed out of the data directory). */
export const isDirectory = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true

/** Valid account directories under `accounts/` and the other entries. Symbolic links are never followed. */
async function scanAccountDirs(layout: DataLayout): Promise<{ dirs: string[]; ignored: string[] }> {
  const entries = await readdir(layout.accountsDir, { withFileTypes: true }).catch(() => [])
  const dirs: string[] = []
  const ignored: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && isValidAccountId(entry.name)) dirs.push(entry.name)
    else ignored.push(entry.name)
  }
  return { dirs: dirs.sort(), ignored: ignored.sort() }
}

/**
 * Moves the single-account layout (`account/`) to `accounts/default/` and registers it, once.
 *
 * - One atomic rename of the whole directory: it either happened or it did not. A crash after it and before the row
 *   leaves `accounts/default/` with no row, which the reconcile that follows (on this start or the next) registers.
 * - It runs only while holding the daemon lock: a daemon of the old version must not have its database and session
 *   moved under it. The commands take the lock for the migration and release it; the daemon already holds it.
 * - It does nothing when `accounts/default/` exists already (it never merges or overwrites). That is reported.
 */
async function migrateLegacyLayout(
  layout: DataLayout,
  registry: SqliteAccountRegistry,
  lockHeld: boolean,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly pid: number }> {
  const target = accountLayoutOf(layout, DEFAULT_ACCOUNT_ID)
  // A QR left at the root by the old layout is a stale pairing credential: gone on every open, migration or not.
  await rm(layout.legacyQrFile, { force: true })
  const pending = (): boolean => isDirectory(layout.legacyAccountDir) && !isDirectory(target.dir)
  if (!pending()) return { ok: true }
  let lock: DaemonLock | null = null
  if (!lockHeld) {
    lock = await acquireDaemonLock(layout.lockFile)
    if (!lock.ok) return { ok: false, pid: lock.pid }
  }
  try {
    // Looked at again under the lock: another process may have migrated while this one waited.
    if (pending()) {
      await rename(layout.legacyAccountDir, target.dir)
    }
    registry.register(DEFAULT_ACCOUNT_ID)
  } finally {
    await lock?.release()
  }
  return { ok: true }
}

/** Brings the rows and the directories in line: registers the directories that have no row, reports the rest. */
async function reconcile(layout: DataLayout, registry: SqliteAccountRegistry): Promise<ReconcileReport> {
  const { dirs, ignored } = await scanAccountDirs(layout)
  const registered: string[] = []
  for (const id of dirs) if (registry.register(id)) registered.push(id)
  const rows = registry.list()
  return {
    registered,
    missingDirs: rows.map((row) => row.id).filter((id) => !dirs.includes(id)),
    invalidRows: registry.invalidIds(),
    ignoredEntries: ignored,
    legacyConflict:
      isDirectory(layout.legacyAccountDir) && isDirectory(accountLayoutOf(layout, DEFAULT_ACCOUNT_ID).dir),
  }
}

/**
 * Opens the installation: creates its directories and `app.db`, migrates the old layout when there is one and
 * reconciles `app.db` with `accounts/` (RF-03, RNF-08: safe to run on every start, after a crash at any point).
 */
export async function openInstallation(options: OpenInstallationOptions): Promise<OpenInstallationResult> {
  const { layout, clock } = options
  await ensureDataDirs(layout)
  const db: Database = openAppDatabase(layout.appDbFile)
  try {
    const registry = new SqliteAccountRegistry(db, () => clock.now())
    const migrated = await migrateLegacyLayout(layout, registry, options.lockHeld === true)
    if (!migrated.ok) {
      db.close()
      return { ok: false, reason: 'daemonRunning', pid: migrated.pid }
    }
    const report = await reconcile(layout, registry)
    const installation: Installation = {
      layout,
      registry,
      schedules: new SqliteScheduleRepository(db, () => clock.now()),
      report,
      accounts: () => registry.list(),
      createAccount: async (id) => {
        const account = accountLayoutOf(layout, id)
        await ensureAccountDirs(account)
        registry.register(id)
        return account
      },
      deleteAccount: async (id) => {
        const account = accountLayoutOf(layout, id)
        // Never report an account deleted while its data lives elsewhere behind a link.
        if ((await unsafeAccountPath(account)) !== null) throw new NotARealDirectoryError(account.dir)
        await rm(account.dir, { recursive: true, force: true })
        registry.remove(id)
      },
      close: () => db.close(),
    }
    return { ok: true, installation }
  } catch (error) {
    db.close()
    throw error
  }
}

export type AccountPolicy =
  /** The account must exist (digest, unlink, status...). */
  | 'existing'
  /** `link`: a named account that does not exist is created, and so is `default` when there is none. */
  | 'link'
  /** `daemon`: a named account must exist; with none at all, `default` is created (it idles until linked). */
  | 'daemon'

export type AccountSelection =
  | { readonly ok: true; readonly id: string; readonly exists: boolean }
  | { readonly ok: false; readonly kind: 'unknown'; readonly id: string; readonly known: readonly string[] }
  | { readonly ok: false; readonly kind: 'none' }
  | { readonly ok: false; readonly kind: 'ambiguous'; readonly known: readonly string[] }

/**
 * Which account a command works on. The id of `--account` has been validated by the argument parser. Without it: the
 * only account; none at all gives `default` where the policy creates it; several is an error that lists them.
 */
export function selectAccount(
  known: readonly string[],
  requested: string | null,
  policy: AccountPolicy,
): AccountSelection {
  if (requested !== null) {
    const exists = known.includes(requested)
    if (!exists && policy !== 'link') return { ok: false, kind: 'unknown', id: requested, known }
    return { ok: true, id: requested, exists }
  }
  const [only, ...others] = known
  if (only !== undefined && others.length === 0) return { ok: true, id: only, exists: true }
  if (only !== undefined) return { ok: false, kind: 'ambiguous', known }
  if (policy === 'existing') return { ok: false, kind: 'none' }
  return { ok: true, id: DEFAULT_ACCOUNT_ID, exists: false }
}
