import { afterEach, describe, expect, it } from 'vitest'
import { DeliverPending } from '../../../src/application/deliver-pending.js'
import { createGenerateDigest } from '../../../src/application/generate-digest.js'
import type { OutboxItem, OutboxRepository } from '../../../src/application/ports/outbox.js'
import { err, ok } from '../../../src/domain/result.js'
import { DEFAULT_SETTINGS } from '../../../src/domain/settings.js'
import { SqliteDigestStore, SqliteOutboxRepository } from '../../../src/infrastructure/persistence/sqlite/index.js'
import { createRenderers } from '../../../src/infrastructure/rendering/index.js'
import {
  deferred,
  FakeChannel,
  FakeSummarizer,
  FixedClock,
  InMemoryOutbox,
  InMemorySource,
} from '../../support/application-fakes.js'
import { TempDatabase } from '../../support/persistence-backends.js'
import { conversation, message } from '../domain/factories.js'
import { BA, ba } from '../rendering/support.js'

function queued(...parts: string[]): InMemoryOutbox {
  const outbox = new InMemoryOutbox()
  outbox.enqueue(...parts)
  return outbox
}

const pendingTexts = async (outbox: OutboxRepository) => (await outbox.pending()).map((i) => i.text)

describe('DeliverPending', () => {
  it('delivers the pending parts one by one, in order, and empties the outbox', async () => {
    const outbox = queued('one', 'two', 'three')
    const channel = new FakeChannel()
    const result = await new DeliverPending(outbox, channel).run()
    expect(result).toEqual({ delivered: 3, failure: null })
    expect(channel.delivered).toEqual(['one', 'two', 'three'])
    expect(await outbox.pending()).toEqual([])
  })

  it('does nothing when the outbox is empty', async () => {
    const channel = new FakeChannel()
    expect(await new DeliverPending(new InMemoryOutbox(), channel).run()).toEqual({ delivered: 0, failure: null })
    expect(channel.attempts).toEqual([])
  })

  it('stops at the first failure: later parts are not tried, and the failed one stays first', async () => {
    const outbox = queued('one', 'two', 'three')
    const channel = new FakeChannel((_text, call) => (call === 1 ? err('notConnected') : ok(undefined)))
    const result = await new DeliverPending(outbox, channel).run()
    expect(result).toEqual({ delivered: 1, failure: 'notConnected' })
    expect(channel.attempts).toEqual(['one', 'two'])
    expect(await pendingTexts(outbox)).toEqual(['two', 'three'])
  })

  it('reports each kind of failure the channel gives', async () => {
    for (const failure of ['notConnected', 'rejected', 'error'] as const) {
      const outbox = queued('a')
      const result = await new DeliverPending(outbox, new FakeChannel(() => err(failure))).run()
      expect(result).toEqual({ delivered: 0, failure })
      expect(await pendingTexts(outbox)).toEqual(['a'])
    }
  })

  it('retries later from the part that failed, keeping the order', async () => {
    const outbox = queued('one', 'two', 'three')
    let connected = false
    const channel = new FakeChannel((text) => (text === 'two' && !connected ? err('notConnected') : ok(undefined)))
    const deliver = new DeliverPending(outbox, channel)
    expect(await deliver.run()).toEqual({ delivered: 1, failure: 'notConnected' })
    connected = true
    expect(await deliver.run()).toEqual({ delivered: 2, failure: null })
    expect(channel.delivered).toEqual(['one', 'two', 'three'])
    expect(await outbox.pending()).toEqual([])
  })

  it('marks a part sent only after the channel confirmed it', async () => {
    const outbox = queued('one')
    const gate = deferred<void>()
    const channel = new FakeChannel(async () => {
      await gate.promise
      return ok(undefined)
    })
    const running = new DeliverPending(outbox, channel).run()
    await new Promise((r) => setTimeout(r, 5))
    expect(channel.attempts).toEqual(['one'])
    expect(await pendingTexts(outbox)).toEqual(['one']) // sending, not confirmed: still queued
    gate.resolve()
    await running
    expect(await outbox.pending()).toEqual([])
  })

  it('does not mark a part sent when the channel throws, and stops', async () => {
    const outbox = queued('one', 'two')
    const channel = new FakeChannel(() => {
      throw new Error('boom')
    })
    expect(await new DeliverPending(outbox, channel).run()).toEqual({ delivered: 0, failure: 'error' })
    expect(await pendingTexts(outbox)).toEqual(['one', 'two'])
  })

  it('stops with a storage failure when the outbox cannot be read', async () => {
    const broken: OutboxRepository = {
      pending: async () => {
        throw new Error('disk')
      },
      markSent: async () => true,
    }
    const channel = new FakeChannel()
    expect(await new DeliverPending(broken, channel).run()).toEqual({ delivered: 0, failure: 'storage' })
    expect(channel.attempts).toEqual([])
  })

  it('stops with a storage failure when a part cannot be marked, instead of sending on', async () => {
    const inner = queued('one', 'two')
    const broken: OutboxRepository = {
      pending: () => inner.pending(),
      markSent: async () => {
        throw new Error('disk')
      },
    }
    const channel = new FakeChannel()
    expect(await new DeliverPending(broken, channel).run()).toEqual({ delivered: 0, failure: 'storage' })
    expect(channel.attempts).toEqual(['one'])
  })

  it('never delivers the same part twice at the same time (single flight)', async () => {
    const outbox = queued('one', 'two')
    const gate = deferred<void>()
    const channel = new FakeChannel(async () => {
      await gate.promise
      return ok(undefined)
    })
    const deliver = new DeliverPending(outbox, channel)
    const first = deliver.run()
    const second = deliver.run()
    const third = deliver.run()
    await new Promise((r) => setTimeout(r, 5))
    expect(channel.attempts).toEqual(['one']) // one in flight; the other calls did not start their own
    gate.resolve()
    const results = await Promise.all([first, second, third])
    expect(channel.attempts).toEqual(['one', 'two'])
    expect(channel.delivered).toEqual(['one', 'two'])
    expect(results.every((r) => r.failure === null && r.delivered === 2)).toBe(true)
  })

  it('picks up parts committed while a run is going, without a second concurrent run', async () => {
    const outbox = queued('one')
    const gate = deferred<void>()
    const channel = new FakeChannel(async (text) => {
      if (text === 'one') await gate.promise
      return ok(undefined)
    })
    const deliver = new DeliverPending(outbox, channel)
    const first = deliver.run()
    await new Promise((r) => setTimeout(r, 5))
    outbox.enqueue('two') // a digest committed during the run
    const second = deliver.run()
    gate.resolve()
    await Promise.all([first, second])
    expect(channel.delivered).toEqual(['one', 'two'])
    expect(await outbox.pending()).toEqual([])
  })

  it('a call landing right after the last part was marked, at any moment, delivers the part that arrived with it', async () => {
    // Where exactly the call falls relative to the end of the running loop depends on the number of microtask ticks
    // after the last markSent resolved, so every offset is tried: none may leave the new part queued.
    for (let ticks = 0; ticks <= 12; ticks++) {
      const inner = queued('one')
      let second: Promise<unknown> = Promise.resolve()
      let injected = false
      let deliver!: DeliverPending
      const outbox: OutboxRepository = {
        pending: () => inner.pending(),
        markSent: async (id) => {
          const marked = await inner.markSent(id)
          if (injected) return marked // only the first part triggers the late call
          injected = true
          let chain: Promise<void> = Promise.resolve()
          for (let i = 0; i < ticks; i++) chain = chain.then(() => undefined)
          void chain.then(() => {
            inner.enqueue('two')
            second = deliver.run()
          })
          return marked
        },
      }
      const channel = new FakeChannel()
      deliver = new DeliverPending(outbox, channel)
      await deliver.run()
      await new Promise((r) => setTimeout(r, 0))
      await second
      expect(channel.delivered, `offset ${ticks}`).toEqual(['one', 'two'])
      expect(await inner.pending(), `offset ${ticks}`).toEqual([])
    }
  })

  it('an older run finishing never frees a newer run', async () => {
    const outbox = queued('one')
    const gate1 = deferred<void>()
    const gate2 = deferred<void>()
    let calls = 0
    const channel = new FakeChannel(async () => {
      calls++
      await (calls === 1 ? gate1.promise : gate2.promise)
      return ok(undefined)
    })
    const deliver = new DeliverPending(outbox, channel)
    const first = deliver.run()
    await new Promise((r) => setTimeout(r, 0))
    gate1.resolve()
    await first // the first run ended and freed the slot
    outbox.enqueue('two')
    const second = deliver.run() // a new run, waiting on gate2
    await new Promise((r) => setTimeout(r, 0))
    const third = deliver.run() // must join the second, not start a third delivery of 'two'
    gate2.resolve()
    await Promise.all([second, third])
    expect(channel.attempts).toEqual(['one', 'two'])
  })

  it('can run again once the previous run ended, even after a failure', async () => {
    const outbox = queued('one')
    let fail = true
    const channel = new FakeChannel(() => (fail ? err('error') : ok(undefined)))
    const deliver = new DeliverPending(outbox, channel)
    expect((await deliver.run()).failure).toBe('error')
    fail = false
    expect(await deliver.run()).toEqual({ delivered: 1, failure: null })
  })

  it('does not loop again after a failure, even if another call came in during the run', async () => {
    const outbox = queued('one')
    const gate = deferred<void>()
    const channel = new FakeChannel(async () => {
      await gate.promise
      return err('notConnected')
    })
    const deliver = new DeliverPending(outbox, channel)
    const first = deliver.run()
    const second = deliver.run()
    gate.resolve()
    expect(await Promise.all([first, second])).toEqual([
      { delivered: 0, failure: 'notConnected' },
      { delivered: 0, failure: 'notConnected' },
    ])
    expect(channel.attempts).toEqual(['one'])
  })
})

describe('DeliverPending on SQLite (RNF-08, RF-52)', () => {
  const temps: TempDatabase[] = []
  afterEach(() => {
    for (const temp of temps.splice(0)) temp.dispose()
  })
  const temp = () => {
    const t = new TempDatabase()
    temps.push(t)
    return t
  }

  it('delivers what is still queued after a restart, once, in order', async () => {
    const t = temp()
    const before = new SqliteDigestStore(t.open())
    await before.commit({ previousPointer: null, pointer: 1, digest: null, parts: ['part 1', 'part 2'] })
    // The first part goes out and is marked; the process dies before the second.
    const outbox1 = new SqliteOutboxRepository(before)
    const first = (await outbox1.pending())[0] as OutboxItem
    await outbox1.markSent(first.id)

    const after = new SqliteDigestStore(t.open()) // a new connection to the same file: the daemon restarted
    const channel = new FakeChannel()
    const result = await new DeliverPending(new SqliteOutboxRepository(after), channel).run()
    expect(result).toEqual({ delivered: 1, failure: null })
    expect(channel.delivered).toEqual(['part 2'])
    expect(after.pendingOutbox()).toEqual([])
  })

  it('keeps a failed part queued across a restart', async () => {
    const t = temp()
    const before = new SqliteDigestStore(t.open())
    await before.commit({ previousPointer: null, pointer: 1, digest: null, parts: ['a', 'b'] })
    await new DeliverPending(new SqliteOutboxRepository(before), new FakeChannel(() => err('notConnected'))).run()

    const after = new SqliteDigestStore(t.open())
    expect(after.pendingOutbox().map((e) => e.text)).toEqual(['a', 'b'])
    const channel = new FakeChannel()
    await new DeliverPending(new SqliteOutboxRepository(after), channel).run()
    expect(channel.delivered).toEqual(['a', 'b'])
  })

  it('end to end: GenerateDigest commits the parts, DeliverPending sends them in order, the outbox ends empty', async () => {
    const t = temp()
    const store = new SqliteDigestStore(t.open())
    const source = new InMemorySource()
    for (const id of ['5491100000001', '5491100000002', '5491100000003', '5491100000004']) {
      source.addConversation(conversation({ id, name: `Chat ${id}`, participantId: id, address: `+${id}` }))
      source.addParticipant({ id, savedName: `Chat ${id}`, publicName: null })
      source.addMessages(
        message({
          id: `${id}-0`,
          conversationId: id,
          senderId: id,
          timestamp: ba(3, 10, 5, 0),
          text: 'hello',
          senderAddress: `+${id}`,
        }),
      )
    }
    const summarizer = new FakeSummarizer(() =>
      ok({ resumen: 'y'.repeat(1_400), pendientes: [], necesita_respuesta: false, prioridad: 'media' }),
    )
    const generate = createGenerateDigest({
      source,
      summarizer,
      store,
      clock: new FixedClock(ba(3, 10, 12, 0)),
      renderers: createRenderers('en', BA),
    })
    const report = await generate({
      until: ba(3, 10, 12, 0),
      from: ba(3, 10, 0, 0),
      preview: false,
      settings: DEFAULT_SETTINGS,
      promptTemplate: null,
      platformName: 'WhatsApp',
    })
    if (!report.ok) throw new Error('digest failed')
    const parts = report.value.parts
    expect(parts.length).toBeGreaterThan(1)
    expect(store.pendingOutbox().map((e) => e.text)).toEqual(parts)

    const channel = new FakeChannel()
    const result = await new DeliverPending(new SqliteOutboxRepository(store), channel).run()
    expect(result).toEqual({ delivered: parts.length, failure: null })
    expect(channel.delivered).toEqual(parts)
    expect(store.pendingOutbox()).toEqual([])
    expect(store.outbox().every((e) => e.sentAt !== null)).toBe(true)
  })
})
