import { afterEach, describe, expect, it } from 'vitest'
import { ASK_HISTORY_LIMIT, type NewAsk } from '../../../src/application/ports/ask-history.js'
import {
  currentVersion,
  MIGRATIONS,
  openDatabase,
  SqliteAskHistory,
} from '../../../src/infrastructure/persistence/sqlite/index.js'
import { TempDatabase } from '../../support/persistence-backends.js'

const temp: TempDatabase[] = []
afterEach(() => {
  for (const t of temp.splice(0)) t.dispose()
})
const fresh = (): TempDatabase => {
  const t = new TempDatabase()
  temp.push(t)
  return t
}

const ask = (overrides: Partial<NewAsk> = {}): NewAsk => ({
  createdAt: 1_000,
  question: 'who asked me for money?\n- list',
  selection: 'unanswered',
  period: 'd3',
  since: 10,
  until: 20,
  chats: ['ana', 'id:1'],
  deliver: true,
  ...overrides,
})

const result = {
  answer: '## Loans\n- **Ana**: 500',
  provider: 'claude-cli',
  chats: 2,
  messages: 7,
  leftOutLocalOnly: 1,
  parts: 3,
  calls: 4,
}

describe('migration 7 (the Ask history)', () => {
  it('adds the asks table to a database at version 6 and keeps its data', () => {
    const t = fresh()
    const old = openDatabase(t.path, { migrations: MIGRATIONS.slice(0, 6) })
    old.exec('INSERT INTO digest_pointer (id, pointer) VALUES (1, 77)')
    expect(currentVersion(old)).toBe(6)
    expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'asks'").get()).toBeUndefined()
    old.close()
    const upgraded = t.open()
    expect(currentVersion(upgraded)).toBe(MIGRATIONS.length)
    expect(MIGRATIONS[6]?.description).toBe('Ask history')
    expect(upgraded.prepare('SELECT pointer FROM digest_pointer').all()).toEqual([{ pointer: 77 }])
    expect(upgraded.prepare('SELECT COUNT(*) AS n FROM asks').get()).toEqual({ n: 0 })
  })

  it('has no per-conversation columns or mode', () => {
    const db = fresh().open()
    const columns = (
      db.prepare("SELECT name FROM pragma_table_info('asks') ORDER BY cid").all() as { name: string }[]
    ).map((r) => r.name)
    expect(columns).toEqual([
      'id',
      'created_at',
      'finished_at',
      'state',
      'question',
      'selection',
      'period',
      'since',
      'until',
      'chats',
      'deliver',
      'outbox_id',
      'result',
      'error',
    ])
  })
})

describe('SqliteAskHistory', () => {
  it('stores a request as running, finishes it with the result and lists it newest first', async () => {
    const history = new SqliteAskHistory(fresh().open())
    const first = await history.start(ask())
    const second = await history.start(ask({ question: 'second' }))
    expect([first, second]).toEqual([1, 2])
    expect((await history.list())[1]).toMatchObject({
      id: 1,
      state: 'running',
      finishedAt: null,
      result: null,
      error: null,
      question: 'who asked me for money?\n- list',
      selection: 'unanswered',
      period: 'd3',
      since: 10,
      until: 20,
      chats: ['ana', 'id:1'],
      deliver: true,
      outboxId: null,
    })
    expect(await history.finish(1, { finishedAt: 2_000, state: 'done', result, outboxId: 9 })).toBe(true)
    const [newest, done] = await history.list()
    expect(newest?.id).toBe(2)
    expect(done).toMatchObject({ id: 1, state: 'done', finishedAt: 2_000, result, outboxId: 9, error: null })
  })

  it('records a failure with its code', async () => {
    const history = new SqliteAskHistory(fresh().open())
    const id = await history.start(ask({ deliver: false }))
    await history.finish(id, { finishedAt: 5, state: 'failed', error: 'tooMuch' })
    expect((await history.list())[0]).toMatchObject({ state: 'failed', error: 'tooMuch', result: null, deliver: false })
  })

  it('says false when finishing or deleting what does not exist (it was deleted meanwhile)', async () => {
    const history = new SqliteAskHistory(fresh().open())
    expect(await history.finish(99, { finishedAt: 1, state: 'done' })).toBe(false)
    expect(await history.remove(99)).toBe(false)
  })

  it('keeps only the latest 50 per account and drops the oldest ones', async () => {
    expect(ASK_HISTORY_LIMIT).toBe(50)
    const history = new SqliteAskHistory(fresh().open())
    for (let n = 1; n <= 53; n++) await history.start(ask({ question: `q${n}` }))
    const list = await history.list()
    expect(list).toHaveLength(50)
    expect(list[0]?.question).toBe('q53')
    expect(list.at(-1)?.question).toBe('q4')
  })

  it('deletes one request and leaves the others', async () => {
    const history = new SqliteAskHistory(fresh().open())
    await history.start(ask({ question: 'a' }))
    await history.start(ask({ question: 'b' }))
    expect(await history.remove(1)).toBe(true)
    expect((await history.list()).map((a) => a.question)).toEqual(['b'])
    expect(await history.remove(1)).toBe(false)
  })

  it('survives a restart: a new connection to the file reads what was stored', async () => {
    const t = fresh()
    const first = new SqliteAskHistory(t.open())
    const id = await first.start(ask())
    await first.finish(id, { finishedAt: 2, state: 'done', result })
    // The second connection is closed by hand: TempDatabase only closes its own, and Windows cannot delete an open file.
    const db = openDatabase(t.path)
    try {
      const reopened = new SqliteAskHistory(db)
      expect((await reopened.list())[0]).toMatchObject({ id, state: 'done', result })
    } finally {
      db.close()
    }
  })

  it('closes what was left running as failed (interrupted) and leaves finished ones alone', async () => {
    const history = new SqliteAskHistory(fresh().open())
    const done = await history.start(ask())
    await history.finish(done, { finishedAt: 2, state: 'done', result })
    await history.start(ask())
    expect(await history.failRunning(10)).toBe(1)
    expect(await history.failRunning(11)).toBe(0)
    const [interrupted, kept] = await history.list()
    expect(interrupted).toMatchObject({ state: 'failed', error: 'interrupted', finishedAt: 10 })
    expect(kept).toMatchObject({ state: 'done', finishedAt: 2 })
  })

  it('clears everything', async () => {
    const history = new SqliteAskHistory(fresh().open())
    await history.start(ask())
    await history.start(ask())
    expect(await history.clear()).toBe(2)
    expect(await history.list()).toEqual([])
  })

  it('keeps the text exactly, with line breaks and non-ASCII', async () => {
    const history = new SqliteAskHistory(fresh().open())
    const id = await history.start(ask({ question: 'línea 1\n\nlínea 2 — ñ 🎂' }))
    await history.finish(id, { finishedAt: 1, state: 'done', result: { ...result, answer: 'Respuesta\n- 🎂 ñ' } })
    const [row] = await history.list()
    expect(row?.question).toBe('línea 1\n\nlínea 2 — ñ 🎂')
    expect(row?.result?.answer).toBe('Respuesta\n- 🎂 ñ')
  })
})
