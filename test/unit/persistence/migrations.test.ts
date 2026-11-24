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
    expect(currentVersion(db)).toBe(MIGRATIONS.length)
    expect(tables(db)).toEqual([
      'account',
      'asks',
      'conversations',
      'digest_pointer',
      'digest_runs',
      'digests',
      'locations',
      'media',
      'messages',
      'orders',
      'outbox',
      'participants',
      'poll_votes',
      'polls',
      'products',
      'reactions',
      'schema_version',
      'shared_contacts',
    ])
  })

  it('reopening changes nothing: same version, one row per migration', () => {
    const t = fresh()
    const first = t.open()
    const applied = first.prepare('SELECT version, applied_at FROM schema_version').all()
    first.close()
    const second = t.open()
    expect(second.prepare('SELECT version, applied_at FROM schema_version').all()).toEqual(applied)
    expect(currentVersion(second)).toBe(MIGRATIONS.length)
  })

  it('upgrades a database at version 2 to 3 keeping its data and adding the runs table (RF-74, RNF-16)', () => {
    const t = fresh()
    const first = openDatabase(t.path, { migrations: MIGRATIONS.slice(0, 2) })
    first.exec('INSERT INTO digest_pointer (id, pointer) VALUES (1, 500)')
    first.exec(
      "INSERT INTO digests (since, until, created_at, text, summarized, failed) VALUES (1, 2, 3, 'old digest', 4, 5)",
    )
    first.exec("INSERT INTO outbox (digest_id, text, created_at) VALUES (1, 'part', 3)")
    first.exec("INSERT INTO account (id, jid, linked_at) VALUES (1, '9911243739479@s.whatsapp.net', 9)")
    expect(currentVersion(first)).toBe(2)
    first.close()
    // Only up to version 3: the runs table is what this test is about (migration 4 is covered below).
    const upgraded = openDatabase(t.path, { migrations: MIGRATIONS.slice(0, 3) })
    expect(currentVersion(upgraded)).toBe(3)
    expect(upgraded.prepare('SELECT pointer FROM digest_pointer').all()).toEqual([{ pointer: 500 }])
    expect(upgraded.prepare('SELECT text, summarized, failed FROM digests').all()).toEqual([
      { text: 'old digest', summarized: 4, failed: 5 },
    ])
    expect(upgraded.prepare('SELECT digest_id, text FROM outbox').all()).toEqual([{ digest_id: 1, text: 'part' }])
    expect(upgraded.prepare('SELECT jid FROM account').all()).toEqual([{ jid: '9911243739479@s.whatsapp.net' }])
    expect(upgraded.prepare('SELECT COUNT(*) AS n FROM digest_runs').get()).toEqual({ n: 0 })
    // The new table works on the migrated database, and an old digest can be referenced by a run.
    upgraded.exec("INSERT INTO digest_runs (trigger_kind, started_at, digest_id) VALUES ('manual', 10, 1)")
    expect(() => upgraded.exec("INSERT INTO digest_runs (trigger_kind, started_at) VALUES ('bogus', 10)")).toThrow()
    expect(() =>
      upgraded.exec("INSERT INTO digest_runs (trigger_kind, started_at, outcome) VALUES ('cli', 10, 'failed')"),
    ).toThrow()
    // opened here, not through t.open(): Windows cannot delete a database file that is still open
    upgraded.close()
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

  describe('migration 4 (audio transcription)', () => {
    const columns = (db: ReturnType<TempDatabase['open']>): string[] =>
      (db.prepare("SELECT name FROM pragma_table_info('messages') ORDER BY cid").all() as { name: string }[]).map(
        (r) => r.name,
      )

    it('adds the media and transcription columns to a database that has messages, and keeps them untouched', () => {
      const t = fresh()
      // A database as the released version left it: version 3 (with the digest runs), a conversation, a text, an audio
      // that has a transcript, and a run of the history.
      const old = openDatabase(t.path, { migrations: MIGRATIONS.slice(0, 3) })
      expect(currentVersion(old)).toBe(3)
      expect(columns(old)).not.toContain('media_ref')
      old.exec(`INSERT INTO conversations (id, address) VALUES ('c1', '+1')`)
      old.exec(`INSERT INTO messages (conversation_id, id, from_me, timestamp, kind, text, transcript)
                VALUES ('c1', 'm1', 0, 1000, 'text', 'hello', NULL),
                       ('c1', 'm2', 0, 2000, 'audio', '[audio]', 'an old transcript')`)
      old.exec("INSERT INTO digest_runs (trigger_kind, started_at) VALUES ('manual', 10)")
      old.close()

      const upgraded = t.open()
      expect(currentVersion(upgraded)).toBe(MIGRATIONS.length)
      expect(upgraded.prepare('SELECT trigger_kind, started_at FROM digest_runs').all()).toEqual([
        { trigger_kind: 'manual', started_at: 10 },
      ])
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

  describe('migration 5 (audio queue claims and media re-upload)', () => {
    it('adds the claim and re-upload columns to a database at version 4 and keeps its queues untouched', () => {
      const t = fresh()
      const old = openDatabase(t.path, { migrations: MIGRATIONS.slice(0, 4) })
      expect(currentVersion(old)).toBe(4)
      old.exec(`INSERT INTO conversations (id, address) VALUES ('c1', '+1')`)
      old.exec(`INSERT INTO messages (conversation_id, id, from_me, timestamp, kind, transcribe_status, media_ref)
                VALUES ('c1', 'm1', 0, 1000, 'audio', 'pending', 'm1.ogg'),
                       ('c1', 'm2', 0, 2000, 'audio', 'download_pending', NULL)`)
      old.close()

      const upgraded = t.open()
      expect(currentVersion(upgraded)).toBe(MIGRATIONS.length)
      const columns = (
        upgraded.prepare("SELECT name FROM pragma_table_info('messages')").all() as { name: string }[]
      ).map((r) => r.name)
      expect(columns).toEqual(
        expect.arrayContaining([
          'transcribe_claimed_at',
          'dl_remote_jid',
          'dl_from_me',
          'dl_participant',
          'dl_reupload_attempts',
          'dl_needs_reupload',
        ]),
      )
      expect(
        upgraded
          .prepare(
            `SELECT id, transcribe_status, transcribe_claimed_at, dl_remote_jid, dl_reupload_attempts, dl_needs_reupload
             FROM messages ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: 'm1',
          transcribe_status: 'pending',
          transcribe_claimed_at: null,
          dl_remote_jid: null,
          dl_reupload_attempts: 0,
          dl_needs_reupload: 0,
        },
        {
          id: 'm2',
          transcribe_status: 'download_pending',
          transcribe_claimed_at: null,
          dl_remote_jid: null,
          dl_reupload_attempts: 0,
          dl_needs_reupload: 0,
        },
      ])
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

describe('migration 5 (raw content and typed message details)', () => {
  it('adds the columns and tables to a big database without touching or rewriting its rows, and fast', () => {
    const t = fresh()
    const old = openDatabase(t.path, { migrations: MIGRATIONS.slice(0, 4) })
    expect(currentVersion(old)).toBe(4)
    old.exec(`INSERT INTO conversations (id, address) VALUES ('c1', '+1')`)
    old.exec('BEGIN')
    const insert = old.prepare(
      `INSERT INTO messages (conversation_id, id, from_me, timestamp, kind, text, transcript, read)
       VALUES ('c1', ?, 0, ?, 'text', ?, NULL, 1)`,
    )
    for (let i = 0; i < 140_000; i++) insert.run(`m${i}`, 1000 + i, `text ${i}`)
    old.exec('COMMIT')
    old.close()

    const started = performance.now()
    const upgraded = t.open()
    const elapsed = performance.now() - started
    expect(currentVersion(upgraded)).toBe(MIGRATIONS.length)
    // ADD COLUMN with a constant default rewrites nothing: seconds would mean a rebuild of the table.
    expect(elapsed).toBeLessThan(3_000)
    expect(upgraded.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 140_000 })
    expect(
      upgraded
        .prepare(
          `SELECT id, text, read, raw, quoted_id, quoted_kind, quoted_text, quoted_from_status, forwarded, is_view_once
           FROM messages WHERE id = 'm7'`,
        )
        .get(),
    ).toEqual({
      id: 'm7',
      text: 'text 7',
      read: 1,
      raw: null,
      quoted_id: null,
      quoted_kind: null,
      quoted_text: null,
      quoted_from_status: 0,
      forwarded: 0,
      is_view_once: 0,
    })
    expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    upgraded.close()
  })

  it('removes the details of a message together with it', () => {
    const t = fresh()
    const db = t.open()
    db.exec(`INSERT INTO conversations (id, address) VALUES ('c1', '+1')`)
    db.exec(`INSERT INTO messages (conversation_id, id, from_me, timestamp, kind) VALUES ('c1', 'm1', 0, 1, 'image')`)
    db.exec(`INSERT INTO media (message_seq, kind) SELECT seq, 'image' FROM messages`)
    db.exec(`INSERT INTO shared_contacts (message_seq, display_name) SELECT seq, 'Ana' FROM messages`)
    db.exec('DELETE FROM messages')
    expect(db.prepare('SELECT COUNT(*) AS n FROM media').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM shared_contacts').get()).toEqual({ n: 0 })
    db.close()
  })
})
