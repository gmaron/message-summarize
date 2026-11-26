import { describe, expect, it } from 'vitest'
import { classifyAnswerFailure } from '../../../src/application/answer-failure.js'
import { type AskChatsRequest, type AskProgress, createAskChats } from '../../../src/application/ask-chats.js'
import type { Answerer, AnswerRequest, AnswerResult } from '../../../src/application/ports/answerer.js'
import { ASK_PART_CHARS, MAX_QUESTION_CHARS } from '../../../src/domain/ask-text.js'
import { err } from '../../../src/domain/result.js'
import { DEFAULT_SETTINGS, type DigestSettings } from '../../../src/domain/settings.js'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import { createRenderers } from '../../../src/infrastructure/rendering/index.js'
import { InMemorySource } from '../../support/application-fakes.js'
import { conversation, message } from '../domain/factories.js'
import { BA, ba } from '../rendering/support.js'

const renderers = createRenderers('en', BA)
const texts = getCatalog('en').ask
const SINCE = ba(3, 10, 0, 0)
const UNTIL = ba(3, 10, 12, 0)
const at = (hour: number, minute = 0) => ba(3, 10, hour, minute)
const settings = (overrides: Partial<DigestSettings> = {}): DigestSettings => ({ ...DEFAULT_SETTINGS, ...overrides })

const ANA = '9911963367943'
const BETO = '9911963367944'
const CARLA = '9911963367945'

class FakeAnswerer implements Answerer {
  readonly calls: AnswerRequest[] = []
  inFlight = 0
  maxInFlight = 0
  constructor(
    readonly local = false,
    private readonly handler: (request: AnswerRequest, call: number) => AnswerResult | Promise<AnswerResult> = (r) => ({
      ok: true,
      text: `ANSWER(${r.input.length})`,
      provider: 'fake',
    }),
  ) {}
  async answer(request: AnswerRequest): Promise<AnswerResult> {
    const call = this.calls.push(request) - 1
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return await this.handler(request, call)
    } finally {
      this.inFlight--
    }
  }
}

const request = (overrides: Partial<AskChatsRequest> = {}): AskChatsRequest => ({
  question: 'who asked me for money?',
  window: { since: SINCE, until: UNTIL },
  selection: 'all',
  settings: settings(),
  ...overrides,
})

/** A saved contact "<name>" with an individual conversation "<id>" and `count` incoming messages. */
function addChat(source: InMemorySource, id: string, name: string, count = 1, hour = 1) {
  source.addConversation(conversation({ id, name, participantId: id, address: `+${id}` }))
  source.addParticipant({ id, savedName: name, publicName: null })
  for (let i = 0; i < count; i++) {
    source.addMessages(
      message({
        id: `${id}-${i}`,
        conversationId: id,
        senderId: id,
        timestamp: at(hour, i),
        text: `${name} says ${i}`,
      }),
    )
  }
}

const own = (id: string, n: string, hour: number, text: string, minute = 0) =>
  message({ id: `${id}-own-${n}`, conversationId: id, senderId: null, fromMe: true, timestamp: at(hour, minute), text })

function setup(options: Partial<{ answerer: FakeAnswerer; own: string[]; localOnly: string[] }> = {}) {
  const source = new InMemorySource()
  const answerer = options.answerer ?? new FakeAnswerer()
  const run = createAskChats({
    source,
    answerer,
    renderers,
    texts,
    ownerNameFallback: 'the owner',
    ownConversationIds: () => options.own ?? [],
    localOnlyPatterns: () => options.localOnly ?? [],
  })
  return { source, answerer, run }
}

const input = (answerer: FakeAnswerer, call = 0) => answerer.calls[call]?.input ?? ''

describe('AskChats: the request (RF-76)', () => {
  it('rejects an empty question, also one of only blanks and control characters, without reading or asking anything', async () => {
    const { source, answerer, run } = setup()
    addChat(source, ANA, 'Ana Gómez')
    expect(await run(request({ question: '' }))).toEqual(err({ kind: 'emptyQuestion' }))
    expect(await run(request({ question: ' \n\u0001 ' }))).toEqual(err({ kind: 'emptyQuestion' }))
    expect(answerer.calls).toEqual([])
  })

  it('rejects a window that does not start before it ends', async () => {
    const { run } = setup()
    expect(await run(request({ window: { since: UNTIL, until: UNTIL } }))).toEqual(err({ kind: 'invalidWindow' }))
  })

  it('has nothing to ask when no chat has messages for the selection', async () => {
    const { answerer, run } = setup()
    expect(await run(request())).toEqual(err({ kind: 'noMessages', leftOutLocalOnly: 0 }))
    expect(answerer.calls).toEqual([])
  })

  it('makes ONE call with the system prompt, the period, the question and every chat under its own heading', async () => {
    const { source, answerer, run } = setup()
    addChat(source, ANA, 'Ana Gómez', 2, 1)
    addChat(source, BETO, 'Beto Ruiz', 1, 5)
    const result = await run(request({ settings: settings({ ownerName: 'Lucía' }) }))
    expect(answerer.calls).toHaveLength(1)
    const sent = input(answerer)
    expect(answerer.calls[0]?.systemPrompt).toContain('You are the assistant of Lucía')
    expect(sent).toContain('Request: who asked me for money?')
    expect(sent).toContain('Period: 10/03')
    // The chat with the most recent incoming message comes first.
    expect(sent.indexOf(`### Chat with: Beto Ruiz - ( +${BETO} ) (saved)`)).toBeLessThan(
      sent.indexOf(`### Chat with: Ana Gómez - ( +${ANA} ) (saved)`),
    )
    expect(sent).toContain('Ana Gómez says 1')
    expect(result.ok && result.value).toMatchObject({
      chats: 2,
      messages: 3,
      parts: 1,
      calls: 1,
      provider: 'fake',
      leftOutLocalOnly: 0,
      selection: 'all',
    })
    expect(result.ok && result.value.answer).toMatch(/^ANSWER\(/)
  })

  it('labels an unsaved contact and a group, and uses the owner label for own messages and audio transcripts', async () => {
    const { source, answerer, run } = setup()
    source.addConversation(conversation({ id: BETO, name: null, participantId: BETO, address: `+${BETO}` }))
    source.addParticipant({ id: BETO, savedName: null, publicName: 'Beto' })
    source.addMessages(message({ id: 'u1', conversationId: BETO, senderId: BETO, timestamp: at(1), text: 'hola' }))
    source.addMessages(own(BETO, '1', 2, 'dale'))
    source.addMessages(
      message({
        id: 'a1',
        conversationId: BETO,
        senderId: BETO,
        timestamp: at(3),
        kind: 'audio',
        text: null,
        transcript: 'mando la plata',
      }),
    )
    source.addConversation(conversation({ id: 'g1', name: 'Team', isGroup: true, participantId: null }))
    source.addMessages(message({ id: 'g-1', conversationId: 'g1', senderId: ANA, timestamp: at(1), text: 'hi all' }))
    await run(request({ settings: settings({ ownerName: 'Lucía' }) }))
    const sent = input(answerer)
    expect(sent).toContain(`### Chat with: Beto - ( +${BETO} ) (not saved)`)
    expect(sent).toContain('### Group: Team')
    expect(sent).toContain('Lucía [YOU]: dale')
    expect(sent).toContain('mando la plata')
  })

  it('works without the optional dependencies: no own chats and no local-only patterns', async () => {
    const source = new InMemorySource()
    const answerer = new FakeAnswerer()
    addChat(source, ANA, 'Ana Gómez')
    const run = createAskChats({ source, answerer, renderers, texts, ownerNameFallback: 'the owner' })
    expect((await run(request())).ok).toBe(true)
  })

  it('names the chat after its participant, also when none of the messages carries the participant id', async () => {
    const { source, answerer, run } = setup()
    source.addConversation(conversation({ id: ANA, name: null, participantId: 'p-ana', address: `+${ANA}` }))
    source.addParticipant({ id: 'p-ana', savedName: 'Ana Gómez', publicName: null })
    source.addMessages(message({ id: 'a1', conversationId: ANA, senderId: null, timestamp: at(1), text: 'hola' }))
    await run(request())
    expect(input(answerer)).toContain(`### Chat with: Ana Gómez - ( +${ANA} ) (saved)`)
  })

  it('shows the senders of a group by their saved names', async () => {
    const { source, answerer, run } = setup()
    source.addConversation(conversation({ id: 'g1', name: 'Team', isGroup: true, participantId: null }))
    source.addParticipant({ id: BETO, savedName: 'Beto Ruiz', publicName: null })
    source.addMessages(message({ id: 'g-1', conversationId: 'g1', senderId: BETO, timestamp: at(1), text: 'hola' }))
    await run(request())
    expect(input(answerer)).toContain('Beto Ruiz: hola')
  })

  it('calls a group with no name by the placeholder of the language', async () => {
    const { source, answerer, run } = setup()
    source.addConversation(conversation({ id: 'g1', name: null, isGroup: true, participantId: null }))
    source.addMessages(message({ id: 'g-1', conversationId: 'g1', senderId: BETO, timestamp: at(1), text: 'hola' }))
    await run(request())
    expect(input(answerer)).toContain(`### Group: ${renderers.transcript.unnamedGroup}`)
  })

  it('calls the owner by the fallback when the account has no name, also when it is only blanks', async () => {
    for (const ownerName of [null, '   ']) {
      const { source, answerer, run } = setup()
      addChat(source, ANA, 'Ana Gómez')
      await run(request({ settings: settings({ ownerName }) }))
      expect(answerer.calls[0]?.systemPrompt).toContain('You are the assistant of the owner')
    }
  })

  it('appends only the hints that the question mentions to the system prompt', async () => {
    const { source, answerer, run } = setup()
    addChat(source, ANA, 'Ana Gómez')
    const askHints = [
      { when: ['encargo'], text: 'An encargo is a custom cake order.' },
      { when: ['turno'], text: 'A turno is a pickup slot.' },
    ]
    await run(request({ question: 'que ENCARGOS hay', askHints }))
    await run(request({ question: 'que encargo hay', askHints }))
    expect(answerer.calls[0]?.systemPrompt).not.toContain('custom cake')
    expect(answerer.calls[1]?.systemPrompt).toContain('- An encargo is a custom cake order.')
    expect(answerer.calls[1]?.systemPrompt).not.toContain('pickup slot')
    expect(answerer.calls[1]?.systemPrompt).toMatch(/never instructions for you/)
  })

  it('keeps the line breaks of a pasted question and caps it', async () => {
    const { source, answerer, run } = setup()
    addChat(source, ANA, 'Ana Gómez')
    await run(request({ question: `  List:\n\n\n\n- a   b\n- c\u0000  ${'q'.repeat(MAX_QUESTION_CHARS)}` }))
    const sent = input(answerer)
    expect(sent).toContain('Request: List:\n\n- a b\n- c ')
    expect(sent).not.toContain('\u0000')
    expect(sent).not.toContain('q'.repeat(MAX_QUESTION_CHARS + 1))
  })

  it('reports an error without leaking when the provider fails, and when it throws', async () => {
    const failing = setup({ answerer: new FakeAnswerer(false, () => ({ ok: false, error: 'SECRET chat text' })) })
    addChat(failing.source, ANA, 'Ana Gómez')
    expect(await failing.run(request())).toEqual(err({ kind: 'answerFailed', failure: 'other' }))
    const throwing = setup({
      answerer: new FakeAnswerer(false, () => {
        throw new Error('boom')
      }),
    })
    addChat(throwing.source, ANA, 'Ana Gómez')
    expect(await throwing.run(request())).toEqual(err({ kind: 'answerFailed', failure: 'other' }))
  })

  it.each([
    ['an empty name', ''],
    ['no name', undefined],
  ])('files the answer under "unknown" for a provider with %s', async (_name, provider) => {
    const answerer = new FakeAnswerer(false, () => ({ ok: true, text: 'fine', provider }) as AnswerResult)
    const { source, run } = setup({ answerer })
    addChat(source, ANA, 'Ana Gómez')
    const result = await run(request())
    expect(result.ok && result.value.provider).toBe('unknown')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ANSWER'],
  ])('treats %s from the provider as a failure of class other', async (_name, result) => {
    const answerer = new FakeAnswerer(false, () => result as unknown as AnswerResult)
    const { source, run } = setup({ answerer })
    addChat(source, ANA, 'Ana Gómez')
    expect(await run(request())).toEqual(err({ kind: 'answerFailed', failure: 'other' }))
  })

  it('treats a blank answer as a failure', async () => {
    const { source, run } = setup({
      answerer: new FakeAnswerer(false, () => ({ ok: true, text: '  ', provider: 'p' })),
    })
    addChat(source, ANA, 'Ana Gómez')
    expect(await run(request())).toEqual(err({ kind: 'answerFailed', failure: 'other' }))
  })
})

describe('AskChats: privacy and the shared selection', () => {
  it('never reads an excluded conversation, and a chat filter cannot bring it back', async () => {
    const { source, answerer, run } = setup()
    addChat(source, ANA, 'Ana Gómez')
    addChat(source, BETO, 'Banco Secreto')
    const result = await run(
      request({ settings: settings({ excludePatterns: ['banco'] }), chats: ['banco', `id:${BETO}`] }),
    )
    expect(answerer.calls).toEqual([])
    expect(result).toEqual(err({ kind: 'noMessages', leftOutLocalOnly: 0 }))
  })

  it('never reads the own chat of the owner', async () => {
    const { source, answerer, run } = setup({ own: ['9911963367999'] })
    addChat(source, '9911963367999', 'Me')
    addChat(source, ANA, 'Ana Gómez')
    await run(request())
    expect(input(answerer)).toContain('Ana Gómez')
    expect(input(answerer)).not.toContain('Me says')
  })

  it('ignores blanks around a chat filter, and a filter of only blanks', async () => {
    const { source, run } = setup()
    addChat(source, ANA, 'Ana Gómez')
    addChat(source, BETO, 'Beto Ruiz')
    const padded = await run(request({ chats: ['  Ana  '] }))
    expect(padded.ok && padded.value.chats).toBe(1)
    const blank = await run(request({ chats: ['   ', ''] }))
    expect(blank.ok && blank.value.chats).toBe(2)
  })

  it('puts the chats whose latest incoming message is at the same time in the order of their ids, whatever the order they were read in', async () => {
    const { source, answerer, run } = setup()
    // read order (first message of the window): z, m, a, b; all four have the same latest incoming message
    for (const [i, id] of ['z', 'm', 'a', 'b'].entries()) {
      source.addConversation(conversation({ id, name: id.toUpperCase(), participantId: id, address: `+${id}` }))
      source.addParticipant({ id, savedName: id.toUpperCase(), publicName: null })
      source.addMessages(
        message({ id: `${id}-1`, conversationId: id, senderId: id, timestamp: at(1, i), text: 'first' }),
        message({ id: `${id}-2`, conversationId: id, senderId: id, timestamp: at(5), text: 'last' }),
      )
    }
    await run(request())
    const sent = input(answerer)
    const order = ['A', 'B', 'M', 'Z'].map((n) => sent.indexOf(`Chat with: ${n} `))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
  })

  it('keeps only the conversations that match the chat filter (a name, a number or an id)', async () => {
    const { source, answerer, run } = setup()
    addChat(source, ANA, 'Ana Gómez')
    addChat(source, BETO, 'Beto Ruiz')
    addChat(source, CARLA, 'Carla Díaz')
    await run(request({ chats: [' ana ', '', `id:${CARLA}`] }))
    expect(input(answerer)).toContain('Ana Gómez')
    expect(input(answerer)).toContain('Carla Díaz')
    expect(input(answerer)).not.toContain('Beto Ruiz')
  })

  it('skips the conversations where only the owner wrote', async () => {
    const { source, answerer, run } = setup()
    addChat(source, ANA, 'Ana Gómez')
    source.addConversation(conversation({ id: BETO, name: 'Beto', participantId: BETO }))
    source.addMessages(own(BETO, '1', 1, 'anyone there?'))
    await run(request())
    expect(input(answerer)).not.toContain('Beto')
  })

  it('drops mass messages: a chat with only a mass message and own text is skipped, a mixed one keeps its incoming', async () => {
    const { source, answerer, run } = setup()
    const promo = 'Big sale this weekend, everything half price at the shop, come visit us!'
    for (const id of [ANA, BETO, CARLA, '9911963367946']) {
      source.addConversation(conversation({ id, name: `Chat ${id}`, participantId: id }))
      source.addMessages(own(id, 'mass', 1, promo))
    }
    source.addMessages(message({ id: 'in', conversationId: ANA, senderId: ANA, timestamp: at(2), text: 'I want one' }))
    await run(request())
    expect(input(answerer)).toContain('I want one')
    expect(input(answerer)).not.toContain('Big sale')
    expect(input(answerer)).not.toContain(`Chat ${BETO}`)
  })

  it('leaves out messages outside the window and conversations without any', async () => {
    const { source, answerer, run } = setup()
    addChat(source, ANA, 'Ana Gómez')
    source.addConversation(conversation({ id: BETO, name: 'Beto Ruiz', participantId: BETO }))
    source.addMessages(
      message({ id: 'old', conversationId: BETO, senderId: BETO, timestamp: SINCE - 1, text: 'too old' }),
    )
    await run(request())
    expect(input(answerer)).not.toContain('Beto')
  })
})

describe('AskChats: which messages are read', () => {
  /** Ana: three old messages, the owner's reply, then two new messages. */
  function threads(source: InMemorySource) {
    source.addConversation(conversation({ id: ANA, name: 'Ana Gómez', participantId: ANA }))
    source.addParticipant({ id: ANA, savedName: 'Ana Gómez', publicName: null })
    const m = (n: string, hour: number, text: string) =>
      message({ id: n, conversationId: ANA, senderId: ANA, timestamp: at(hour), text, read: true })
    source.addMessages(
      m('a1', 1, 'old one'),
      m('a2', 2, 'old two'),
      m('a3', 3, 'old three'),
      m('a0', 0, 'older than the context'),
    )
    source.addMessages(own(ANA, 'r', 4, 'I will check'))
    source.addMessages(m('b1', 5, 'any news?'), m('b2', 6, 'please answer'))
  }

  it('unanswered: what others wrote after the last own message, with 3 earlier messages and the marker line', async () => {
    const { source, answerer, run } = setup()
    threads(source)
    const result = await run(request({ selection: 'unanswered' }))
    const sent = input(answerer)
    expect(sent).toContain('any news?')
    expect(sent).toContain('please answer')
    // 3 earlier messages of context: the last 3 before the pending ones (a2, a3 and the owner's reply).
    expect(sent).toContain('old two')
    expect(sent).toContain('old three')
    expect(sent).toContain('I will check')
    expect(sent).not.toContain('old one')
    expect(sent).not.toContain('older than')
    expect(sent.indexOf('I will check')).toBeLessThan(sent.indexOf('the above was already answered'))
    expect(sent.indexOf('the above was already answered')).toBeLessThan(sent.indexOf('any news?'))
    expect(answerer.calls[0]?.systemPrompt).toMatch(/IMPORTANT: from each chat I give you only what is UNANSWERED/)
    expect(result.ok && result.value.messages).toBe(2)
  })

  it('unanswered: finds the last own message even when it is before the window', async () => {
    const { source, answerer, run } = setup()
    source.addConversation(conversation({ id: ANA, name: 'Ana Gómez', participantId: ANA }))
    source.addMessages(
      message({ id: 'x1', conversationId: ANA, senderId: ANA, timestamp: at(1), text: 'new one' }),
      own(ANA, 'long-ago', 0, 'ok', 0),
    )
    await run(request({ selection: 'unanswered', window: { since: at(0, 30), until: UNTIL } }))
    expect(input(answerer)).toContain('new one')
  })

  it('unanswered: a group is read from the last answer of the owner even when that answer is before the window', async () => {
    const { source, answerer, run } = setup()
    const day = (d: number, hour: number) => ba(3, d, hour, 0)
    source.addConversation(conversation({ id: 'g1', name: 'Team', isGroup: true, participantId: null }))
    source.addMessages(
      { ...own('g1', '1', 0, 'my old reply'), timestamp: day(8, 9) },
      message({
        id: 'g-old',
        conversationId: 'g1',
        senderId: BETO,
        timestamp: day(9, 20),
        text: 'PENDING SINCE MONDAY',
      }),
      message({ id: 'g-new', conversationId: 'g1', senderId: BETO, timestamp: day(10, 9), text: 'and today' }),
    )
    await run(request({ selection: 'unanswered', window: { since: day(10, 0), until: day(10, 12) } }))
    // below the marker: it is pending, not "already answered" context
    const [above, below] = input(answerer).split(texts.contextMarker.unanswered)
    expect(above).toContain('my old reply')
    expect(above).not.toContain('PENDING SINCE MONDAY')
    expect(below).toContain('PENDING SINCE MONDAY')
  })

  it('unanswered: the context above the marker leaves out what has nothing to read', async () => {
    const { source, answerer, run } = setup()
    addChat(source, ANA, 'Ana Gómez')
    source.addMessages(
      message({ id: 'st', conversationId: ANA, senderId: ANA, timestamp: at(0, 1), kind: 'sticker', text: null }),
      own(ANA, '1', 0, 'my answer', 2),
      message({ id: 'p', conversationId: ANA, senderId: ANA, timestamp: at(3), text: 'PENDING' }),
    )
    await run(request({ selection: 'unanswered' }))
    const sent = input(answerer)
    expect(sent).toContain('my answer')
    expect(sent).not.toContain(getCatalog('en').transcript.kinds.sticker)
  })

  it('unanswered: nothing is pending when the owner answered last, and the chat is skipped', async () => {
    const { source, answerer, run } = setup()
    addChat(source, ANA, 'Ana Gómez', 2, 1)
    source.addMessages(own(ANA, 'last', 9, 'done'))
    expect(await run(request({ selection: 'unanswered' }))).toEqual(err({ kind: 'noMessages', leftOutLocalOnly: 0 }))
    expect(answerer.calls).toEqual([])
  })

  it('unanswered: a group where the owner never wrote is skipped, an individual chat where they never wrote is all pending', async () => {
    const { source, answerer, run } = setup()
    source.addConversation(conversation({ id: 'g1', name: 'Neighbors', isGroup: true, participantId: null }))
    source.addMessages(
      message({ id: 'g-1', conversationId: 'g1', senderId: ANA, timestamp: at(1), text: 'water cut tomorrow' }),
    )
    addChat(source, BETO, 'Beto Ruiz', 2)
    await run(request({ selection: 'unanswered' }))
    const sent = input(answerer)
    expect(sent).not.toContain('Neighbors')
    expect(sent).not.toContain('water cut')
    expect(sent).toContain('Beto Ruiz says 0')
    expect(sent).not.toContain('the above was already answered')
  })

  it('unanswered: a mass message of the owner does not count as an answer', async () => {
    const { source, answerer, run } = setup()
    const promo = 'Big sale this weekend, everything half price at the shop, come visit us!'
    for (const id of [BETO, CARLA, '9911963367946']) {
      source.addConversation(conversation({ id, name: `Chat ${id}`, participantId: id }))
      source.addMessages(own(id, 'mass', 8, promo))
    }
    source.addConversation(conversation({ id: 'g1', name: 'Group', isGroup: true, participantId: null }))
    source.addMessages(own('g1', 'real', 0, 'I spoke here'))
    source.addMessages(message({ id: 'g1-in', conversationId: 'g1', senderId: ANA, timestamp: at(1), text: 'ping' }))
    source.addMessages(own('g1', 'mass', 2, promo))
    source.addMessages(message({ id: 'g1-in2', conversationId: 'g1', senderId: ANA, timestamp: at(3), text: 'pong' }))
    await run(request({ selection: 'unanswered', chats: ['group'] }))
    // Both pings are pending: the promo (mass) is not a reply.
    expect(input(answerer)).toContain('ping')
    expect(input(answerer)).toContain('pong')
  })

  it('unread: only the unread tail with context, as the digest does', async () => {
    const { source, answerer, run } = setup()
    threads(source)
    source.setUnread(ANA, { kind: 'count', count: 2 })
    const all = source.allMessages().map((x) => (x.id === 'b1' || x.id === 'b2' ? { ...x, read: false } : x))
    source.replaceMessages([...all])
    await run(request({ selection: 'unread' }))
    const sent = input(answerer)
    expect(sent).toContain('any news?')
    expect(sent).toContain('the above was already read')
    expect(sent).toContain('I will check')
  })

  it('unread: a chat with nothing unread is skipped', async () => {
    const { source, answerer, run } = setup()
    addChat(source, ANA, 'Ana Gómez')
    source.setUnread(ANA, { kind: 'count', count: 0 })
    expect(await run(request({ selection: 'unread' }))).toEqual(err({ kind: 'noMessages', leftOutLocalOnly: 0 }))
    expect(answerer.calls).toEqual([])
  })

  it('all: every message of the window, own included, with no marker', async () => {
    const { source, answerer, run } = setup()
    threads(source)
    await run(request({ selection: 'all' }))
    const sent = input(answerer)
    for (const text of ['older than the context', 'old one', 'I will check', 'any news?']) expect(sent).toContain(text)
    expect(sent).not.toContain('already')
    expect(answerer.calls[0]?.systemPrompt).not.toContain('UNANSWERED')
  })
})

describe('AskChats: unanswered also reaches before the window', () => {
  const day = (d: number, hour: number, minute = 0) => ba(3, d, hour, minute)
  const today = { since: day(10, 0), until: day(10, 12) }

  /** Ana ordered on Monday the 9th at 20:00, the owner never replied, and Ana wrote "?" on Tuesday the 10th at 09:00. */
  function monday(source: InMemorySource) {
    source.addConversation(conversation({ id: ANA, name: 'Ana Gómez', participantId: ANA }))
    source.addParticipant({ id: ANA, savedName: 'Ana Gómez', publicName: null })
    source.addMessages(
      message({
        id: 'o',
        conversationId: ANA,
        senderId: ANA,
        timestamp: day(9, 20),
        text: 'ORDER: two cakes for Friday',
      }),
      message({ id: 'q', conversationId: ANA, senderId: ANA, timestamp: day(10, 9), text: '?' }),
    )
  }
  const ownAt = (n: string, timestamp: number, text: string) => ({ ...own(ANA, n, 0, text), timestamp })

  it('an order of Monday with no reply is pending in a request about today, not "already answered" context', async () => {
    const { source, answerer, run } = setup()
    monday(source)
    const result = await run(request({ selection: 'unanswered', window: today }))
    const sent = input(answerer)
    expect(sent).toContain('ORDER: two cakes for Friday')
    expect(sent).toContain('[09/03, 20:00]')
    expect(sent).not.toContain('already answered')
    expect(result.ok && result.value.messages).toBe(2)
  })

  it('with an older answer: that answer is the context above the marker, and everything after it is below', async () => {
    const { source, answerer, run } = setup()
    monday(source)
    source.addMessages(
      message({ id: 'b', conversationId: ANA, senderId: ANA, timestamp: day(9, 17), text: 'do you do cakes?' }),
      ownAt('yes', day(9, 18), 'yes, of course'),
    )
    await run(request({ selection: 'unanswered', window: today }))
    const sent = input(answerer)
    const marker = sent.indexOf('the above was already answered')
    expect(marker).toBeGreaterThan(0)
    expect(sent.indexOf('yes, of course')).toBeLessThan(marker)
    expect(sent.indexOf('do you do cakes?')).toBeLessThan(marker)
    expect(sent.indexOf('ORDER: two cakes')).toBeGreaterThan(marker)
    expect(sent.lastIndexOf('?')).toBeGreaterThan(marker)
  })

  it("every message above the marker is at or before the owner's last answer", async () => {
    const { source, answerer, run } = setup()
    monday(source)
    source.addMessages(
      message({ id: 'c1', conversationId: ANA, senderId: ANA, timestamp: day(9, 10), text: 'CTX-1' }),
      message({ id: 'c2', conversationId: ANA, senderId: ANA, timestamp: day(9, 11), text: 'CTX-2' }),
      ownAt('r', day(9, 12), 'REPLY'),
    )
    await run(request({ selection: 'unanswered', window: today }))
    const sent = input(answerer)
    const above = sent.slice(0, sent.indexOf('the above was already answered'))
    expect(above).toContain('CTX-1')
    expect(above).toContain('CTX-2')
    expect(above).toContain('REPLY')
    expect(above).not.toContain('ORDER')
  })

  it('a chat with nothing pending inside the window is not dragged in by an old unanswered message', async () => {
    const { source, answerer, run } = setup()
    source.addConversation(conversation({ id: ANA, name: 'Ana Gómez', participantId: ANA }))
    source.addMessages(
      message({ id: 'old', conversationId: ANA, senderId: ANA, timestamp: day(9, 20), text: 'OLD UNANSWERED' }),
      ownAt('today', day(10, 8), 'answered today'),
    )
    source.addConversation(conversation({ id: BETO, name: 'Beto Ruiz', participantId: BETO }))
    source.addMessages(
      message({ id: 'x', conversationId: BETO, senderId: BETO, timestamp: day(10, 8), text: 'Beto pending' }),
    )
    await run(request({ selection: 'unanswered', window: today }))
    expect(input(answerer)).toContain('Beto pending')
    expect(input(answerer)).not.toContain('OLD UNANSWERED')
  })

  it('an individual chat where the owner never wrote has everything pending, with no "answered" context', async () => {
    const { source, answerer, run } = setup()
    source.addConversation(conversation({ id: BETO, name: 'Beto Ruiz', participantId: BETO }))
    source.addMessages(
      message({ id: 'x1', conversationId: BETO, senderId: BETO, timestamp: day(9, 8), text: 'LAST WEEK' }),
      message({ id: 'x2', conversationId: BETO, senderId: BETO, timestamp: day(10, 8), text: 'TODAY' }),
    )
    await run(request({ selection: 'unanswered', window: today }))
    expect(input(answerer)).toContain('TODAY')
    expect(input(answerer)).toContain('LAST WEEK')
    expect(input(answerer)).not.toContain('already answered')
  })

  it('reads only the latest 200 pending messages of a chat, and then shows no context above them', async () => {
    const { source, answerer, run } = setup()
    source.addConversation(conversation({ id: BETO, name: 'Beto Ruiz', participantId: BETO }))
    for (let i = 0; i < 250; i++) {
      source.addMessages(
        message({
          id: `m${i}`,
          conversationId: BETO,
          senderId: BETO,
          timestamp: day(5, 1) + i * 60_000,
          text: `PENDING-${i};`,
        }),
      )
    }
    source.addMessages(message({ id: 'now', conversationId: BETO, senderId: BETO, timestamp: day(10, 8), text: 'NOW' }))
    const result = await run(request({ selection: 'unanswered', window: today }))
    const sent = input(answerer)
    expect(result.ok && result.value.messages).toBe(200)
    expect(sent).toContain('NOW')
    expect(sent).toContain('PENDING-249;')
    expect(sent).not.toContain('PENDING-50;')
    expect(sent).not.toContain('already answered')
  })
})

describe('AskChats: failure classes and part limits', () => {
  it.each([
    ['anthropic timed out after 600s', 'timeout'],
    ['anthropic answered 429: SECRET (gave up after 3 retries)', 'rateLimit'],
    ['no API key for gemini: set it with "msum secret set gemini"', 'auth'],
    ['openai answered 401: SECRET', 'auth'],
    ['claude was not found', 'verifyFailed'],
    ['ollama: the text does not fit the context window', 'tooLarge'],
    ['could not reach ollama: SECRET', 'unavailable'],
    ['claude exited with code 1: SECRET', 'other'],
  ])('classifies %j as %s and never keeps its text', async (reason, failure) => {
    const { source, run } = setup({ answerer: new FakeAnswerer(false, () => ({ ok: false, error: reason })) })
    addChat(source, ANA, 'Ana Gómez')
    const result = await run(request())
    expect(result).toEqual(err({ kind: 'answerFailed', failure }))
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('classifies a fallback chain by the first reason', () => {
    expect(classifyAnswerFailure('anthropic timed out after 600s; fallback: could not reach ollama')).toBe('timeout')
  })

  it('a thrown error is class other', async () => {
    const { source, run } = setup({
      answerer: new FakeAnswerer(false, () => {
        throw new Error('SECRET')
      }),
    })
    addChat(source, ANA, 'Ana Gómez')
    expect(await run(request())).toEqual(err({ kind: 'answerFailed', failure: 'other' }))
  })

  it('stops launching extract calls after one fails', async () => {
    const answerer = new FakeAnswerer(false, () => ({ ok: false, error: 'anthropic timed out after 600s' }))
    const { source, run } = setup({ answerer })
    for (let i = 0; i < 9; i++) {
      const id = `99119633679${40 + i}`
      addChat(source, id, `Chat ${i}`, 1, 1)
      source.addMessages(
        message({ id: `${id}-big`, conversationId: id, senderId: id, timestamp: at(2, i), text: 'w'.repeat(100_000) }),
      )
    }
    expect(await run(request())).toEqual(err({ kind: 'answerFailed', failure: 'timeout' }))
    // the first three were already running together; nothing after them was started
    expect(answerer.calls.length).toBeLessThanOrEqual(3)
  })

  it('cuts the text into parts that fit the smaller limit of the answerer', async () => {
    const answerer = Object.assign(new FakeAnswerer(), { maxPartChars: 30_000 })
    const { source, run } = setup({ answerer })
    for (let i = 0; i < 4; i++) {
      const id = `99119633679${40 + i}`
      addChat(source, id, `Chat ${i}`, 1, 1)
      source.addMessages(
        message({ id: `${id}-big`, conversationId: id, senderId: id, timestamp: at(2, i), text: 'w'.repeat(20_000) }),
      )
    }
    const result = await run(request())
    const extracts = answerer.calls.filter((c) => c.systemPrompt.includes('ONE PART'))
    expect(extracts.length).toBeGreaterThanOrEqual(3)
    for (const call of extracts) expect(call.input.length).toBeLessThan(30_000 + 2_000)
    expect(result.ok && result.value.parts).toBe(extracts.length)
  })

  it('without a limit of its own the part is the usual 150 000 characters: 100 000 stay in one call', async () => {
    const answerer = new FakeAnswerer()
    const { source, run } = setup({ answerer })
    addChat(source, ANA, 'Ana Gómez')
    source.addMessages(
      message({ id: 'big', conversationId: ANA, senderId: ANA, timestamp: at(2), text: 'w'.repeat(100_000) }),
    )
    await run(request())
    expect(answerer.calls).toHaveLength(1)
  })
})

describe('AskChats: RF-43, conversations marked "local only"', () => {
  it('never puts them in the text for an external provider, and counts them', async () => {
    const { source, answerer, run } = setup({ localOnly: ['beto'] })
    addChat(source, ANA, 'Ana Gómez')
    addChat(source, BETO, 'Beto Ruiz')
    const result = await run(request())
    expect(input(answerer)).toContain('Ana Gómez')
    expect(input(answerer)).not.toContain('Beto')
    expect(input(answerer)).not.toContain('Ruiz says')
    expect(result.ok && result.value.leftOutLocalOnly).toBe(1)
  })

  it('makes no call when every chat is local only, and says how many were left out', async () => {
    const { source, answerer, run } = setup({ localOnly: [`id:${BETO}`] })
    addChat(source, BETO, 'Beto Ruiz')
    expect(await run(request())).toEqual(err({ kind: 'noMessages', leftOutLocalOnly: 1 }))
    expect(answerer.calls).toEqual([])
  })

  it('also in the parts of a large request', async () => {
    const answerer = new FakeAnswerer(false)
    const { source, run } = setup({ answerer, localOnly: ['beto'] })
    addChat(source, ANA, 'Ana Gómez')
    source.addMessages(
      message({ id: 'big', conversationId: ANA, senderId: ANA, timestamp: at(2), text: 'x'.repeat(ASK_PART_CHARS) }),
    )
    addChat(source, BETO, 'Beto Ruiz')
    await run(request())
    expect(answerer.calls.every((c) => !c.input.includes('Beto'))).toBe(true)
  })

  it('includes them when the answerer is local (nothing leaves the machine)', async () => {
    const { source, answerer, run } = setup({ answerer: new FakeAnswerer(true), localOnly: ['beto'] })
    addChat(source, ANA, 'Ana Gómez')
    addChat(source, BETO, 'Beto Ruiz')
    const result = await run(request())
    expect(input(answerer)).toContain('Beto Ruiz')
    expect(result.ok && result.value.leftOutLocalOnly).toBe(0)
  })
})

describe('AskChats: a request too big for one call', () => {
  /** Three chats of about 100 000 characters each: three parts (a part holds one). */
  function big(source: InMemorySource, count = 3, size = 100_000) {
    for (let i = 0; i < count; i++) {
      const id = `99119633679${40 + i}`
      addChat(source, id, `Chat ${i}`, 1, 1)
      source.addMessages(
        message({
          id: `${id}-big`,
          conversationId: id,
          senderId: id,
          timestamp: at(2, 10 + i),
          text: `${'w'.repeat(size)}`,
        }),
      )
    }
  }

  it('reads it in parts: one extract call per part (3 at a time), then ONE final call that merges the useful extracts', async () => {
    const answerer = new FakeAnswerer(false, (r) =>
      r.systemPrompt.includes('ONE PART')
        ? {
            ok: true,
            text: r.input.includes('Chat 1') ? 'NOTHING' : `found in ${r.input.includes('Chat 0') ? 'zero' : 'two'}`,
            provider: 'p',
          }
        : { ok: true, text: 'FINAL', provider: 'final-provider' },
    )
    const { source, run } = setup({ answerer })
    big(source)
    const progress: AskProgress[] = []
    const result = await run(request({ onProgress: (p) => progress.push(p) }))
    expect(answerer.calls).toHaveLength(4)
    const extracts = answerer.calls.filter((c) => c.systemPrompt.includes('ONE PART'))
    expect(extracts).toHaveLength(3)
    expect(extracts[0]?.input).toMatch(/Part 1 of 3/)
    expect(answerer.maxInFlight).toBeLessThanOrEqual(3)
    expect(answerer.maxInFlight).toBeGreaterThan(1)
    // The final call gets only what was found; NOTHING is filtered out.
    const final = answerer.calls.find((c) => !c.systemPrompt.includes('ONE PART'))
    expect(final?.input).toContain('found in zero')
    expect(final?.input).toContain('found in two')
    expect(final?.input).not.toContain('NOTHING')
    expect(final?.input).toContain('Request: who asked me for money?')
    expect(final?.systemPrompt).toContain('You are the assistant')
    expect(result.ok && result.value).toMatchObject({ answer: 'FINAL', provider: 'final-provider', parts: 3, calls: 4 })
    expect(progress.map((p) => `${p.phase}:${p.done}/${p.total}`)).toEqual([
      'reading:0/3',
      'reading:1/3',
      'reading:2/3',
      'reading:3/3',
      'writing:3/3',
    ])
  })

  it('gives the extract calls the name of the owner and, for unanswered, the note about what is pending', async () => {
    const answerer = new FakeAnswerer(false, () => ({ ok: true, text: 'a', provider: 'p' }))
    const { source, run } = setup({ answerer })
    big(source, 2)
    await run(request({ settings: settings({ ownerName: 'Lucía' }), selection: 'unanswered' }))
    const extract = answerer.calls.find((c) => c.systemPrompt.includes('ONE PART'))?.systemPrompt ?? ''
    expect(extract).toContain('You are the assistant of Lucía')
    expect(extract).toContain('UNANSWERED')
    const plain = new FakeAnswerer(false, () => ({ ok: true, text: 'a', provider: 'p' }))
    const other = setup({ answerer: plain })
    big(other.source, 2)
    await other.run(request({ selection: 'all' }))
    expect(plain.calls.find((c) => c.systemPrompt.includes('ONE PART'))?.systemPrompt).not.toContain('UNANSWERED')
  })

  it('when no part had anything, the answer is credited to the provider that read the parts', async () => {
    const answerer = new FakeAnswerer(false, () => ({ ok: true, text: 'nothing', provider: 'reader' }))
    const { source, run } = setup({ answerer })
    big(source, 2)
    const result = await run(request())
    expect(result.ok && result.value.provider).toBe('reader')
  })

  it('does not make the final call when no part had anything', async () => {
    const answerer = new FakeAnswerer(false, () => ({ ok: true, text: ' nothing. ', provider: 'p' }))
    const { source, run } = setup({ answerer })
    big(source, 2)
    const result = await run(request())
    expect(answerer.calls).toHaveLength(2)
    expect(result.ok && result.value.answer).toBe(texts.nothingFound)
  })

  it('fails when an extract fails, or when the final call does', async () => {
    const failExtract = setup({
      answerer: new FakeAnswerer(false, (_r, call) =>
        call === 1 ? { ok: false, error: 'x' } : { ok: true, text: 'a', provider: 'p' },
      ),
    })
    big(failExtract.source, 2)
    expect(await failExtract.run(request())).toEqual(err({ kind: 'answerFailed', failure: 'other' }))
    const failFinal = setup({
      answerer: new FakeAnswerer(false, (r) =>
        r.systemPrompt.includes('ONE PART') ? { ok: true, text: 'a', provider: 'p' } : { ok: false, error: 'x' },
      ),
    })
    big(failFinal.source, 2)
    expect(await failFinal.run(request())).toEqual(err({ kind: 'answerFailed', failure: 'other' }))
  })

  it('splits a chat bigger than a part, repeating its heading with the continued mark', async () => {
    const answerer = new FakeAnswerer()
    const { source, run } = setup({ answerer })
    addChat(source, ANA, 'Ana Gómez', 1)
    for (let i = 0; i < 5; i++) {
      source.addMessages(
        message({
          id: `l${i}`,
          conversationId: ANA,
          senderId: ANA,
          timestamp: at(2, i),
          text: `${'z'.repeat(60_000)}`,
        }),
      )
    }
    await run(request())
    const extracts = answerer.calls.filter((c) => c.systemPrompt.includes('ONE PART'))
    expect(extracts.length).toBeGreaterThan(1)
    expect(extracts[0]?.input).toContain(`### Chat with: Ana Gómez - ( +${ANA} ) (saved)\n`)
    expect(extracts[1]?.input).toContain(`### Chat with: Ana Gómez - ( +${ANA} ) (saved) (continued)`)
    for (const call of extracts) expect(call.input.length).toBeLessThan(ASK_PART_CHARS + 2_000)
  })

  it('refuses more than 1 200 000 characters, without calling any model', async () => {
    const answerer = new FakeAnswerer()
    const { source, run } = setup({ answerer })
    big(source, 13, 100_000)
    const result = await run(request())
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.kind).toBe('tooMuch')
    expect(answerer.calls).toEqual([])
  })

  it('accepts a request just under the cap', async () => {
    const answerer = new FakeAnswerer()
    const { source, run } = setup({ answerer })
    big(source, 11, 100_000)
    const result = await run(request())
    expect(result.ok).toBe(true)
    expect(answerer.calls.length).toBeGreaterThan(2)
  })
})
