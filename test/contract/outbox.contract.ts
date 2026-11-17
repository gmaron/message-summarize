import { afterEach, describe, expect, it } from 'vitest'
import type { OutboxRepository } from '../../src/application/ports/outbox.js'
import { SqliteDigestStore, SqliteOutboxRepository } from '../../src/infrastructure/persistence/sqlite/index.js'
import { InMemoryOutbox } from '../support/application-fakes.js'
import { TempDatabase } from '../support/persistence-backends.js'

export interface OutboxFixture {
  readonly outbox: OutboxRepository
  /** Queues parts the way a digest commit does. */
  enqueue(...parts: string[]): Promise<void>
  close(): void
}

export interface OutboxBackend {
  readonly name: string
  create(): Promise<OutboxFixture>
}

export const inMemoryOutboxBackend: OutboxBackend = {
  name: 'in-memory',
  async create() {
    const outbox = new InMemoryOutbox()
    return {
      outbox,
      enqueue: async (...parts) => {
        outbox.enqueue(...parts)
      },
      close() {},
    }
  },
}

export const sqliteOutboxBackend: OutboxBackend = {
  name: 'sqlite',
  async create() {
    const temp = new TempDatabase()
    const store = new SqliteDigestStore(temp.open())
    let pointer: number | null = null
    return {
      outbox: new SqliteOutboxRepository(store),
      enqueue: async (...parts) => {
        const next: number = (pointer ?? 0) + 1
        const result = await store.commit({ previousPointer: pointer, pointer: next, digest: null, parts })
        if (!result.ok) throw new Error('seed commit failed')
        pointer = next
      },
      close: () => temp.dispose(),
    }
  },
}

export const outboxBackends: readonly OutboxBackend[] = [inMemoryOutboxBackend, sqliteOutboxBackend]

/** Contract of the OutboxRepository port (src/application/ports/outbox.ts), for every adapter. */
export function describeOutboxContract(backend: OutboxBackend): void {
  describe(`OutboxRepository contract (${backend.name})`, () => {
    const open: OutboxFixture[] = []
    const make = async (): Promise<OutboxFixture> => {
      const fixture = await backend.create()
      open.push(fixture)
      return fixture
    }
    afterEach(() => {
      for (const fixture of open.splice(0)) fixture.close()
    })

    const texts = async (outbox: OutboxRepository) => (await outbox.pending()).map((i) => i.text)

    it('has nothing pending at first', async () => {
      const { outbox } = await make()
      expect(await outbox.pending()).toEqual([])
    })

    it('lists the pending parts in the order they were queued, across digests', async () => {
      const { outbox, enqueue } = await make()
      await enqueue('a1', 'a2')
      await enqueue('b1')
      expect(await texts(outbox)).toEqual(['a1', 'a2', 'b1'])
    })

    it('gives every part its own id', async () => {
      const { outbox, enqueue } = await make()
      await enqueue('x', 'y', 'z')
      const ids = (await outbox.pending()).map((i) => i.id)
      expect(new Set(ids).size).toBe(3)
    })

    it('stops listing a part once it is marked sent, and keeps the others in order', async () => {
      const { outbox, enqueue } = await make()
      await enqueue('one', 'two', 'three')
      const [first, second] = await outbox.pending()
      expect(await outbox.markSent(first?.id as number)).toBe(true)
      expect(await texts(outbox)).toEqual(['two', 'three'])
      expect(await outbox.markSent(second?.id as number)).toBe(true)
      expect(await texts(outbox)).toEqual(['three'])
    })

    it('says false for a part already marked, and for an id that does not exist', async () => {
      const { outbox, enqueue } = await make()
      await enqueue('one')
      const [item] = await outbox.pending()
      expect(await outbox.markSent(item?.id as number)).toBe(true)
      expect(await outbox.markSent(item?.id as number)).toBe(false)
      expect(await outbox.markSent(987_654)).toBe(false)
    })

    it('keeps the text exactly, including formatting and non-ASCII', async () => {
      const { outbox, enqueue } = await make()
      const text = '*Resumen*\n_ñandú_ \u{1f600} ```code```'
      await enqueue(text)
      expect(await texts(outbox)).toEqual([text])
    })
  })
}
