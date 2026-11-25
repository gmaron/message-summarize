import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_MIGRATIONS,
  currentVersion,
  openAppDatabase,
  SqliteAccountRegistry,
} from '../../../../src/infrastructure/persistence/sqlite/index.js'
import { type Installation, openInstallation, selectAccount } from '../../../../src/main/installation/accounts.js'
import { acquireDaemonLock } from '../../../../src/main/installation/daemon-lock.js'
import { accountLayoutOf, ensureDataDirs, layoutOf } from '../../../../src/main/installation/paths.js'
import { isWindows } from '../../../support/platform.js'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const clock = { now: () => Date.parse('2026-11-17T15:00:00Z') }
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'msum-accounts-'))
  roots.push(dir)
  return layoutOf(join(dir, 'data'))
}
const modeOf = (path: string): number => statSync(path).mode & 0o777

/** Opens the installation and returns it, failing the test when it is refused. */
async function open(layout: ReturnType<typeof layoutOf>, lockHeld = false): Promise<Installation> {
  const opened = await openInstallation({ layout, clock, lockHeld })
  if (!opened.ok) throw new Error(`refused: ${opened.pid}`)
  return opened.installation
}

/** What the old single-account layout looked like on disk, with made-up content. */
function writeLegacyAccount(layout: ReturnType<typeof layoutOf>): void {
  mkdirSync(join(layout.legacyAccountDir, 'auth'), { recursive: true, mode: 0o700 })
  writeFileSync(join(layout.legacyAccountDir, 'db.sqlite'), 'legacy-database', { mode: 0o600 })
  writeFileSync(join(layout.legacyAccountDir, 'auth', 'creds.json'), '{"me":{"id":"x"}}', { mode: 0o600 })
  writeFileSync(join(layout.legacyAccountDir, 'blocked.json'), '{"reason":"loggedOut","at":1}', { mode: 0o600 })
  writeFileSync(layout.legacyQrFile, 'stale-qr', { mode: 0o600 })
}

describe('app.db', () => {
  it('is created private, in WAL mode, with its own schema_version and the accounts table', async () => {
    const layout = fresh()
    const installation = await open(layout)
    installation.close()
    if (!isWindows) expect(modeOf(layout.appDbFile)).toBe(0o600)
    if (!isWindows) expect(modeOf(layout.dataDir)).toBe(0o700)
    if (!isWindows) expect(modeOf(layout.accountsDir)).toBe(0o700)
    const db = new DatabaseSync(layout.appDbFile)
    try {
      expect(currentVersion(db as never)).toBe(APP_MIGRATIONS.length)
      expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
      const columns = db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]
      expect(columns.map((c) => c.name)).toEqual(['id', 'platform', 'created_at', 'schedules_imported'])
    } finally {
      db.close()
    }
  })

  it('registers accounts once, lists them by id and removes them', () => {
    const layout = fresh()
    mkdirSync(layout.dataDir, { recursive: true })
    const db = openAppDatabase(layout.appDbFile)
    try {
      const registry = new SqliteAccountRegistry(db, clock.now)
      expect(registry.register('work')).toBe(true)
      expect(registry.register('work')).toBe(false)
      registry.register('home')
      expect(registry.list()).toEqual([
        { id: 'home', platform: 'whatsapp', createdAt: '2026-11-17T15:00:00.000Z' },
        { id: 'work', platform: 'whatsapp', createdAt: '2026-11-17T15:00:00.000Z' },
      ])
      expect(registry.has('work')).toBe(true)
      registry.remove('work')
      expect(registry.has('work')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('refuses to register an invalid id, and never lists a row whose id is not valid', () => {
    const layout = fresh()
    mkdirSync(layout.dataDir, { recursive: true })
    const db = openAppDatabase(layout.appDbFile)
    try {
      const registry = new SqliteAccountRegistry(db, clock.now)
      for (const id of ['../x', 'A', '', 'a/b']) expect(() => registry.register(id)).toThrow('invalid account id')
      // a row written by hand (or by something else) with an id that would be a path
      db.exec(
        "INSERT INTO accounts (id, platform, created_at) VALUES ('../escape', 'whatsapp', 'x'), ('ok', 'whatsapp', 'x'), ('odd', 'sms', 'x')",
      )
      expect(registry.list().map((r) => r.id)).toEqual(['ok'])
      expect(registry.invalidIds()).toEqual(['../escape', 'odd'])
    } finally {
      db.close()
    }
  })
})

describe('openInstallation: creating and deleting accounts', () => {
  it('creates the directory (0700, with auth/) and the row, and deletes only that account', async () => {
    const layout = fresh()
    const installation = await open(layout)
    const alpha = await installation.createAccount('alpha')
    const beta = await installation.createAccount('beta')
    try {
      if (!isWindows) expect(modeOf(alpha.dir)).toBe(0o700)
      if (!isWindows) expect(modeOf(alpha.authDir)).toBe(0o700)
      writeFileSync(alpha.dbFile, 'a-data')
      writeFileSync(beta.dbFile, 'b-data')
      writeFileSync(join(beta.authDir, 'creds.json'), 'b-session')
      expect(installation.accounts().map((a) => a.id)).toEqual(['alpha', 'beta'])

      await installation.deleteAccount('alpha')
      expect(existsSync(alpha.dir)).toBe(false)
      expect(installation.accounts().map((a) => a.id)).toEqual(['beta'])
      expect(readFileSync(beta.dbFile, 'utf8')).toBe('b-data')
      expect(readFileSync(join(beta.authDir, 'creds.json'), 'utf8')).toBe('b-session')
    } finally {
      installation.close()
    }
  })

  it('never builds a path from an invalid id', async () => {
    const layout = fresh()
    const installation = await open(layout)
    try {
      await expect(installation.createAccount('../evil')).rejects.toThrow('invalid account id')
      await expect(installation.deleteAccount('..')).rejects.toThrow('invalid account id')
      expect(existsSync(join(layout.dataDir, 'evil'))).toBe(false)
      expect(existsSync(layout.appDbFile)).toBe(true)
    } finally {
      installation.close()
    }
  })
})

describe('openInstallation: reconciling app.db with accounts/', () => {
  it('registers a directory that has no row (a crash between creating it and registering it)', async () => {
    const layout = fresh()
    await ensureDataDirs(layout)
    mkdirSync(accountLayoutOf(layout, 'work').dir, { recursive: true })
    const installation = await open(layout)
    try {
      expect(installation.report.registered).toEqual(['work'])
      expect(installation.accounts().map((a) => a.id)).toEqual(['work'])
    } finally {
      installation.close()
    }
    // idempotent: the next start has nothing left to do
    const again = await open(layout)
    try {
      expect(again.report.registered).toEqual([])
      expect(again.accounts().map((a) => a.id)).toEqual(['work'])
    } finally {
      again.close()
    }
  })

  it('reports a row with no directory and does not delete it', async () => {
    const layout = fresh()
    const first = await open(layout)
    await first.createAccount('work')
    first.close()
    rmSync(accountLayoutOf(layout, 'work').dir, { recursive: true })
    const installation = await open(layout)
    try {
      expect(installation.report.missingDirs).toEqual(['work'])
      expect(installation.accounts().map((a) => a.id)).toEqual(['work'])
      // and reading it again changes nothing
      expect(existsSync(accountLayoutOf(layout, 'work').dir)).toBe(false)
    } finally {
      installation.close()
    }
    const again = await open(layout)
    try {
      expect(again.report.missingDirs).toEqual(['work'])
    } finally {
      again.close()
    }
  })

  it('ignores entries of accounts/ that are not account directories, and links', async () => {
    const layout = fresh()
    await ensureDataDirs(layout)
    mkdirSync(join(layout.accountsDir, 'Not Valid'))
    mkdirSync(join(layout.accountsDir, '..hidden'))
    writeFileSync(join(layout.accountsDir, 'stray.txt'), 'x')
    const elsewhere = join(layout.dataDir, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(layout.accountsDir, 'linked'))
    mkdirSync(join(layout.accountsDir, 'real'))
    const installation = await open(layout)
    try {
      expect(installation.accounts().map((a) => a.id)).toEqual(['real'])
      expect([...installation.report.ignoredEntries]).toEqual(['..hidden', 'Not Valid', 'linked', 'stray.txt'])
    } finally {
      installation.close()
    }
  })

  it('reports rows with an invalid id', async () => {
    const layout = fresh()
    const first = await open(layout)
    first.close()
    const db = new DatabaseSync(layout.appDbFile)
    db.exec("INSERT INTO accounts (id, platform, created_at) VALUES ('../escape', 'whatsapp', 'x')")
    db.close()
    const installation = await open(layout)
    try {
      expect(installation.report.invalidRows).toEqual(['../escape'])
      expect(installation.accounts()).toEqual([])
    } finally {
      installation.close()
    }
  })
})

describe('migrating the old layout (account/ to accounts/default/)', () => {
  it('moves the whole directory, registers it and deletes the stale QR', async () => {
    const layout = fresh()
    await ensureDataDirs(layout)
    writeLegacyAccount(layout)
    const installation = await open(layout)
    try {
      const target = accountLayoutOf(layout, 'default')
      expect(existsSync(layout.legacyAccountDir)).toBe(false)
      expect(readFileSync(target.dbFile, 'utf8')).toBe('legacy-database')
      expect(readFileSync(join(target.authDir, 'creds.json'), 'utf8')).toContain('"me"')
      expect(readFileSync(target.blockedFile, 'utf8')).toContain('loggedOut')
      expect(existsSync(layout.legacyQrFile)).toBe(false)
      expect(installation.accounts().map((a) => a.id)).toEqual(['default'])
      expect(installation.report.missingDirs).toEqual([])
    } finally {
      installation.close()
    }
  })

  it('is idempotent: a second start changes nothing', async () => {
    const layout = fresh()
    await ensureDataDirs(layout)
    writeLegacyAccount(layout)
    ;(await open(layout)).close()
    const installation = await open(layout)
    try {
      expect(installation.report.registered).toEqual([])
      expect(installation.accounts().map((a) => a.id)).toEqual(['default'])
      expect(readdirSync(layout.accountsDir)).toEqual(['default'])
    } finally {
      installation.close()
    }
  })

  it('finishes after a crash that moved the directory and did not register it', async () => {
    const layout = fresh()
    await ensureDataDirs(layout)
    writeLegacyAccount(layout)
    // the rename happened, then the process died: no row, and the old QR was not cleaned either
    renameSync(layout.legacyAccountDir, accountLayoutOf(layout, 'default').dir)
    const installation = await open(layout)
    try {
      expect(installation.report.registered).toEqual(['default'])
      expect(installation.accounts().map((a) => a.id)).toEqual(['default'])
      expect(readFileSync(accountLayoutOf(layout, 'default').dbFile, 'utf8')).toBe('legacy-database')
    } finally {
      installation.close()
    }
  })

  it('migrates when a row exists but the directory is still the old one (a crash before the rename)', async () => {
    const layout = fresh()
    const first = await open(layout)
    await first.createAccount('default')
    first.close()
    rmSync(accountLayoutOf(layout, 'default').dir, { recursive: true })
    writeLegacyAccount(layout)
    const installation = await open(layout)
    try {
      expect(readFileSync(accountLayoutOf(layout, 'default').dbFile, 'utf8')).toBe('legacy-database')
      expect(installation.report.missingDirs).toEqual([])
      expect(installation.accounts().map((a) => a.id)).toEqual(['default'])
    } finally {
      installation.close()
    }
  })

  it('does not merge or overwrite when accounts/default/ exists too, and says so', async () => {
    const layout = fresh()
    await ensureDataDirs(layout)
    writeLegacyAccount(layout)
    const target = accountLayoutOf(layout, 'default')
    mkdirSync(target.authDir, { recursive: true })
    writeFileSync(target.dbFile, 'new-database')
    const installation = await open(layout)
    try {
      expect(installation.report.legacyConflict).toBe(true)
      expect(readFileSync(target.dbFile, 'utf8')).toBe('new-database')
      expect(readFileSync(join(layout.legacyAccountDir, 'db.sqlite'), 'utf8')).toBe('legacy-database')
    } finally {
      installation.close()
    }
  })

  it('refuses while a live daemon holds the lock: nothing is moved under it', async () => {
    const layout = fresh()
    await ensureDataDirs(layout)
    writeLegacyAccount(layout)
    // another daemon: a different process that is alive (the parent of the test runner)
    await acquireDaemonLock(layout.lockFile, process.ppid)
    const opened = await openInstallation({ layout, clock })
    expect(opened).toEqual({ ok: false, reason: 'daemonRunning', pid: process.ppid })
    expect(existsSync(join(layout.legacyAccountDir, 'db.sqlite'))).toBe(true)
    expect(existsSync(accountLayoutOf(layout, 'default').dir)).toBe(false)
    expect(readFileSync(layout.lockFile, 'utf8')).toContain(String(process.ppid))
  })

  it('does not need the lock when there is nothing to migrate (a daemon of this version runs)', async () => {
    const layout = fresh()
    const first = await open(layout)
    await first.createAccount('work')
    first.close()
    await acquireDaemonLock(layout.lockFile, process.pid)
    const installation = await open(layout)
    try {
      expect(installation.accounts().map((a) => a.id)).toEqual(['work'])
    } finally {
      installation.close()
    }
  })

  it('migrates under a lock the caller holds (the daemon), and leaves it held', async () => {
    const layout = fresh()
    await ensureDataDirs(layout)
    writeLegacyAccount(layout)
    const lock = await acquireDaemonLock(layout.lockFile, process.pid)
    expect(lock.ok).toBe(true)
    const installation = await open(layout, true)
    try {
      expect(existsSync(accountLayoutOf(layout, 'default').dbFile)).toBe(true)
      expect(readFileSync(layout.lockFile, 'utf8')).toContain(String(process.pid))
    } finally {
      installation.close()
      if (lock.ok) await lock.release()
    }
  })

  it('takes the lock for the migration and releases it afterwards', async () => {
    const layout = fresh()
    await ensureDataDirs(layout)
    writeLegacyAccount(layout)
    ;(await open(layout)).close()
    expect(existsSync(layout.lockFile)).toBe(false)
  })

  it('takes over a lock whose daemon is gone', async () => {
    const layout = fresh()
    await ensureDataDirs(layout)
    writeLegacyAccount(layout)
    writeFileSync(layout.lockFile, `${JSON.stringify({ pid: 2 ** 22 + 1, host: hostname() })}\n`)
    const installation = await open(layout)
    try {
      expect(existsSync(accountLayoutOf(layout, 'default').dbFile)).toBe(true)
    } finally {
      installation.close()
    }
  })
})

describe('the stale QR of the old layout', () => {
  it('is deleted on every open, also when there is nothing to migrate', async () => {
    const layout = fresh()
    const first = await open(layout)
    first.close()
    writeFileSync(layout.legacyQrFile, 'stale-qr', { mode: 0o600 })
    const second = await open(layout)
    second.close()
    expect(existsSync(layout.legacyQrFile)).toBe(false)
  })
})

describe('selectAccount', () => {
  const none: string[] = []
  const one = ['work']
  const two = ['home', 'work']

  it('uses the only account, or default when there is none and the policy creates it', () => {
    expect(selectAccount(one, null, 'existing')).toEqual({ ok: true, id: 'work', exists: true })
    expect(selectAccount(none, null, 'link')).toEqual({ ok: true, id: 'default', exists: false })
    expect(selectAccount(none, null, 'daemon')).toEqual({ ok: true, id: 'default', exists: false })
    expect(selectAccount(none, null, 'existing')).toEqual({ ok: false, kind: 'none' })
  })

  it('asks for --account when there are several, listing them', () => {
    for (const policy of ['existing', 'link', 'daemon'] as const) {
      expect(selectAccount(two, null, policy)).toEqual({ ok: false, kind: 'ambiguous', known: two })
    }
  })

  it('takes the named account; only link creates one that does not exist', () => {
    expect(selectAccount(two, 'home', 'existing')).toEqual({ ok: true, id: 'home', exists: true })
    expect(selectAccount(two, 'new', 'link')).toEqual({ ok: true, id: 'new', exists: false })
    expect(selectAccount(two, 'new', 'existing')).toEqual({ ok: false, kind: 'unknown', id: 'new', known: two })
    expect(selectAccount(two, 'new', 'daemon')).toEqual({ ok: false, kind: 'unknown', id: 'new', known: two })
  })
})
