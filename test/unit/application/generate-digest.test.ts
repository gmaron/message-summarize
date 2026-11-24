import { describe, expect, it } from 'vitest'
import { createGenerateDigest, type GenerateDigestRequest } from '../../../src/application/generate-digest.js'
import type { Summarizer } from '../../../src/application/ports/summarizer.js'
import type { UnreadState } from '../../../src/domain/model.js'
import { err, ok, type Result } from '../../../src/domain/result.js'
import { DEFAULT_SETTINGS, type DigestSettings } from '../../../src/domain/settings.js'
import { FallbackSummarizer } from '../../../src/infrastructure/llm/index.js'
import { createRenderers } from '../../../src/infrastructure/rendering/index.js'
import {
  deferred,
  FakeSummarizer,
  FixedClock,
  InMemorySource,
  InMemoryStore,
  SpySource,
  VALID_RESPONSE,
} from '../../support/application-fakes.js'
import { conversation, message, participant, textOf } from '../domain/factories.js'
import { BA, ba } from '../rendering/support.js'

const renderers = createRenderers('en', BA)
const UNTIL = ba(3, 10, 12, 0)
const SINCE = ba(3, 10, 0, 0)
const at = (hour: number, minute = 0) => ba(3, 10, hour, minute)

const settings = (overrides: Partial<DigestSettings> = {}): DigestSettings => ({ ...DEFAULT_SETTINGS, ...overrides })

const request = (overrides: Partial<GenerateDigestRequest> = {}): GenerateDigestRequest => ({
  until: UNTIL,
  from: SINCE,
  preview: false,
  settings: settings(),
  promptTemplate: null,
  platformName: 'WhatsApp',
  ...overrides,
})

/** A saved contact "<name>" with an individual conversation "<id>" and the given incoming messages. */
function addChat(source: InMemorySource, id: string, name: string, texts: [number, string][], extra = {}) {
  source.addConversation(conversation({ id, name, participantId: id, address: `+${id}` }))
  source.addParticipant({ id, savedName: name, publicName: null })
  texts.forEach(([timestamp, text], i) => {
    source.addMessages(
      message({
        id: `${id}-${i}`,
        conversationId: id,
        senderId: id,
        timestamp,
        text,
        senderAddress: `+${id}`,
        ...extra,
      }),
    )
  })
}

function setup(
  options: { pointer?: number | null; summarizer?: FakeSummarizer; ownConversationIds?: () => readonly string[] } = {},
) {
  const source = new InMemorySource()
  const store = new InMemoryStore(options.pointer ?? null)
  const summarizer = options.summarizer ?? new FakeSummarizer()
  const clock = new FixedClock(UNTIL)
  const run = createGenerateDigest({
    source,
    summarizer,
    store,
    clock,
    renderers,
    ...(options.ownConversationIds === undefined ? {} : { ownConversationIds: options.ownConversationIds }),
  })
  return { source, store, summarizer, clock, run }
}

describe('GenerateDigest: window', () => {
  it('returns the window errors and touches nothing when the window is invalid', async () => {
    const { source, store, summarizer, run } = setup({ pointer: 500 })
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'hi']])
    const result = await run(request({ hours: -1 }))
    expect(result).toEqual(err({ kind: 'invalidWindow', errors: ['invalidHours'] }))
    expect(store.commits).toEqual([])
    expect(store.pointer).toBe(500)
    expect(summarizer.calls).toEqual([])
  })

  it('reports an explicit start that is not before the end', async () => {
    const { store, run } = setup()
    const result = await run(request({ from: UNTIL }))
    expect(result).toEqual(err({ kind: 'invalidWindow', errors: ['startNotBeforeEnd'] }))
    expect(store.commits).toEqual([])
  })

  it('uses the clock for the end and the pointer for the start when they are not given', async () => {
    const { source, store, summarizer, run } = setup({ pointer: at(6) })
    addChat(source, '9911963367943', 'Ana Gómez', [
      [at(5), 'before the pointer'],
      [at(7), 'after the pointer'],
    ])
    const result = await run(request({ until: undefined, from: undefined }))
    expect(result.ok && result.value.window).toEqual({ since: at(6), until: UNTIL })
    expect(summarizer.calls).toHaveLength(1)
    expect(summarizer.calls[0]?.transcript).toContain('after the pointer')
    expect(summarizer.calls[0]?.transcript).not.toContain('before the pointer')
    expect(store.pointer).toBe(UNTIL)
  })

  it('never moves the pointer back', async () => {
    const { source, store, run } = setup({ pointer: UNTIL + 1000 })
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'hi']])
    await run(request({ hours: 24 }))
    expect(store.pointer).toBe(UNTIL + 1000)
  })
})

describe('GenerateDigest: empty window', () => {
  it('advances the pointer and saves and enqueues nothing', async () => {
    const { store, summarizer, run } = setup({ pointer: SINCE - 1 })
    const result = await run(request())
    expect(result.ok && result.value.digest).toBeNull()
    expect(result.ok && result.value.parts).toEqual([])
    expect(result.ok && result.value.pointer).toBe(UNTIL)
    expect(store.pointer).toBe(UNTIL)
    expect(store.history).toEqual([])
    expect(store.outbox).toEqual([])
    expect(summarizer.calls).toEqual([])
  })

  it('reports no failures and no providers, and commits an empty run', async () => {
    const { store, run } = setup()
    const result = await run(request({ runId: 3 }))
    expect(result.ok && result.value).toMatchObject({ summarized: 0, failed: [], providers: {} })
    expect(store.commits[0]?.run).toMatchObject({
      runId: 3,
      summarized: 0,
      failed: 0,
      providers: {},
      failedConversations: [],
    })
  })

  it('also counts as empty when every conversation is filtered out', async () => {
    const { source, store, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'hi']])
    const result = await run(request({ settings: settings({ excludePatterns: ['ana'] }) }))
    expect(result.ok && result.value.digest).toBeNull()
    expect(store.pointer).toBe(UNTIL)
    expect(store.outbox).toEqual([])
  })
})

describe('GenerateDigest: preview', () => {
  it('returns the digest and saves nothing', async () => {
    const { source, store, run } = setup({ pointer: 100 })
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'hi']])
    const result = await run(request({ preview: true }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.preview).toBe(true)
    expect(result.value.pointer).toBeNull()
    expect(result.value.digest?.fullLines.join('\n')).toContain('Ana Gómez')
    expect(result.value.parts.length).toBeGreaterThan(0)
    expect(store.commits).toEqual([])
    expect(store.pointer).toBe(100)
  })

  it('does not touch the store for an empty window either', async () => {
    const { store, run } = setup({ pointer: 100 })
    await run(request({ preview: true }))
    expect(store.commits).toEqual([])
    expect(store.pointer).toBe(100)
  })
})

describe('GenerateDigest: saving', () => {
  it('saves the full digest, enqueues the delivery parts and moves the pointer in one commit', async () => {
    const { source, store, clock, run } = setup({ pointer: SINCE })
    clock.time = UNTIL + 5
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'hi']])
    const result = await run(request({ settings: settings({ hideRest: true }) }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(store.commits).toHaveLength(1)
    const [commit] = store.commits
    expect(commit?.pointer).toBe(UNTIL)
    expect(commit?.parts).toEqual(result.value.parts)
    // hideRest: the delivered text hides the detail, the history keeps it.
    expect(commit?.digest?.text).toBe(result.value.digest?.fullLines.join('\n'))
    expect(commit?.digest?.text).toContain('Talked about lunch.')
    expect(commit?.parts.join('\n')).not.toContain('Talked about lunch.')
    expect(commit?.digest).toMatchObject({ since: SINCE, until: UNTIL, createdAt: UNTIL + 5, summarized: 1, failed: 0 })
  })
})

describe('GenerateDigest: failures', () => {
  const twoChats = (source: InMemorySource) => {
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'hello from ana']])
    addChat(source, '9912465397241', 'Beto Ruiz', [[at(2), 'hello from beto']])
  }

  it('counts a schema error from the LLM as a failure of that conversation only and advances the pointer', async () => {
    const summarizer = new FakeSummarizer((req) =>
      req.transcript.includes('hello from ana') ? ok({ ...VALID_RESPONSE, prioridad: 'urgent' }) : ok(VALID_RESPONSE),
    )
    const { source, store, run } = setup({ summarizer })
    twoChats(source)
    const result = await run(request())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.summarized).toBe(1)
    expect(result.value.failed).toEqual([
      { conversationId: '9911963367943', name: 'Ana Gómez', reason: expect.stringContaining('prioridad') },
    ])
    const text = result.value.digest?.fullLines.join('\n') ?? ''
    expect(text).toContain('⚠️ 1')
    expect(text).toContain('Beto Ruiz')
    expect(text).not.toContain('prioridad must be')
    expect(store.pointer).toBe(UNTIL)
    expect(store.history[0]).toMatchObject({ summarized: 1, failed: 1 })
  })

  it('counts a Summarizer failure, keeps its reason out of the digest and still queues the digest', async () => {
    const summarizer = new FakeSummarizer(() => err('provider exploded: key sk-secret'))
    const { source, store, run } = setup({ summarizer })
    twoChats(source)
    const result = await run(request())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.summarized).toBe(0)
    expect(result.value.failed.map((f) => f.reason)).toEqual([
      'provider exploded: key sk-secret',
      'provider exploded: key sk-secret',
    ])
    expect(result.value.digest?.fullLines.join('\n')).not.toContain('provider exploded')
    expect(result.value.digest?.fullLines.join('\n')).toContain('⚠️ 2')
    // Every conversation failed: the digest with only the warning is still queued (frozen, golden 11).
    expect(store.outbox).toHaveLength(1)
    expect(store.pointer).toBe(UNTIL)
  })

  it('joins every schema error of a conversation in its reason', async () => {
    const summarizer = new FakeSummarizer(() => ok({ ...VALID_RESPONSE, resumen: 5, prioridad: 'urgent' }))
    const { source, run } = setup({ summarizer })
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'hi']])
    const result = await run(request())
    expect(result.ok && result.value.failed[0]?.reason).toBe(
      'invalid summary: resumen must be a string; prioridad must be alta, media or baja',
    )
  })

  it.each([
    ['null', null],
    ['an object without ok', {}],
    ['an object whose ok is not a boolean', { ok: 'yes', value: VALID_RESPONSE }],
  ])('treats %s as an outcome that is not a result', async (_name, outcome) => {
    const summarizer = new FakeSummarizer((() => outcome) as unknown as () => Result<unknown, string>)
    const { source, run } = setup({ summarizer })
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'a']])
    const result = await run(request())
    expect(result.ok && result.value.failed.map((f) => f.reason)).toEqual([
      'the summarizer returned something that is not a result',
    ])
  })

  it('files an answer under "unknown" when the provider is not named, also when its name is empty', async () => {
    const summarizer = new FakeSummarizer(() => ({ ok: true as const, value: VALID_RESPONSE, provider: '' }))
    const { source, run } = setup({ summarizer })
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'a']])
    const result = await run(request())
    expect(result.ok && result.value.providers).toEqual({ unknown: 1 })
  })

  it('treats a throwing Summarizer as a failure of that conversation', async () => {
    const summarizer = new FakeSummarizer(() => {
      throw new Error('boom')
    })
    const { source, run } = setup({ summarizer })
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'hi']])
    const result = await run(request())
    expect(result.ok && result.value.failed[0]?.reason).toBe('boom')
  })
})

describe('GenerateDigest: filters', () => {
  it('never sends an excluded conversation to the Summarizer', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'secret chat']])
    addChat(source, '9912465397241', 'Beto Ruiz', [[at(2), 'normal chat']])
    await run(request({ settings: settings({ excludePatterns: ['ANA GÓ'] }) }))
    expect(summarizer.calls).toHaveLength(1)
    expect(summarizer.calls[0]?.transcript).toContain('normal chat')
    expect(summarizer.calls.some((c) => c.transcript.includes('secret chat'))).toBe(false)
  })

  it('never sends the content of the own chat to the Summarizer, under any of its ids', async () => {
    const own = ['9913174261432', '9990000000009']
    const { source, summarizer, run } = setup({ ownConversationIds: () => own })
    addChat(source, '9913174261432', 'Yo', [[at(1), 'note in my own chat']])
    addChat(source, '9990000000009', 'Yo LID', [[at(1), 'note in my own LID chat']])
    addChat(source, '9912465397241', 'Beto Ruiz', [[at(2), 'normal chat']])
    await run(request())
    expect(summarizer.calls).toHaveLength(1)
    expect(summarizer.calls[0]?.transcript).toContain('normal chat')
    expect(summarizer.calls.some((c) => c.transcript.includes('own'))).toBe(false)
  })

  it('skips a conversation where only the owner wrote', async () => {
    const { source, summarizer, run } = setup()
    source.addConversation(conversation({ id: 'c1', name: 'Solo' }))
    source.addMessages(
      message({ id: 'a', conversationId: 'c1', fromMe: true, senderId: null, timestamp: at(1), text: 'note to self' }),
    )
    await run(request())
    expect(summarizer.calls).toEqual([])
  })

  it('removes own mass messages before summarizing, using the whole history', async () => {
    const mass = `Happy new year to everybody! ${textOf(20)}`
    const { source, summarizer, run } = setup()
    // The same text in three conversations, two of them outside the window.
    for (const id of ['c1', 'c2', 'c3']) source.addConversation(conversation({ id, name: id }))
    source.addMessages(
      message({ id: 'o2', conversationId: 'c2', fromMe: true, senderId: null, timestamp: SINCE - 5000, text: mass }),
      message({ id: 'o3', conversationId: 'c3', fromMe: true, senderId: null, timestamp: SINCE - 4000, text: mass }),
      message({ id: 'o1', conversationId: 'c1', fromMe: true, senderId: null, timestamp: at(1), text: mass }),
      message({ id: 'i1', conversationId: 'c1', senderId: 'p1', timestamp: at(2), text: 'thanks, same to you' }),
      // c2 has only the mass message in the window: nothing is left to summarize.
      message({ id: 'o2b', conversationId: 'c2', fromMe: true, senderId: null, timestamp: at(3), text: mass }),
    )
    await run(request())
    expect(summarizer.calls).toHaveLength(1)
    expect(summarizer.calls[0]?.transcript).toContain('thanks, same to you')
    expect(summarizer.calls[0]?.transcript).not.toContain('Happy new year')
  })

  it('deduplicates a group notice across groups, keeping it in the first group', async () => {
    const notice = `Reminder: the meeting moves to Friday. ${textOf(10)}`
    const { source, summarizer, run } = setup()
    source.addConversation(conversation({ id: 'g1', isGroup: true, participantId: null, name: 'Group One' }))
    source.addConversation(conversation({ id: 'g2', isGroup: true, participantId: null, name: 'Group Two' }))
    source.addMessages(
      // g2 is created first in the source, but g1 has the first message in the window.
      message({ id: 'b', conversationId: 'g2', senderId: 'p1', timestamp: at(3), text: notice }),
      message({ id: 'a', conversationId: 'g1', senderId: 'p1', timestamp: at(1), text: notice }),
    )
    const result = await run(request())
    // Group Two has nothing left after dedupe, so it is not summarized.
    expect(summarizer.calls).toHaveLength(1)
    expect(summarizer.calls[0]?.transcript).toContain('Group One')
    expect(summarizer.calls[0]?.transcript).toContain('(same message in 1 more group)')
    expect(result.ok && result.value.summarized).toBe(1)
  })
})

describe('GenerateDigest: unread only', () => {
  const unreadSettings = settings({ unreadOnly: true })

  it('summarizes from the first unread message and passes the earlier ones as context', async () => {
    const { source, summarizer, run } = setup()
    const id = '9911963367943'
    source.addConversation(conversation({ id, name: 'Ana Gómez', participantId: id }))
    source.addParticipant({ id, savedName: 'Ana Gómez', publicName: null })
    const chat = (n: number, timestamp: number, text: string, read: boolean) =>
      message({ id: `m${n}`, conversationId: id, senderId: id, timestamp, text, read })
    source.addMessages(
      chat(0, SINCE - 1000, 'old read context', true),
      chat(1, at(1), 'already read in window', true),
      chat(2, at(2), 'first unread', false),
      chat(3, at(3), 'second unread', false),
    )
    source.setUnread(id, { kind: 'count', count: 2 })
    await run(request({ settings: unreadSettings }))
    const transcript = summarizer.calls[0]?.transcript ?? ''
    const unreadHeader = 'Unread messages (summarize these):'
    expect(transcript).toContain(unreadHeader)
    const [contextPart, unreadPart] = transcript.split(unreadHeader)
    expect(contextPart).toContain('Earlier messages, already read')
    expect(contextPart).toContain('already read in window')
    expect(contextPart).toContain('old read context')
    expect(contextPart).not.toContain('first unread')
    expect(unreadPart).toContain('first unread')
    expect(unreadPart).toContain('second unread')
    expect(unreadPart).not.toContain('already read in window')
  })

  it('skips conversations whose unread state is unknown or zero', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'unknown state']])
    addChat(source, '9912465397241', 'Beto Ruiz', [[at(2), 'zero unread']])
    source.setUnread('9912465397241', { kind: 'count', count: 0 })
    const result = await run(request({ settings: unreadSettings }))
    expect(summarizer.calls).toEqual([])
    expect(result.ok && result.value.digest).toBeNull()
  })

  it('summarizes the whole window of a conversation marked as unread by hand, with no context', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez', [
      [SINCE - 1000, 'before the window'],
      [at(1), 'in window'],
    ])
    source.setUnread('9911963367943', { kind: 'markedUnread' })
    await run(request({ settings: unreadSettings }))
    const transcript = summarizer.calls[0]?.transcript ?? ''
    expect(transcript).toContain('in window')
    expect(transcript).not.toContain('Earlier messages, already read')
    expect(transcript).not.toContain('before the window')
  })

  it('does not read unread state when the option is off', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'plain']])
    source.setUnread('9911963367943', { kind: 'count', count: 0 })
    await run(request())
    expect(summarizer.calls).toHaveLength(1)
  })
})

describe('GenerateDigest: concurrency', () => {
  const addMany = (source: InMemorySource, n: number) => {
    for (let i = 1; i <= n; i++)
      addChat(source, `99649735567${String(i).padStart(2, '0')}`, `Chat ${i}`, [[at(1, i), `message ${i}`]])
  }
  const idOf = (transcript: string): number => Number(/message (\d+)/.exec(transcript)?.[1])

  it('keeps the results in conversation order whatever the completion order', async () => {
    const gates = new Map<number, ReturnType<typeof deferred<void>>>()
    const summarizer = new FakeSummarizer(async (req) => {
      const n = idOf(req.transcript)
      const gate = deferred<void>()
      gates.set(n, gate)
      await gate.promise
      // Every chat gets the same priority and message count, so the digest order is the conversation order.
      return ok({ ...VALID_RESPONSE, resumen: `summary ${n}` })
    })
    const { source, run } = setup({ summarizer })
    addMany(source, 3)
    const pending = run(request({ concurrency: 3 }))
    await waitUntil(() => gates.size === 3)
    // Complete in reverse order.
    gates.get(3)?.resolve()
    gates.get(2)?.resolve()
    gates.get(1)?.resolve()
    const result = await pending
    const lines = result.ok ? (result.value.digest?.fullLines ?? []).join('\n') : ''
    const order = [1, 2, 3].map((n) => lines.indexOf(`summary ${n}`))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('reports failures in conversation order too', async () => {
    const gates = new Map<number, ReturnType<typeof deferred<void>>>()
    const summarizer = new FakeSummarizer(async (req) => {
      const gate = deferred<void>()
      gates.set(idOf(req.transcript), gate)
      await gate.promise
      return err('down')
    })
    const { source, run } = setup({ summarizer })
    addMany(source, 3)
    const pending = run(request({ concurrency: 3 }))
    await waitUntil(() => gates.size === 3)
    gates.get(2)?.resolve()
    gates.get(3)?.resolve()
    gates.get(1)?.resolve()
    const result = await pending
    expect(result.ok && result.value.failed.map((f) => f.name)).toEqual(['Chat 1', 'Chat 2', 'Chat 3'])
  })

  it('never runs more summaries at once than the limit, and uses all of it', async () => {
    const summarizer = new FakeSummarizer(async () => {
      await Promise.resolve()
      await Promise.resolve()
      return ok(VALID_RESPONSE)
    })
    const { source, run } = setup({ summarizer })
    addMany(source, 7)
    await run(request({ concurrency: 2 }))
    expect(summarizer.calls).toHaveLength(7)
    expect(summarizer.maxInFlight).toBe(2)
  })

  it('defaults to 4 at once', async () => {
    const summarizer = new FakeSummarizer(async () => {
      await new Promise((r) => setTimeout(r, 1))
      return ok(VALID_RESPONSE)
    })
    const { source, run } = setup({ summarizer })
    addMany(source, 9)
    await run(request())
    expect(summarizer.maxInFlight).toBe(4)
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects an invalid limit (%s)', async (concurrency) => {
    const { run } = setup()
    await expect(run(request({ concurrency }))).rejects.toThrow(RangeError)
  })
})

/** Polls until `condition` holds, letting pending promises run. */
async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 1))
  expect(condition()).toBe(true)
}

describe('GenerateDigest: concurrent runs', () => {
  it('returns concurrentRun and saves nothing when the pointer changed meanwhile', async () => {
    const holder: { store?: InMemoryStore } = {}
    const summarizer = new FakeSummarizer(() => {
      if (holder.store) holder.store.pointer = SINCE + 1 // another run finished first
      return ok(VALID_RESPONSE)
    })
    const { source, store, run } = setup({ pointer: SINCE, summarizer })
    holder.store = store
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'hi']])
    const result = await run(request())
    expect(result).toEqual(err({ kind: 'concurrentRun' }))
    expect(store.commits).toEqual([])
    expect(store.pointer).toBe(SINCE + 1)
  })

  it('also refuses to move the pointer for an empty window', async () => {
    const { store } = setup({ pointer: SINCE })
    const racing = { getPointer: async () => SINCE, commit: store.commit.bind(store) }
    store.pointer = SINCE + 1
    const useCase = createGenerateDigest({
      source: new InMemorySource(),
      summarizer: new FakeSummarizer(),
      store: racing,
      clock: new FixedClock(UNTIL),
      renderers,
    })
    expect(await useCase(request())).toEqual(err({ kind: 'concurrentRun' }))
    expect(store.commits).toEqual([])
  })

  it('sends the pointer it read as previousPointer', async () => {
    const { source, store, run } = setup({ pointer: SINCE })
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'hi']])
    await run(request({ from: undefined }))
    expect(store.commits[0]?.previousPointer).toBe(SINCE)
  })
})

describe('GenerateDigest: what it reads (and spares)', () => {
  const runOn = (source: SpySource) =>
    createGenerateDigest({
      source,
      summarizer: new FakeSummarizer(),
      store: new InMemoryStore(null),
      clock: new FixedClock(UNTIL),
      renderers,
    })

  it('reads no own messages when no conversation has messages in the window', async () => {
    const source = new SpySource()
    await runOn(source)(request())
    expect(source.asked).toEqual(['conversationsWithMessages'])
  })

  it.each<[string, UnreadState]>([
    ['unknown', { kind: 'unknown' }],
    ['markedUnread', { kind: 'markedUnread' }],
    ['a count of 0', { kind: 'count', count: 0 }],
  ])('with "unread only" does not look for unread messages or context when the state is %s', async (_name, state) => {
    const source = new SpySource()
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'hi']])
    source.setUnread('9911963367943', state)
    await runOn(source)(request({ settings: settings({ unreadOnly: true }) }))
    expect(source.asked).not.toContain('lastIncoming')
    expect(source.asked).not.toContain('messagesBefore')
  })

  it('looks for the context before the unread tail only when there is a tail', async () => {
    const source = new SpySource()
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'hi']])
    source.setUnread('9911963367943', { kind: 'count', count: 1 })
    await runOn(source)(request({ settings: settings({ unreadOnly: true }) }))
    expect(source.asked).toContain('lastIncoming')
    expect(source.asked).toContain('messagesBefore')
  })

  it('asks for the participants of the chats and of the senders once each, never for a missing id', async () => {
    const source = new SpySource()
    source.addConversation(conversation({ id: 'ana', name: null, participantId: 'ana' }))
    source.addConversation(conversation({ id: 'team', name: 'Team', isGroup: true, participantId: null }))
    source.addMessages(
      message({ id: '1', conversationId: 'ana', senderId: null, senderName: 'Ana', timestamp: at(1), text: 'hi' }),
      message({ id: '2', conversationId: 'team', senderId: 'beto', timestamp: at(1), text: 'hola' }),
      message({ id: '3', conversationId: 'team', senderId: 'carla', timestamp: at(2), text: 'chau' }),
      message({ id: '4', conversationId: 'team', senderId: 'beto', timestamp: at(3), text: 'x' }),
      message({ id: '5', conversationId: 'team', senderId: null, senderName: 'Unknown', timestamp: at(4), text: 'y' }),
    )
    await runOn(source)(request())
    expect([...source.participantIds].sort()).toEqual(['ana', 'beto', 'carla'])
  })

  it('names a chat after its participant even when no message is from that participant', async () => {
    const source = new SpySource()
    const summarizer = new FakeSummarizer()
    source.addConversation(conversation({ id: 'chat-1', name: null, participantId: 'p-ana' }))
    source.addParticipant(participant({ id: 'p-ana', savedName: 'Ana Gómez' }))
    source.addMessages(
      message({ id: 'a', conversationId: 'chat-1', senderId: null, senderName: 'x', timestamp: at(1), text: 'hi' }),
    )
    await createGenerateDigest({
      source,
      summarizer,
      store: new InMemoryStore(null),
      clock: new FixedClock(UNTIL),
      renderers,
    })(request())
    expect(summarizer.calls[0]?.conversation.name).toBe('Ana Gómez')
  })

  it('labels the senders of a group with their names', async () => {
    const source = new SpySource()
    const summarizer = new FakeSummarizer()
    source.addConversation(conversation({ id: 'team', name: 'Team', isGroup: true, participantId: null }))
    source.addParticipant(participant({ id: 'beto', savedName: 'Beto Ruiz' }))
    source.addMessages(message({ id: 'a', conversationId: 'team', senderId: 'beto', timestamp: at(1), text: 'hola' }))
    await createGenerateDigest({
      source,
      summarizer,
      store: new InMemoryStore(null),
      clock: new FixedClock(UNTIL),
      renderers,
    })(request())
    expect(summarizer.calls[0]?.transcript).toContain('Beto Ruiz: hola')
  })
})

describe('GenerateDigest: conversation identity', () => {
  it('finds the participant through participantId, not through the conversation id', async () => {
    const { source, summarizer, run } = setup()
    source.addConversation(conversation({ id: 'chat-1', participantId: 'p-ana', name: 'alias' }))
    source.addParticipant(participant({ id: 'p-ana', savedName: 'Ana Gómez' }))
    source.addMessages(message({ id: 'a', conversationId: 'chat-1', senderId: 'p-ana', timestamp: at(1), text: 'hi' }))
    await run(request({ settings: settings({ flagUnsaved: true }) }))
    expect(summarizer.calls[0]?.conversation).toEqual({ id: 'chat-1', name: 'Ana Gómez', isGroup: false })
    expect(summarizer.calls[0]?.transcript).toContain('Chat with: Ana Gómez')
  })

  it('summarizes a group that has messages but no stored metadata', async () => {
    const { source, summarizer, run } = setup()
    source
      .markGroup('group-9')
      .addMessages(message({ id: 'a', conversationId: 'group-9', senderId: 'p1', timestamp: at(1), text: 'hi' }))
    await run(request())
    expect(summarizer.calls[0]?.conversation).toEqual({
      id: 'group-9',
      name: 'Unnamed group',
      isGroup: true,
    })
  })
})

describe('GenerateDigest: sections and counts', () => {
  const position = (text: string, needle: string) => text.indexOf(needle)

  it('flags unsaved contacts only when the option is on, and only the unsaved ones', async () => {
    const run1 = async (flagUnsaved: boolean) => {
      const { source, run } = setup()
      addChat(source, '9911963367943', 'Saved Sam', [[at(1), 'hi']])
      source.addConversation(
        conversation({ id: '9912465397241', name: null, participantId: 'stranger', address: '+9912465397241' }),
      )
      source.addMessages(
        message({ id: 's', conversationId: '9912465397241', senderId: 'stranger', timestamp: at(2), text: 'hello' }),
      )
      const result = await run(request({ settings: settings({ flagUnsaved }) }))
      return result.ok ? (result.value.digest?.fullLines.join('\n') ?? '') : ''
    }
    const on = await run1(true)
    expect(on).toContain('Unsaved: 1 chat')
    expect(position(on, '+9912465397241')).toBeLessThan(position(on, 'Saved Sam'))
    expect(await run1(false)).not.toContain('Unsaved')
  })

  it('counts only the messages to summarize, not the context, to order chats', async () => {
    const { source, run } = setup()
    // "Many context" has 1 unread message and 5 read ones before it; "Two unread" has 2 unread and no context.
    source.addConversation(conversation({ id: 'ctx', name: 'Many context', participantId: 'ctx' }))
    source.addConversation(conversation({ id: 'two', name: 'Two unread', participantId: 'two' }))
    source.addParticipant(participant({ id: 'ctx', savedName: 'Many context' }))
    source.addParticipant(participant({ id: 'two', savedName: 'Two unread' }))
    for (let i = 0; i < 5; i++) {
      source.addMessages(
        message({
          id: `c${i}`,
          conversationId: 'ctx',
          senderId: 'ctx',
          timestamp: SINCE - 1000 + i,
          text: `read ${i}`,
          read: true,
        }),
      )
    }
    source.addMessages(
      message({ id: 'cu', conversationId: 'ctx', senderId: 'ctx', timestamp: at(1), text: 'unread', read: false }),
      message({ id: 't1', conversationId: 'two', senderId: 'two', timestamp: at(2), text: 'one', read: false }),
      message({ id: 't2', conversationId: 'two', senderId: 'two', timestamp: at(3), text: 'two', read: false }),
    )
    source.setUnread('ctx', { kind: 'count', count: 1 })
    source.setUnread('two', { kind: 'count', count: 2 })
    const result = await run(request({ settings: settings({ unreadOnly: true }) }))
    const text = result.ok ? (result.value.digest?.fullLines.join('\n') ?? '') : ''
    expect(position(text, 'Two unread')).toBeGreaterThan(-1)
    expect(position(text, 'Two unread')).toBeLessThan(position(text, 'Many context'))
  })
})

describe('GenerateDigest: filters run before the deduplicator', () => {
  const notice = `Reminder: the meeting moves to Friday. ${textOf(10)}`

  it('does not let an owner-only group register a notice that would drop it from a later group', async () => {
    const { source, summarizer, run } = setup()
    source.addConversation(conversation({ id: 'g1', isGroup: true, participantId: null, name: 'Mine only' }))
    source.addConversation(conversation({ id: 'g2', isGroup: true, participantId: null, name: 'Shared' }))
    source.addMessages(
      message({ id: 'a', conversationId: 'g1', fromMe: true, senderId: null, timestamp: at(1), text: notice }),
      message({ id: 'b', conversationId: 'g2', fromMe: true, senderId: null, timestamp: at(2), text: notice }),
      message({ id: 'c', conversationId: 'g2', senderId: 'p1', timestamp: at(3), text: 'ok, thanks' }),
    )
    await run(request())
    expect(summarizer.calls).toHaveLength(1)
    expect(summarizer.calls[0]?.transcript).toContain('Shared')
    expect(summarizer.calls[0]?.transcript).toContain(notice)
  })

  it('does not let an excluded group register a notice that would drop it from a later kept group', async () => {
    const { source, summarizer, run } = setup()
    source.addConversation(conversation({ id: 'g1', isGroup: true, participantId: null, name: 'Private group' }))
    source.addConversation(conversation({ id: 'g2', isGroup: true, participantId: null, name: 'Open group' }))
    source.addMessages(
      message({ id: 'a', conversationId: 'g1', senderId: 'p1', timestamp: at(1), text: notice }),
      message({ id: 'b', conversationId: 'g2', senderId: 'p1', timestamp: at(2), text: notice }),
    )
    await run(request({ settings: settings({ excludePatterns: ['private'] }) }))
    expect(summarizer.calls).toHaveLength(1)
    expect(summarizer.calls[0]?.transcript).toContain('Open group')
    expect(summarizer.calls[0]?.transcript).toContain(notice)
  })
})

describe('GenerateDigest: throw safety', () => {
  it('turns a throw while rendering the transcript into that conversation failure only', async () => {
    const throwing = {
      ...renderers,
      transcript: {
        ...renderers.transcript,
        render: (input: Parameters<typeof renderers.transcript.render>[0]) => {
          if (input.name === 'Ana Gómez') throw new Error('render exploded')
          return renderers.transcript.render(input)
        },
      },
    }
    const source = new InMemorySource()
    const store = new InMemoryStore()
    const run = createGenerateDigest({
      source,
      summarizer: new FakeSummarizer(),
      store,
      clock: new FixedClock(UNTIL),
      renderers: throwing,
    })
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'a']])
    addChat(source, '9912465397241', 'Beto Ruiz', [[at(2), 'b']])
    const result = await run(request())
    expect(result.ok && result.value.failed).toEqual([
      { conversationId: '9911963367943', name: 'Ana Gómez', reason: 'render exploded' },
    ])
    expect(result.ok && result.value.summarized).toBe(1)
    expect(store.pointer).toBe(UNTIL)
  })

  it('treats an outcome that is not a Result as a failure', async () => {
    const summarizer = new FakeSummarizer((() => undefined) as unknown as () => Result<unknown, string>)
    const { source, run } = setup({ summarizer })
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'a']])
    const result = await run(request())
    expect(result.ok && result.value.failed.map((f) => f.reason)).toEqual([
      'the summarizer returned something that is not a result',
    ])
    expect(result.ok && result.value.digest).not.toBeNull()
  })

  it('records the provider that answered each conversation, also when an API primary falls back to the Ollama backup (RF-74)', async () => {
    // The primary (an API) answers Ana and fails for Beto; the backup (Ollama) takes Beto over. Each names itself.
    const primary: Summarizer = {
      summarize: async (req) =>
        req.conversation.name === 'Beto Ruiz'
          ? err('anthropic returned 500')
          : { ok: true, value: VALID_RESPONSE, provider: 'anthropic' },
    }
    const backup: Summarizer = { summarize: async () => ({ ok: true, value: VALID_RESPONSE, provider: 'ollama' }) }
    const source = new InMemorySource()
    const store = new InMemoryStore(null)
    const run = createGenerateDigest({
      source,
      summarizer: new FallbackSummarizer(primary, backup),
      store,
      clock: new FixedClock(UNTIL),
      renderers,
    })
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'a']])
    addChat(source, '9912465397241', 'Beto Ruiz', [[at(2), 'b']])
    const result = await run(request({ runId: 7 }))
    expect(result.ok && result.value.providers).toEqual({ anthropic: 1, ollama: 1 })
    // ...and it is what the committed run (the history) is given
    expect(store.commits).toHaveLength(1)
    expect(store.commits[0]?.run).toMatchObject({
      runId: 7,
      summarized: 2,
      failed: 0,
      providers: { anthropic: 1, ollama: 1 },
    })
  })

  it('passes the conversation to the Summarizer', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez', [[at(1), 'a']])
    await run(request())
    expect(summarizer.calls[0]?.conversation).toEqual({ id: '9911963367943', name: 'Ana Gómez', isGroup: false })
  })
})
