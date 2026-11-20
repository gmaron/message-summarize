import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_MIGRATIONS,
  currentVersion,
  openAppDatabase,
  openDatabase,
  SqliteAccountRegistry,
  SqliteSetupRepository,
} from '../../../src/infrastructure/persistence/sqlite/index.js'

const dirs: string[] = []
const pathOf = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'msum-appdb-'))
  dirs.push(dir)
  return join(dir, 'app.db')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tables = (db: ReturnType<typeof openAppDatabase>): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_'))

describe('the app.db migration of the setup state (RF-70, RNF-02)', () => {
  it('is the third version (the fourth keys the consents by hosts), and a fresh database has the two tables', () => {
    expect(APP_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4])
    const db = openAppDatabase(pathOf())
    expect(currentVersion(db)).toBe(4)
    expect(tables(db)).toEqual(['accounts', 'consents', 'schedules', 'schema_version', 'setup'])
    db.close()
  })

  it('upgrades a database at the previous version and keeps its accounts and schedules', () => {
    const path = pathOf()
    const old = openDatabase(path, { migrations: APP_MIGRATIONS.slice(0, 2) })
    expect(currentVersion(old)).toBe(2)
    new SqliteAccountRegistry(old).register('alpha')
    old
      .prepare("INSERT INTO schedules (account_id, days, time, created_at) VALUES ('alpha', '1,2', '09:00', 'x')")
      .run()
    old.close()

    const upgraded = openAppDatabase(path)
    expect(currentVersion(upgraded)).toBe(4)
    expect(upgraded.prepare('SELECT id FROM accounts').all()).toEqual([{ id: 'alpha' }])
    expect(upgraded.prepare('SELECT time FROM schedules').all()).toEqual([{ time: '09:00' }])
    const setup = new SqliteSetupRepository(upgraded)
    expect(setup.get()).toBeNull()
    expect(setup.recordConsent('alpha', 'claude-cli', 1)).toBe(true)
    upgraded.close()
  })
})

describe('SqliteSetupRepository', () => {
  const open = () => {
    const db = openAppDatabase(pathOf())
    let time = Date.parse('2026-11-17T15:00:00Z')
    return { db, repo: new SqliteSetupRepository(db, () => time++), registry: new SqliteAccountRegistry(db) }
  }

  it('has no state until it is ensured, which never replaces what is there', () => {
    const { db, repo } = open()
    expect(repo.get()).toBeNull()
    expect(repo.ensure(false)).toEqual({ step: 'you', account: null, completedAt: null })
    repo.save('provider', null)
    expect(repo.ensure(true)).toMatchObject({ step: 'provider', completedAt: null })
    db.close()
  })

  it('can be ensured as already completed', () => {
    const { db, repo } = open()
    expect(repo.ensure(true).completedAt).toBe('2026-11-17T15:00:00.000Z')
    db.close()
  })

  it('saves the step and the account, and a completed setup does not move', () => {
    const { db, repo, registry } = open()
    registry.register('alpha')
    repo.ensure(false)
    repo.save('link', 'alpha')
    expect(repo.get()).toMatchObject({ step: 'link', account: 'alpha', completedAt: null })
    repo.complete()
    const completedAt = repo.get()?.completedAt
    expect(completedAt).not.toBeNull()
    repo.save('you', null)
    repo.complete()
    expect(repo.get()).toEqual({ step: 'link', account: 'alpha', completedAt })
    db.close()
  })

  it('completes even when it never started', () => {
    const { db, repo } = open()
    repo.complete()
    expect(repo.get()?.completedAt).not.toBeNull()
    db.close()
  })

  it('reads a step it does not know as the first', () => {
    const { db, repo } = open()
    repo.ensure(false)
    db.prepare("UPDATE setup SET step = 'from-the-future'").run()
    expect(repo.get()?.step).toBe('you')
    db.close()
  })

  it.each([
    ['language', 'you'],
    ['name', 'you'],
    ['transcription', 'link'],
    ['schedule', 'link'],
  ])('resumes a wizard saved at the old step %s at %s', (old, expected) => {
    const { db, repo } = open()
    repo.ensure(false)
    db.prepare('UPDATE setup SET step = ?').run(old)
    expect(repo.get()?.step).toBe(expected)
    db.close()
  })

  it('records a consent once per account, provider and version; a newer version of the text asks again', () => {
    const { db, repo, registry } = open()
    registry.register('alpha')
    registry.register('beta')
    expect(repo.hasConsent('alpha', 'claude-cli', '', 1)).toBe(false)
    expect(repo.recordConsent('alpha', 'claude-cli', 1)).toBe(true)
    expect(repo.recordConsent('alpha', 'claude-cli', 1)).toBe(false)
    expect(repo.hasConsent('alpha', 'claude-cli', '', 1)).toBe(true)
    // the text is the current one or the consent does not count: a newer text asks again
    expect(repo.hasConsent('alpha', 'claude-cli', '', 2)).toBe(false)
    expect(repo.hasConsent('beta', 'claude-cli', '', 1)).toBe(false)
    expect(repo.hasConsent('alpha', 'other', '', 1)).toBe(false)
    expect(repo.consents('alpha')).toEqual([
      { provider: 'claude-cli', textVersion: 1, hosts: '', givenAt: expect.stringMatching(/^2026-11-17T/) },
    ])
    db.close()
  })

  it('deleting the account deletes its consents', () => {
    const { db, repo, registry } = open()
    registry.register('alpha')
    repo.recordConsent('alpha', 'claude-cli', 1)
    registry.remove('alpha')
    expect(repo.consents('alpha')).toEqual([])
    db.close()
  })
})
