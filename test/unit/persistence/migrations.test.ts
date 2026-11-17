import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  currentVersion,
  MIGRATIONS,
  type Migration,
  migrate,
  openDatabase,
} from '../../../src/infrastructure/persistence/sqlite/index.js'
import { TempDatabase } from '../../support/persistence-backends.js'

const posix = process.platform === 'win32' ? it.skip : it
const temp: TempDatabase[] = []
const fresh = (): TempDatabase => {
  const t = new TempDatabase()
  temp.push(t)
  return t
}
afterEach(() => {
  for (const t of temp.splice(0)) t.dispose()
})

const tables = (db: ReturnType<TempDatabase['open']>): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_'))

describe('openDatabase and migrations', () => {
  it('creates the schema in a fresh database and records the version', () => {
    const t = fresh()
    const db = t.open()
    expect(currentVersion(db)).toBe(MIGRATIONS.length)
    expect(currentVersion(db)).toBe(3)
    expect(tables(db)).toEqual([
      'account',
      'conversations',
      'digest_pointer',
      'digests',
      'messages',
      'outbox',
      'participants',
      'schema_version',
    ])
  })

  it('reopening changes nothing: same version, one row per migration', () => {
    const t = fresh()
    const first = t.open()
    const applied = first.prepare('SELECT version, applied_at FROM schema_version').all()
    first.close()
    const second = t.open()
    expect(second.prepare('SELECT version, applied_at FROM schema_version').all()).toEqual(applied)
    expect(currentVersion(second)).toBe(3)
  })

  it('upgrades a database at version 1 to the latest without touching its data', () => {
    const t = fresh()
    const first = openDatabase(t.path, { migrations: MIGRATIONS.slice(0, 1) })
    first.exec('INSERT INTO digest_pointer (id, pointer) VALUES (1, 77)')
    expect(currentVersion(first)).toBe(1)
    first.close()
    const upgraded = t.open()
    expect(currentVersion(upgraded)).toBe(MIGRATIONS.length)
    expect(upgraded.prepare('SELECT pointer FROM digest_pointer').all()).toEqual([{ pointer: 77 }])
    expect(upgraded.prepare('SELECT COUNT(*) AS n FROM account').get()).toEqual({ n: 0 })
  })

  describe('migration 3 (audio transcription)', () => {
    const columns = (db: ReturnType<TempDatabase['open']>): string[] =>
      (db.prepare("SELECT name FROM pragma_table_info('messages') ORDER BY cid").all() as { name: string }[]).map(
        (r) => r.name,
      )

    it('adds the media and transcription columns to a database that has messages, and keeps them untouched', () => {
      const t = fresh()
      // A database as the previous release left it: version 2, with a conversation, a text and an audio that has a transcript.
      const old = openDatabase(t.path, { migrations: MIGRATIONS.slice(0, 2) })
      expect(columns(old)).not.toContain('media_ref')
      old.exec(`INSERT INTO conversations (id, address) VALUES ('c1', '+1')`)
      old.exec(`INSERT INTO messages (conversation_id, id, from_me, timestamp, kind, text, transcript)
                VALUES ('c1', 'm1', 0, 1000, 'text', 'hello', NULL),
                       ('c1', 'm2', 0, 2000, 'audio', '[audio]', 'an old transcript')`)
      old.close()

      const upgraded = t.open()
      expect(currentVersion(upgraded)).toBe(3)
      expect(columns(upgraded)).toEqual(expect.arrayContaining(['media_ref', 'transcribe_status', 'transcribe_error']))
      expect(
        upgraded
          .prepare(
            'SELECT id, text, transcript, media_ref, transcribe_status, transcribe_error FROM messages ORDER BY id',
          )
          .all(),
      ).toEqual([
        { id: 'm1', text: 'hello', transcript: null, media_ref: null, transcribe_status: null, transcribe_error: null },
        {
          id: 'm2',
          text: '[audio]',
          transcript: 'an old transcript',
          media_ref: null,
          transcribe_status: null,
          transcribe_error: null,
        },
      ])
    })

    it('only accepts the three statuses', () => {
      const db = fresh().open()
      db.exec(`INSERT INTO conversations (id, address) VALUES ('c1', '+1')`)
      const insert = (status: string): void =>
        db.exec(`INSERT INTO messages (conversation_id, id, from_me, timestamp, kind, transcribe_status)
                 VALUES ('c1', 'm-${status}', 0, 1, 'audio', '${status}')`)
      for (const status of ['pending', 'done', 'failed']) expect(() => insert(status)).not.toThrow()
      expect(() => insert('lost')).toThrow()
    })
  })

  it('uses WAL, foreign keys and a busy timeout', () => {
    const db = fresh().open()
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
    expect((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5000)
  })

  it('refuses a message whose conversation does not exist (foreign key)', () => {
    const db = fresh().open()
    expect(() =>
      db
        .prepare(
          "INSERT INTO messages (conversation_id, id, from_me, timestamp, kind) VALUES ('ghost', 'm1', 0, 1, 'text')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i)
  })

  posix('creates the file with permissions 0600', () => {
    const t = fresh()
    t.open()
    expect(statSync(t.path).mode & 0o777).toBe(0o600)
  })

  posix('gives the WAL side files owner-only permissions too, and they exist', () => {
    const t = fresh()
    const db = t.open()
    db.exec("INSERT INTO participants (id) VALUES ('p1')")
    for (const suffix of ['-wal', '-shm']) {
      expect(existsSync(t.path + suffix)).toBe(true)
      expect(statSync(t.path + suffix).mode & 0o777).toBe(0o600)
    }
  })

  posix('tightens existing -wal and -shm files that had wider permissions', () => {
    const t = fresh()
    const first = t.open() // keeps the side files alive
    first.exec("INSERT INTO participants (id) VALUES ('p1')")
    for (const suffix of ['-wal', '-shm']) chmodSync(t.path + suffix, 0o644)
    t.open()
    for (const suffix of ['-wal', '-shm']) expect(statSync(t.path + suffix).mode & 0o777).toBe(0o600)
  })

  posix('tightens a file that already existed with wider permissions', () => {
    const t = fresh()
    writeFileSync(t.path, '', { mode: 0o644 })
    t.open()
    expect(statSync(t.path).mode & 0o777).toBe(0o600)
  })

  it('applies only the migrations the database lacks, keeping its data', () => {
    const t = fresh()
    const v1: Migration = { version: 1, description: 'one', sql: 'CREATE TABLE a (x INTEGER)' }
    const v2: Migration = { version: 2, description: 'two', sql: 'CREATE TABLE b (y INTEGER)' }
    const first = openDatabase(t.path, { migrations: [v1] })
    first.exec('INSERT INTO a VALUES (42)')
    expect(currentVersion(first)).toBe(1)
    first.close()
    const second = openDatabase(t.path, { migrations: [v1, v2] })
    expect(currentVersion(second)).toBe(2)
    expect(second.prepare('SELECT x FROM a').all()).toEqual([{ x: 42 }])
    expect(tables(second)).toContain('b')
    second.close()
  })

  it('rolls back a migration that fails, leaving the previous version', () => {
    const t = fresh()
    const v1: Migration = { version: 1, description: 'one', sql: 'CREATE TABLE a (x INTEGER)' }
    const bad: Migration = { version: 2, description: 'bad', sql: 'CREATE TABLE b (y INTEGER); SELECT * FROM missing' }
    openDatabase(t.path, { migrations: [v1] }).close()
    expect(() => openDatabase(t.path, { migrations: [v1, bad] })).toThrow()
    const db = openDatabase(t.path, { migrations: [v1] })
    expect(currentVersion(db)).toBe(1)
    expect(tables(db)).not.toContain('b')
    db.close()
  })

  it('refuses a database from a newer release', () => {
    const t = fresh()
    const v1: Migration = { version: 1, description: 'one', sql: 'CREATE TABLE a (x INTEGER)' }
    const v2: Migration = { version: 2, description: 'two', sql: 'CREATE TABLE b (y INTEGER)' }
    openDatabase(t.path, { migrations: [v1, v2] }).close()
    expect(() => openDatabase(t.path, { migrations: [v1] })).toThrow(/newer/)
  })

  it('rejects a migration list that is not numbered 1, 2, 3...', () => {
    const t = fresh()
    const skipped: Migration = { version: 2, description: 'skips one', sql: 'SELECT 1' }
    expect(() => openDatabase(t.path, { migrations: [skipped] })).toThrow(/numbered/)
  })

  it('has the schema pieces: seq order key, digest_id on the outbox, unread stamp', () => {
    const db = fresh().open()
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    expect(columns('messages')).toContain('seq')
    expect(columns('outbox')).toContain('digest_id')
    expect(columns('conversations')).toContain('unread_updated_at')
  })

  describe('migrations that rebuild tables (foreignKeys: false)', () => {
    const base: Migration = {
      version: 1,
      description: 'parent and child',
      sql: `CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent (id));
            INSERT INTO parent VALUES (1); INSERT INTO child VALUES (10, 1);`,
    }
    const rebuild: Migration = {
      version: 2,
      description: 'rebuild parent (needs foreign keys off)',
      foreignKeys: false,
      sql: `CREATE TABLE parent_new (id INTEGER PRIMARY KEY, label TEXT);
            INSERT INTO parent_new (id) SELECT id FROM parent;
            DROP TABLE parent;
            ALTER TABLE parent_new RENAME TO parent;`,
    }
    const fkOn = (db: DatabaseSync) =>
      (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys

    it('runs with foreign keys off, keeps the data and turns them on again', () => {
      const t = fresh()
      openDatabase(t.path, { migrations: [base] }).close()
      const db = openDatabase(t.path, { migrations: [base, rebuild] })
      expect(currentVersion(db)).toBe(2)
      expect(db.prepare('SELECT id, label FROM parent').all()).toEqual([{ id: 1, label: null }])
      expect(db.prepare('SELECT parent_id FROM child').all()).toEqual([{ parent_id: 1 }])
      expect(fkOn(db)).toBe(1)
      db.close()
    })

    it('without foreignKeys: false the same rebuild fails, because DROP TABLE cascades checks', () => {
      const t = fresh()
      const plain: Migration = { ...rebuild, foreignKeys: true }
      openDatabase(t.path, { migrations: [base] }).close()
      // With foreign keys on, DROP TABLE parent does an implicit delete that violates the child row.
      expect(() => openDatabase(t.path, { migrations: [base, plain] })).toThrow()
    })

    it('fails and rolls back when the migration leaves a violation, and turns foreign keys on again', () => {
      const t = fresh()
      const breaking: Migration = {
        version: 2,
        description: 'orphans a child',
        foreignKeys: false,
        sql: 'DELETE FROM parent',
      }
      openDatabase(t.path, { migrations: [base] }).close()
      const raw = new DatabaseSync(t.path)
      raw.exec('PRAGMA foreign_keys = ON')
      expect(() => migrate(raw, [base, breaking])).toThrow(/foreign key violation/)
      expect(fkOn(raw)).toBe(1)
      expect(currentVersion(raw)).toBe(1)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM parent').get()).toEqual({ n: 1 })
      raw.close()
    })
  })

  it('re-checks the version inside the transaction: a migration another connection applied first is not run twice', () => {
    const t = fresh()
    const v1: Migration = { version: 1, description: 'one', sql: 'CREATE TABLE a (x INTEGER)' }
    const a = new DatabaseSync(t.path)
    // Between "a migration is pending" and its transaction, connection B applies it.
    migrate(a, [v1], {
      beforeApply: () => {
        openDatabase(t.path, { migrations: [v1] }).close()
      },
    })
    expect(currentVersion(a)).toBe(1)
    expect(a.prepare('SELECT COUNT(*) AS n FROM schema_version').get()).toEqual({ n: 1 })
    a.close()
  })
})
