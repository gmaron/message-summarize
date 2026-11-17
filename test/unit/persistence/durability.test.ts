import { afterEach, describe, expect, it } from 'vitest'
import type { DigestCommit } from '../../../src/application/ports/digest-store.js'
import { SqliteDigestStore } from '../../../src/infrastructure/persistence/sqlite/index.js'
import { TempDatabase } from '../../support/persistence-backends.js'

const temp: TempDatabase[] = []
const fresh = (): TempDatabase => {
  const t = new TempDatabase()
  temp.push(t)
  return t
}
afterEach(() => {
  for (const t of temp.splice(0)) t.dispose()
})

const commit: DigestCommit = {
  previousPointer: null,
  pointer: 2_000,
  digest: { since: 1_000, until: 2_000, createdAt: 2_100, text: 'the digest', summarized: 2, failed: 0 },
  parts: ['part 1', 'part 2'],
}

describe('SqliteDigestStore durability (RNF-08, RF-52)', () => {
  it('keeps the pointer, the history and the outbox after the connection is closed and reopened', async () => {
    const t = fresh()
    const first = new SqliteDigestStore(t.open())
    expect((await first.commit(commit)).ok).toBe(true)
    first.markOutboxSent(1, 3_000)

    // A "restart": a new connection to the same file.
    const second = new SqliteDigestStore(t.open())
    expect(await second.getPointer()).toBe(2_000)
    expect(second.history()).toEqual([commit.digest])
    expect(second.outbox()).toEqual([
      { id: 1, digestId: 1, text: 'part 1', createdAt: 2_100, sentAt: 3_000 },
      { id: 2, digestId: 1, text: 'part 2', createdAt: 2_100, sentAt: null },
    ])
    expect(second.pendingOutbox().map((e) => e.text)).toEqual(['part 2'])
  })

  it('still refuses a stale commit after a restart', async () => {
    const t = fresh()
    await new SqliteDigestStore(t.open()).commit(commit)
    const result = await new SqliteDigestStore(t.open()).commit(commit)
    expect(result).toEqual({ ok: false, error: 'pointerChanged' })
    expect(new SqliteDigestStore(t.open()).history()).toHaveLength(1)
  })

  it('a second connection sees a commit made by a first one that was never closed (it lives in the WAL)', async () => {
    const t = fresh()
    const db = t.open()
    await new SqliteDigestStore(db).commit(commit)
    // No close() on the first connection. This is not a crash simulation: it shows committed data is visible through the WAL.
    const other = new SqliteDigestStore(t.open())
    expect(await other.getPointer()).toBe(2_000)
    expect(other.pendingOutbox()).toHaveLength(2)
  })

  it('saves nothing when a step of the commit fails: the pointer move is rolled back with it', async () => {
    const t = fresh()
    const store = new SqliteDigestStore(t.open(), () => 9_999)
    const broken: DigestCommit = { ...commit, parts: ['ok part', undefined as unknown as string] }
    await expect(store.commit(broken)).rejects.toThrow()
    expect(await store.getPointer()).toBeNull()
    expect(store.history()).toEqual([])
    expect(store.outbox()).toEqual([])
    // The store is usable afterwards.
    expect((await store.commit(commit)).ok).toBe(true)
    expect(store.outbox()).toHaveLength(2)
  })

  it('saves nothing when the digest itself is invalid', async () => {
    const t = fresh()
    const store = new SqliteDigestStore(t.open())
    const broken: DigestCommit = {
      ...commit,
      digest: { ...(commit.digest as NonNullable<DigestCommit['digest']>), text: null as unknown as string },
    }
    await expect(store.commit(broken)).rejects.toThrow()
    expect(await store.getPointer()).toBeNull()
    expect(store.outbox()).toEqual([])
  })

  it('uses its clock for the parts of a commit with no digest', async () => {
    const t = fresh()
    const store = new SqliteDigestStore(t.open(), () => 4_242)
    await store.commit({ previousPointer: null, pointer: 10, digest: null, parts: ['loose part'] })
    expect(store.outbox()[0]?.createdAt).toBe(4_242)
  })

  it('marks a part delivered once', async () => {
    const t = fresh()
    const store = new SqliteDigestStore(t.open())
    await store.commit(commit)
    expect(store.markOutboxSent(1, 5)).toBe(true)
    expect(store.markOutboxSent(1, 6)).toBe(false)
    expect(store.markOutboxSent(99, 6)).toBe(false)
    expect(store.outbox()[0]?.sentAt).toBe(5)
  })

  it('links every part to its digest, and a part with no digest to none', async () => {
    const t = fresh()
    const store = new SqliteDigestStore(t.open())
    await store.commit(commit)
    await store.commit({ previousPointer: 2_000, pointer: 3_000, digest: null, parts: ['loose'] })
    expect(store.outbox().map((e) => e.digestId)).toEqual([1, 1, null])
  })

  it('lets only one of two overlapping runs on two connections commit the same window', async () => {
    const t = fresh()
    const a = new SqliteDigestStore(t.open())
    const b = new SqliteDigestStore(t.open())
    await a.commit({ previousPointer: null, pointer: 1_000, digest: null, parts: [] })
    const run = (store: SqliteDigestStore, text: string) =>
      store.commit({
        previousPointer: 1_000,
        pointer: 2_000,
        digest: { since: 1_000, until: 2_000, createdAt: 2_100, text, summarized: 1, failed: 0 },
        parts: [text],
      })
    const [first, second] = await Promise.all([run(a, 'run A'), run(b, 'run B')])
    expect([first.ok, second.ok].sort()).toEqual([false, true])
    const check = new SqliteDigestStore(t.open())
    expect(check.history()).toHaveLength(1)
    expect(check.outbox()).toHaveLength(1)
    expect(await check.getPointer()).toBe(2_000)
  })
})
