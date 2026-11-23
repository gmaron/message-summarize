import { describe, expect, it } from 'vitest'
import {
  type AskChatsRequest,
  cleanQuestion,
  createAskChats,
  MAX_ASK_CONVERSATIONS,
  MAX_QUESTION_CHARS,
  NOTHING_RELEVANT,
} from '../../../src/application/ask-chats.js'
import type { SummarizeRequest, Summarizer } from '../../../src/application/ports/summarizer.js'
import { err, ok } from '../../../src/domain/result.js'
import { DEFAULT_SETTINGS, type DigestSettings } from '../../../src/domain/settings.js'
import { composeSummarizer, LOCAL_ONLY_UNAVAILABLE } from '../../../src/infrastructure/llm/index.js'
import { createRenderers } from '../../../src/infrastructure/rendering/index.js'
import { FakeSummarizer, InMemorySource, VALID_RESPONSE } from '../../support/application-fakes.js'
import { conversation, message } from '../domain/factories.js'
import { BA, ba } from '../rendering/support.js'

const renderers = createRenderers('en', BA)
const SINCE = ba(3, 10, 0, 0)
const UNTIL = ba(3, 10, 12, 0)
const at = (hour: number, minute = 0) => ba(3, 10, hour, minute)

const settings = (overrides: Partial<DigestSettings> = {}): DigestSettings => ({ ...DEFAULT_SETTINGS, ...overrides })

const answer = (resumen: string, extra: Record<string, unknown> = {}) => ok({ ...VALID_RESPONSE, resumen, ...extra })

const request = (overrides: Partial<AskChatsRequest> = {}): AskChatsRequest => ({
  question: 'who asked me for money?',
  window: { since: SINCE, until: UNTIL },
  settings: settings(),
  ...overrides,
})

/** A saved contact "<name>" with an individual conversation "<id>" and `count` incoming messages. */
function addChat(source: InMemorySource, id: string, name: string, count = 1) {
  source.addConversation(conversation({ id, name, participantId: id, address: `+${id}` }))
  source.addParticipant({ id, savedName: name, publicName: null })
  for (let i = 0; i < count; i++) {
    source.addMessages(
      message({ id: `${id}-${i}`, conversationId: id, senderId: id, timestamp: at(1, i), text: `${name} says ${i}` }),
    )
  }
}

function setup(options: { summarizer?: Summarizer; ownConversationIds?: () => readonly string[] } = {}) {
  const source = new InMemorySource()
  const summarizer = options.summarizer ?? new FakeSummarizer(() => answer('Asked for a loan.'))
  const run = createAskChats({
    source,
    summarizer,
    renderers,
    systemPrompt: (question, owner) => `ASK[${question}] for ${owner ?? 'nobody'}`,
    contactStatus: (status) => `STATUS[${status}]`,
    ...(options.ownConversationIds === undefined ? {} : { ownConversationIds: options.ownConversationIds }),
  })
  return { source, summarizer, run }
}

describe('cleanQuestion', () => {
  it('trims, collapses blanks, drops control characters and caps the length', () => {
    expect(cleanQuestion('  who\n\tasked\u0000me   ')).toBe('who asked me')
    expect(cleanQuestion('a'.repeat(MAX_QUESTION_CHARS + 500))).toHaveLength(MAX_QUESTION_CHARS)
  })
})

describe('AskChats: the request', () => {
  it('rejects an empty question, also one of only blanks and control characters, without reading anything', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez')
    expect(await run(request({ question: '' }))).toEqual(err({ kind: 'emptyQuestion' }))
    expect(await run(request({ question: ' \n\u0001 ' }))).toEqual(err({ kind: 'emptyQuestion' }))
    expect((summarizer as FakeSummarizer).calls).toEqual([])
  })

  it('rejects a window that does not start before it ends', async () => {
    const { run } = setup()
    expect(await run(request({ window: { since: UNTIL, until: UNTIL } }))).toEqual(err({ kind: 'invalidWindow' }))
  })

  it('rejects an invalid concurrency', async () => {
    const { source, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez')
    await expect(run(request({ concurrency: 0 }))).rejects.toThrow()
  })

  it('passes the trimmed and capped question to the system prompt, with the owner name', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez')
    const long = `  ${'q'.repeat(MAX_QUESTION_CHARS + 200)}  `
    await run(request({ question: long, settings: settings({ ownerName: 'Lucía' }) }))
    const prompt = (summarizer as FakeSummarizer).calls[0]?.systemPrompt
    expect(prompt).toBe(`ASK[${'q'.repeat(MAX_QUESTION_CHARS)}] for Lucía`)
  })

  it('calls the summarizer once per conversation with its id, name and transcript', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez')
    addChat(source, '9911963367944', 'Beto Ruiz')
    const result = await run(request())
    const calls = (summarizer as FakeSummarizer).calls
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.conversation.name).sort()).toEqual(['Ana Gómez', 'Beto Ruiz'])
    expect(calls.find((c) => c.conversation.id === '9911963367943')?.transcript).toContain('Ana Gómez says 0')
    expect(result.ok && result.value.consulted).toBe(2)
  })

  it('leaves out messages outside the window and conversations without any', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez')
    source.addMessages(
      message({ id: 'old', conversationId: '9911963367944', senderId: '9911963367944', timestamp: SINCE - 1000 }),
    )
    const result = await run(request())
    expect((summarizer as FakeSummarizer).calls).toHaveLength(1)
    expect(result.ok && result.value.consulted).toBe(1)
  })
})

describe('AskChats: contact status', () => {
  it('marks an individual chat as saved or unsaved in the transcript, and a group as a group', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez')
    source.addConversation(
      conversation({ id: '9911963367944', name: null, participantId: '9911963367944', address: '+9911963367944' }),
    )
    source.addParticipant({ id: '9911963367944', savedName: null, publicName: 'Beto' })
    source.addMessages(
      message({ id: 'u1', conversationId: '9911963367944', senderId: '9911963367944', timestamp: at(1), text: 'hola' }),
    )
    source.addConversation(conversation({ id: 'g1', name: 'Team', isGroup: true, participantId: null }))
    source.addMessages(
      message({ id: 'g-1', conversationId: 'g1', senderId: '9911963367943', timestamp: at(1), text: 'hi all' }),
    )
    await run(request())
    const calls = (summarizer as FakeSummarizer).calls
    const transcriptOf = (id: string) => calls.find((c) => c.conversation.id === id)?.transcript ?? ''
    expect(transcriptOf('9911963367943')).toMatch(/^STATUS\[saved\]\n/)
    expect(transcriptOf('9911963367944')).toMatch(/^STATUS\[unsaved\]\n/)
    expect(transcriptOf('g1')).toMatch(/^STATUS\[group\]\n/)
    expect(calls.every((c) => Object.keys(c).sort().join() === 'conversation,systemPrompt,transcript')).toBe(true)
  })
})

describe('AskChats: privacy', () => {
  it('never reads an excluded conversation, and a chat filter cannot bring it back', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez')
    addChat(source, '9911963367944', 'Banco Secreto')
    const result = await run(
      request({ settings: settings({ excludePatterns: ['banco'] }), chats: ['banco', 'id:9911963367944'] }),
    )
    expect((summarizer as FakeSummarizer).calls).toEqual([])
    expect(result.ok && result.value.consulted).toBe(0)
    expect(result.ok && result.value.items).toEqual([])
  })

  it('never reads the own chat of the owner', async () => {
    const { source, summarizer, run } = setup({ ownConversationIds: () => ['9911963367999'] })
    addChat(source, '9911963367999', 'Me')
    addChat(source, '9911963367943', 'Ana Gómez')
    await run(request())
    expect((summarizer as FakeSummarizer).calls.map((c) => c.conversation.id)).toEqual(['9911963367943'])
  })

  it('keeps only the conversations that match the chat filter (a name, a number or an id)', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez')
    addChat(source, '9911963367944', 'Beto Ruiz')
    addChat(source, '9911963367945', 'Carla Díaz')
    await run(request({ chats: [' ana ', '', 'id:9911963367945'] }))
    const ids = (summarizer as FakeSummarizer).calls.map((c) => c.conversation.id).sort()
    expect(ids).toEqual(['9911963367943', '9911963367945'])
  })

  it('RF-43: a local-only conversation never reaches the external provider, not even when the local one fails', async () => {
    const external = new FakeSummarizer(() => answer('external answer'))
    const local = new FakeSummarizer(() => err('local failed'))
    const composed = composeSummarizer({ primary: external, backup: external, local, localOnlyPatterns: ['banco'] })
    const { source, run } = setup({ summarizer: composed })
    addChat(source, '9911963367943', 'Ana Gómez')
    addChat(source, '9911963367944', 'Banco Secreto')
    const result = await run(request())
    expect(external.calls.map((c) => c.conversation.name)).toEqual(['Ana Gómez'])
    expect(local.calls.map((c) => c.conversation.name)).toEqual(['Banco Secreto'])
    expect(result.ok && result.value.failed).toBe(1)
    expect(result.ok && result.value.items.map((i) => i.name)).toEqual(['Ana Gómez'])
  })

  it('RF-43: without a local provider a local-only conversation fails and is not sent anywhere', async () => {
    const external = new FakeSummarizer(() => answer('external answer'))
    const composed = composeSummarizer({ primary: external, localOnlyPatterns: ['banco'] })
    const { source, run } = setup({ summarizer: composed })
    addChat(source, '9911963367944', 'Banco Secreto')
    const result = await run(request())
    expect(LOCAL_ONLY_UNAVAILABLE).toBeTruthy()
    expect(external.calls).toEqual([])
    expect(result.ok && result.value.failed).toBe(1)
    expect(result.ok && result.value.items).toEqual([])
  })
})

describe('AskChats: the selection (as the digest)', () => {
  it('skips the conversations where only the owner wrote', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez')
    source.addConversation(conversation({ id: '9911963367944', name: 'Beto Ruiz', participantId: '9911963367944' }))
    source.addMessages(
      message({
        id: 'o1',
        conversationId: '9911963367944',
        fromMe: true,
        senderId: null,
        timestamp: at(2),
        text: 'Hi Beto',
      }),
    )
    const result = await run(request())
    expect(result.ok && result.value.candidates).toBe(1)
    expect(result.ok && result.value.consulted).toBe(1)
    expect((summarizer as FakeSummarizer).calls.map((c) => c.conversation.name)).toEqual(['Ana Gómez'])
  })

  it('drops mass messages, so a chat with only a mass message and own text is skipped, and a mixed one keeps its incoming', async () => {
    const { source, summarizer, run } = setup()
    const blast = 'Big sale this weekend only, write me to order your pieces now!'
    for (const id of ['9911963367001', '9911963367002', '9911963367003']) {
      source.addConversation(conversation({ id, name: `Client ${id}`, participantId: id }))
      source.addMessages(
        message({ id: `m-${id}`, conversationId: id, fromMe: true, senderId: null, timestamp: at(2), text: blast }),
      )
    }
    // a mass message plus an incoming reply: the chat stays, and the transcript has no mass text
    source.addParticipant({ id: '9911963367001', savedName: 'Client 1', publicName: null })
    source.addMessages(
      message({
        id: 'r1',
        conversationId: '9911963367001',
        senderId: '9911963367001',
        timestamp: at(3),
        text: 'How much?',
      }),
    )
    const result = await run(request())
    expect(result.ok && result.value.candidates).toBe(1)
    const calls = (summarizer as FakeSummarizer).calls
    expect(calls).toHaveLength(1)
    expect(calls[0]?.transcript).toContain('How much?')
    expect(calls[0]?.transcript).not.toContain('Big sale')
  })

  it('with "unread only" reads just the unread tail, with the messages before it as context, and skips read chats', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez', 3)
    addChat(source, '9911963367944', 'Beto Ruiz', 2)
    // Ana: 1 unread (her last message); Beto: nothing unread
    source.setUnread('9911963367943', { kind: 'count', count: 1 })
    source.setUnread('9911963367944', { kind: 'count', count: 0 })
    const result = await run(request({ settings: settings({ unreadOnly: true }) }))
    expect(result.ok && result.value.candidates).toBe(1)
    const calls = (summarizer as FakeSummarizer).calls
    expect(calls.map((c) => c.conversation.name)).toEqual(['Ana Gómez'])
    // the unread message is there, and the earlier ones only as context
    expect(calls[0]?.transcript).toContain('Ana Gómez says 2')
    expect(calls[0]?.transcript).toContain('Ana Gómez says 0')
    const items = result.ok ? result.value.items : []
    expect(items[0]?.messageCount).toBe(1)
  })

  it('without "unread only" reads every chat with incoming messages, read or not', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez')
    addChat(source, '9911963367944', 'Beto Ruiz')
    source.setUnread('9911963367944', { kind: 'count', count: 0 })
    const result = await run(request({ settings: settings({ unreadOnly: false }) }))
    expect(result.ok && result.value.candidates).toBe(2)
    expect((summarizer as FakeSummarizer).calls).toHaveLength(2)
  })

  it('still applies the exclusions before the chat filter', async () => {
    const { source, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez')
    const result = await run(request({ chats: ['Ana'], settings: settings({ excludePatterns: ['Ana'] }) }))
    expect(result.ok && result.value.candidates).toBe(0)
  })
})

describe('AskChats: the pages', () => {
  const idOf = (i: number) => `99119633${String(i).padStart(5, '0')}`

  it('reads a page of the maximum, ranked by the latest incoming message, and reports candidates and offset', async () => {
    const { source, summarizer, run } = setup()
    const total = MAX_ASK_CONVERSATIONS + 5
    // chat i has its incoming message at minute i: the highest i is the most recent
    for (let i = 0; i < total; i++) {
      source.addConversation(conversation({ id: idOf(i), name: `Person ${i}`, participantId: idOf(i) }))
      source.addParticipant({ id: idOf(i), savedName: `Person ${i}`, publicName: null })
      source.addMessages(
        message({
          id: `m${i}`,
          conversationId: idOf(i),
          senderId: idOf(i),
          timestamp: at(1, i % 60) + Math.floor(i / 60) * 3600_000,
          text: `says ${i}`,
        }),
      )
    }
    const result = await run(request())
    expect(result.ok && [result.value.consulted, result.value.candidates, result.value.offset]).toEqual([
      MAX_ASK_CONVERSATIONS,
      total,
      0,
    ])
    const names = (summarizer as FakeSummarizer).calls.map((c) => c.conversation.name)
    expect(names).toHaveLength(MAX_ASK_CONVERSATIONS)
    // the 5 oldest are the ones left out
    for (let i = 0; i < 5; i++) expect(names).not.toContain(`Person ${i}`)
    expect(names).toContain(`Person ${total - 1}`)
  })

  it('ranks by the latest INCOMING message: an own reply later does not move a chat up; ties go by conversation id', async () => {
    const { source } = setup()
    for (const [id, name] of [
      ['b', 'Bea'],
      ['a', 'Ana'],
      ['c', 'Cora'],
    ] as const) {
      source.addConversation(conversation({ id, name, participantId: id }))
      source.addParticipant({ id, savedName: name, publicName: null })
    }
    source.addMessages(
      message({ id: '1', conversationId: 'a', senderId: 'a', timestamp: at(1), text: 'old a' }),
      message({ id: '2', conversationId: 'a', fromMe: true, senderId: null, timestamp: at(9), text: 'my late reply' }),
      message({ id: '3', conversationId: 'b', senderId: 'b', timestamp: at(5), text: 'b' }),
      message({ id: '4', conversationId: 'c', senderId: 'c', timestamp: at(5), text: 'c' }),
    )
    const seen: string[] = []
    const ranked = createAskChats({
      source,
      summarizer: new FakeSummarizer((r) => {
        seen.push(r.conversation.name)
        return answer('x')
      }),
      renderers,
      systemPrompt: () => 'p',
      contactStatus: () => 's',
    })
    await ranked(request({ concurrency: 1 }))
    expect(seen).toEqual(['Bea', 'Cora', 'Ana'])
  })

  it('an offset returns the next slice of the same ranking', async () => {
    const { source, summarizer, run } = setup()
    const total = MAX_ASK_CONVERSATIONS + 5
    for (let i = 0; i < total; i++) {
      source.addConversation(conversation({ id: idOf(i), name: `Person ${i}`, participantId: idOf(i) }))
      source.addParticipant({ id: idOf(i), savedName: `Person ${i}`, publicName: null })
      source.addMessages(
        message({
          id: `m${i}`,
          conversationId: idOf(i),
          senderId: idOf(i),
          timestamp: at(1, i % 60) + Math.floor(i / 60) * 3600_000,
          text: `says ${i}`,
        }),
      )
    }
    const result = await run(request({ offset: MAX_ASK_CONVERSATIONS }))
    expect(result.ok && [result.value.consulted, result.value.candidates, result.value.offset]).toEqual([
      5,
      total,
      MAX_ASK_CONVERSATIONS,
    ])
    expect((summarizer as FakeSummarizer).calls.map((c) => c.conversation.name).sort()).toEqual(
      [0, 1, 2, 3, 4].map((i) => `Person ${i}`).sort(),
    )
  })

  it('treats a negative or non-finite offset as 0', async () => {
    for (const offset of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { source, run } = setup()
      addChat(source, '9911963367943', 'Ana Gómez')
      const result = await run(request({ offset }))
      expect(result.ok && [result.value.consulted, result.value.offset]).toEqual([1, 0])
    }
  })

  it('an offset past the end reads nothing', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez')
    const result = await run(request({ offset: 10 }))
    expect(result.ok && [result.value.consulted, result.value.candidates]).toEqual([0, 1])
    expect((summarizer as FakeSummarizer).calls).toEqual([])
  })

  it('counts candidates after the exclusions and the filter', async () => {
    const { source, run } = setup()
    for (let i = 0; i <= MAX_ASK_CONVERSATIONS; i++) addChat(source, idOf(i), `Person ${i}`)
    const result = await run(request({ chats: ['Person 80'] }))
    expect(result.ok && result.value.candidates).toBe(1)
  })
})

describe('AskChats: the answers', () => {
  it('omits the conversations that answer "-" or nothing, but still counts them as consulted and answered by a provider', async () => {
    const summarizer = new FakeSummarizer((r) => {
      if (r.conversation.name === 'Ana Gómez')
        return ok({ ...VALID_RESPONSE, resumen: ` ${NOTHING_RELEVANT} `, provider: 'x' })
      if (r.conversation.name === 'Beto Ruiz') return answer('   ')
      return answer('Carla asked for a loan.')
    })
    const { source, run } = setup({ summarizer })
    addChat(source, '9911963367943', 'Ana Gómez')
    addChat(source, '9911963367944', 'Beto Ruiz')
    addChat(source, '9911963367945', 'Carla Díaz')
    const result = await run(request())
    expect(result.ok && result.value.items.map((i) => i.name)).toEqual(['Carla Díaz'])
    expect(result.ok && result.value.consulted).toBe(3)
    expect(result.ok && result.value.failed).toBe(0)
    expect(result.ok && result.value.providers).toEqual({ unknown: 3 })
  })

  it('also treats a single dash of any kind, wrapped in quotes or a period, as nothing, but not a real answer that starts with a dash', async () => {
    const answers: Record<string, string> = {
      'Ana Gómez': '"-"',
      'Beto Ruiz': '-.',
      'Carla Díaz': '- Wants a loan',
      'Dani Paz': '«-»',
      'Eva Sol': '—',
      'Fede Luz': '– ',
      'Gabi Mar': '——',
    }
    const { source, run } = setup({ summarizer: new FakeSummarizer((r) => answer(answers[r.conversation.name] ?? '')) })
    addChat(source, '9911963367943', 'Ana Gómez')
    addChat(source, '9911963367944', 'Beto Ruiz')
    addChat(source, '9911963367945', 'Carla Díaz')
    addChat(source, '9911963367946', 'Dani Paz')
    addChat(source, '9911963367947', 'Eva Sol')
    addChat(source, '9911963367948', 'Fede Luz')
    addChat(source, '9911963367949', 'Gabi Mar')
    const result = await run(request())
    expect(result.ok && result.value.items.map((i) => i.name).sort()).toEqual(['Carla Díaz', 'Gabi Mar'])
  })

  it('returns an empty list as a valid answer when nothing is relevant', async () => {
    const { source, run } = setup({ summarizer: new FakeSummarizer(() => answer(NOTHING_RELEVANT)) })
    addChat(source, '9911963367943', 'Ana Gómez')
    const result = await run(request())
    expect(result.ok && result.value.items).toEqual([])
    expect(result.ok && result.value.consulted).toBe(1)
  })

  it('carries the todos without blanks, needsReply, the message count and the provider', async () => {
    const summarizer = new FakeSummarizer(() => ({
      ok: true as const,
      provider: 'claude-cli',
      value: { ...VALID_RESPONSE, resumen: 'Wants money.', pendientes: ['Reply', '  '], necesita_respuesta: true },
    }))
    const { source, run } = setup({ summarizer })
    addChat(source, '9911963367943', 'Ana Gómez', 3)
    const result = await run(request())
    expect(result.ok && result.value.items).toEqual([
      { name: 'Ana Gómez', answer: 'Wants money.', todos: ['Reply'], needsReply: true, messageCount: 3 },
    ])
    expect(result.ok && result.value.providers).toEqual({ 'claude-cli': 1 })
  })

  it('orders the conversations that await a reply first, then the busiest', async () => {
    const summarizer = new FakeSummarizer((r) => {
      const needs = r.conversation.name === 'Carla Díaz' || r.conversation.name === 'Dani Paz'
      return answer(`about ${r.conversation.name}`, { necesita_respuesta: needs })
    })
    const { source, run } = setup({ summarizer })
    addChat(source, '9911963367943', 'Ana Gómez', 5)
    addChat(source, '9911963367944', 'Beto Ruiz', 2)
    addChat(source, '9911963367945', 'Carla Díaz', 1)
    addChat(source, '9911963367946', 'Dani Paz', 3)
    const result = await run(request())
    expect(result.ok && result.value.items.map((i) => i.name)).toEqual([
      'Dani Paz',
      'Carla Díaz',
      'Ana Gómez',
      'Beto Ruiz',
    ])
  })

  it('counts as failed a provider error, an invalid answer, a thrown error and a malformed result, and keeps the others', async () => {
    const summarizer = new FakeSummarizer((r): never | ReturnType<typeof answer> => {
      switch (r.conversation.name) {
        case 'Ana Gómez':
          return err('provider down') as never
        case 'Beto Ruiz':
          return ok({ resumen: 5 }) as never
        case 'Carla Díaz':
          throw new Error('boom')
        case 'Dani Paz':
          return null as never
        default:
          return answer('fine')
      }
    })
    const { source, run } = setup({ summarizer })
    addChat(source, '9911963367943', 'Ana Gómez')
    addChat(source, '9911963367944', 'Beto Ruiz')
    addChat(source, '9911963367945', 'Carla Díaz')
    addChat(source, '9911963367946', 'Dani Paz')
    addChat(source, '9911963367947', 'Eva Soto')
    const result = await run(request())
    expect(result.ok && result.value.failed).toBe(4)
    expect(result.ok && result.value.consulted).toBe(5)
    expect(result.ok && result.value.items.map((i) => i.name)).toEqual(['Eva Soto'])
    expect(JSON.stringify(result)).not.toContain('provider down')
  })

  it('respects the concurrency of the request', async () => {
    const summarizer = new FakeSummarizer(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return answer('ok')
    })
    const { source, run } = setup({ summarizer })
    for (let i = 0; i < 6; i++) addChat(source, `99119633${String(i).padStart(5, '0')}`, `Person ${i}`)
    await run(request({ concurrency: 2 }))
    expect(summarizer.maxInFlight).toBeLessThanOrEqual(2)
    expect(summarizer.calls).toHaveLength(6)
  })

  it('only reads: the requests it sends carry no state of the digest', async () => {
    const { source, summarizer, run } = setup()
    addChat(source, '9911963367943', 'Ana Gómez')
    await run(request())
    const call: SummarizeRequest | undefined = (summarizer as FakeSummarizer).calls[0]
    expect(Object.keys(call ?? {}).sort()).toEqual(['conversation', 'systemPrompt', 'transcript'])
  })
})
