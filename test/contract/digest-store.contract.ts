import { afterEach, describe, expect, it } from 'vitest'
import type { DigestCommit, DigestRecord } from '../../src/application/ports/digest-store.js'
import type { PersistenceBackend, StoreFixture } from '../support/persistence-backends.js'

/** Contract of the DigestStore port (src/application/ports/digest-store.ts), for every adapter. */
export function describeDigestStoreContract(backend: PersistenceBackend): void {
  describe(`DigestStore contract (${backend.name})`, () => {
    const open: StoreFixture[] = []
    const make = async (pointer: number | null = null): Promise<StoreFixture> => {
      const fixture = await backend.store(pointer)
      open.push(fixture)
      return fixture
    }
    afterEach(() => {
      for (const fixture of open.splice(0)) fixture.close()
    })

    const record = (overrides: Partial<DigestRecord> = {}): DigestRecord => ({
      since: 1_000,
      until: 2_000,
      createdAt: 2_500,
      text: 'digest á \u{1f600}',
      summarized: 3,
      failed: 1,
      ...overrides,
    })
    const commitOf = (overrides: Partial<DigestCommit> = {}): DigestCommit => ({
      previousPointer: null,
      pointer: 2_000,
      digest: record(),
      parts: ['part 1', 'part 2'],
      ...overrides,
    })

    it('has no pointer at first', async () => {
      const { store } = await make()
      expect(await store.getPointer()).toBeNull()
    })

    it('saves the digest, enqueues the parts in order and moves the pointer', async () => {
      const fixture = await make()
      const result = await fixture.store.commit(commitOf())
      expect(result).toEqual({ ok: true, value: undefined })
      expect(await fixture.store.getPointer()).toBe(2_000)
      expect(fixture.history()).toEqual([record()])
      expect(fixture.outbox()).toEqual(['part 1', 'part 2'])
    })

    it('moves the pointer and saves nothing else for an empty window (no digest, no parts)', async () => {
      const fixture = await make()
      const result = await fixture.store.commit(commitOf({ digest: null, parts: [], pointer: 5_000 }))
      expect(result.ok).toBe(true)
      expect(await fixture.pointer()).toBe(5_000)
      expect(fixture.history()).toEqual([])
      expect(fixture.outbox()).toEqual([])
    })

    it('accepts the next commit when it names the pointer it read', async () => {
      const fixture = await make()
      await fixture.store.commit(commitOf({ parts: ['first'] }))
      const second = await fixture.store.commit(
        commitOf({
          previousPointer: 2_000,
          pointer: 4_000,
          digest: record({ since: 2_000, until: 4_000, text: 'second' }),
          parts: ['second'],
        }),
      )
      expect(second.ok).toBe(true)
      expect(await fixture.pointer()).toBe(4_000)
      expect(fixture.history().map((d) => d.text)).toEqual([record().text, 'second'])
      expect(fixture.outbox()).toEqual(['first', 'second'])
    })

    it('starts from a pointer that already exists', async () => {
      const fixture = await make(7_000)
      expect(await fixture.store.getPointer()).toBe(7_000)
      expect((await fixture.store.commit(commitOf({ previousPointer: 7_000, pointer: 8_000 }))).ok).toBe(true)
      expect(await fixture.pointer()).toBe(8_000)
    })

    it('refuses a commit whose previous pointer is stale, and saves nothing', async () => {
      const fixture = await make(7_000)
      const result = await fixture.store.commit(commitOf({ previousPointer: 6_000, pointer: 9_000 }))
      expect(result).toEqual({ ok: false, error: 'pointerChanged' })
      expect(await fixture.pointer()).toBe(7_000)
      expect(fixture.history()).toEqual([])
      expect(fixture.outbox()).toEqual([])
    })

    it('refuses a commit that expects no pointer when there is one', async () => {
      const fixture = await make(7_000)
      const result = await fixture.store.commit(commitOf({ previousPointer: null }))
      expect(result).toEqual({ ok: false, error: 'pointerChanged' })
      expect(await fixture.pointer()).toBe(7_000)
      expect(fixture.history()).toEqual([])
      expect(fixture.outbox()).toEqual([])
    })

    it('refuses a commit that expects a pointer when there is none', async () => {
      const fixture = await make(null)
      const result = await fixture.store.commit(commitOf({ previousPointer: 1_000 }))
      expect(result).toEqual({ ok: false, error: 'pointerChanged' })
      expect(await fixture.pointer()).toBeNull()
      expect(fixture.history()).toEqual([])
      expect(fixture.outbox()).toEqual([])
    })

    it('tells a pointer of 0 apart from no pointer', async () => {
      const fixture = await make(0)
      expect(await fixture.store.getPointer()).toBe(0)
      expect((await fixture.store.commit(commitOf({ previousPointer: null }))).ok).toBe(false)
      expect((await fixture.store.commit(commitOf({ previousPointer: 0, pointer: 10 }))).ok).toBe(true)
    })

    it('lets only one of two overlapping runs commit the same window', async () => {
      const fixture = await make(1_000)
      const run = (text: string) =>
        fixture.store.commit(commitOf({ previousPointer: 1_000, digest: record({ text }), parts: [text] }))
      const [a, b] = await Promise.all([run('run A'), run('run B')])
      expect([a.ok, b.ok].sort()).toEqual([false, true])
      expect(fixture.history()).toHaveLength(1)
      expect(fixture.outbox()).toHaveLength(1)
      expect(fixture.history()[0]?.text).toBe(fixture.outbox()[0])
    })

    it('does not enqueue anything for a refused commit even when it has many parts', async () => {
      const fixture = await make(5)
      await fixture.store.commit(commitOf({ previousPointer: 4, parts: ['a', 'b', 'c', 'd'] }))
      expect(fixture.outbox()).toEqual([])
    })
  })
}
