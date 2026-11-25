import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageReceived, PollVoteReceived, ReactionReceived } from '../../../src/application/capture-events.js'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import { OwnConversationIds } from '../../../src/infrastructure/whatsapp/own-ids.js'
import { createTranslator, type TranslatorPorts } from '../../../src/infrastructure/whatsapp/translate.js'
import type { WaMessage } from '../../../src/infrastructure/whatsapp/wa-types.js'
import { FixedClock } from '../../support/application-fakes.js'
import { type RecordedCall, recordingCapture } from '../../support/whatsapp-fakes.js'

const ANA = '9911963367943@s.whatsapp.net'
const GROUP = '120363146125332922@g.us'
const ME = '9913174261432@s.whatsapp.net'

function setup(extra: Partial<TranscriptPorts> = {}) {
  const { capture, calls } = recordingCapture()
  const ownIds = new OwnConversationIds()
  ownIds.set([ME.replace('@', ':5@')])
  const translator = createTranslator({
    capture,
    catalog: getCatalog('es'),
    clock: new FixedClock(1_800_000_000_000),
    ownIds,
    ...extra,
  })
  return { translator, calls }
}
type TranscriptPorts = TranslatorPorts

const events = <T>(calls: RecordedCall[], method: string): T[] =>
  calls.filter((c) => c.method === method).map((c) => c.event as T)
const methods = (calls: RecordedCall[]) => calls.map((c) => c.method)

const msg = (id: string, chat: string, message: WaMessage['message'], extra: Partial<WaMessage> = {}): WaMessage => ({
  messageTimestamp: 1_700_000_000,
  ...extra,
  key: { remoteJid: chat, id, fromMe: false, ...(extra.key ?? {}) },
  message,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('extras of a captured message (RF-18)', () => {
  it('hands the capture the reply, the media and the raw content next to the message', async () => {
    const { translator, calls } = setup()
    await translator.messagesUpsert({
      type: 'notify',
      messages: [
        msg('M1', ANA, {
          imageMessage: {
            caption: 'mirá',
            mimetype: 'image/jpeg',
            contextInfo: {
              stanzaId: 'S1',
              remoteJid: 'status@broadcast',
              quotedMessage: { conversation: 'mi estado' },
            },
          },
        }),
      ],
    })
    const [event] = events<MessageReceived>(calls, 'receiveMessage')
    expect(event?.message.kind).toBe('image')
    expect(event?.extras?.quoted).toEqual({ id: 'S1', kind: 'text', text: 'mi estado', fromStatus: true })
    expect(event?.extras?.media).toMatchObject({ kind: 'image', mimetype: 'image/jpeg', caption: 'mirá' })
    expect(JSON.parse(event?.extras?.raw as string).imageMessage.caption).toBe('mirá')
  })

  it('stores a type that is not handled as kind other with its raw content, and drops protocol traffic', async () => {
    const { translator, calls } = setup()
    await translator.messagesUpsert({
      type: 'notify',
      messages: [
        msg('G1', ANA, { groupInviteMessage: { groupName: 'Club' } } as never),
        msg('V1', ANA, { ptvMessage: { seconds: 3, mimetype: 'video/mp4' } }),
        msg('K1', ANA, { senderKeyDistributionMessage: { groupId: 'g' } } as never),
        msg('P1', ANA, { protocolMessage: { type: 0 } }),
      ],
    })
    const stored = events<MessageReceived>(calls, 'receiveMessage')
    expect(stored.map((e) => [e.message.id, e.message.kind])).toEqual([
      ['G1', 'other'],
      ['V1', 'video'],
    ])
    expect(stored[0]?.message.text).toBe('[otro tipo de mensaje: groupInviteMessage]')
    expect(JSON.parse(stored[0]?.extras?.raw as string).groupInviteMessage.groupName).toBe('Club')
    expect(stored[1]?.extras?.media).toMatchObject({ kind: 'video', seconds: 3 })
    expect(translator.stats().droppedNotParsed).toBe(2)
  })

  it('stores a catalog order and a product as messages of their own kind', async () => {
    const { translator, calls } = setup()
    await translator.messagesUpsert({
      type: 'notify',
      messages: [
        msg('O1', ANA, {
          orderMessage: { orderId: 'X', itemCount: 2, totalAmount1000: 5_000_000, totalCurrencyCode: 'ARS' },
        }),
        msg('P1', ANA, { productMessage: { product: { productId: 'P', title: 'Alfajor' } } }),
      ],
    })
    const received = events<MessageReceived>(calls, 'receiveMessage')
    expect(received.map((e) => e.message.kind)).toEqual(['order', 'product'])
    expect(received[0]?.message.text).toMatch(/^\[pedido de catálogo: 2 artículos/)
    expect(received[0]?.extras?.order?.orderId).toBe('X')
    expect(received[1]?.extras?.product?.title).toBe('Alfajor')
  })
})

describe('reactions', () => {
  it('are captured as reactions, not as messages', async () => {
    const { translator, calls } = setup()
    await translator.messagesUpsert({
      type: 'notify',
      messages: [
        msg('R1', ANA, { reactionMessage: { key: { id: 'M1' }, text: '👍', senderTimestampMs: 1_700_000_005_000 } }),
        msg('R2', ANA, { reactionMessage: { key: { id: 'M1' }, text: '' } }, { key: { fromMe: true } }),
      ],
    })
    expect(methods(calls)).not.toContain('receiveMessage')
    const [theirs, mine] = events<ReactionReceived>(calls, 'receiveReaction')
    expect(theirs?.reaction).toEqual({
      conversationId: ANA,
      targetId: 'M1',
      senderId: ANA,
      fromMe: false,
      emoji: '👍',
      timestamp: 1_700_000_005_000,
    })
    expect(mine?.reaction).toMatchObject({ senderId: null, fromMe: true, emoji: '', timestamp: 1_700_000_000_000 })
    expect(translator.stats().reactions).toBe(2)
    expect(translator.stats().droppedNotParsed).toBeUndefined()
  })

  it('in a group carry the participant who reacted', async () => {
    const { translator, calls } = setup()
    await translator.messagesUpsert({
      type: 'notify',
      messages: [
        msg('R1', GROUP, { reactionMessage: { key: { id: 'M1' }, text: '❤️' } }, { key: { participant: ANA } }),
      ],
    })
    expect(events<ReactionReceived>(calls, 'receiveReaction')[0]?.reaction.senderId).toBe(ANA)
  })
})

describe('poll votes', () => {
  it('are stored as received (still encrypted)', async () => {
    const { translator, calls } = setup()
    await translator.messagesUpsert({
      type: 'notify',
      messages: [
        msg('V1', ANA, {
          pollUpdateMessage: { pollCreationMessageKey: { id: 'POLL1' }, senderTimestampMs: 1_700_000_001_000 },
        }),
      ],
    })
    const [vote] = events<PollVoteReceived>(calls, 'receivePollVote')
    expect(vote?.vote).toMatchObject({
      conversationId: ANA,
      pollId: 'POLL1',
      fromMe: false,
      timestamp: 1_700_000_001_000,
    })
    expect(JSON.parse(vote?.vote.raw as string).pollCreationMessageKey.id).toBe('POLL1')
    expect(methods(calls)).not.toContain('receiveMessage')
  })
})

describe('history of every sync type (RF-16)', () => {
  it('stores the messages of INITIAL_BOOTSTRAP, RECENT, FULL, ON_DEMAND and PUSH_NAME chunks alike, as history', async () => {
    const { translator, calls } = setup()
    let n = 0
    for (const syncType of [0, 1, 2, 3, 4, 5, 6]) {
      await translator.historySet({
        syncType,
        progress: 10,
        chats: [],
        contacts: [],
        messages: [msg(`H${n++}`, ANA, { conversation: `chunk ${syncType}` })],
      })
    }
    const received = events<MessageReceived>(calls, 'receiveMessage')
    expect(received).toHaveLength(7)
    expect(received.every((e) => e.origin === 'history')).toBe(true)
    expect(translator.stats().historyMessages).toBe(7)
  })
})

describe('messages that cannot be decrypted (RF-19)', () => {
  it('are counted as dropped and reported once per window with their count', async () => {
    vi.useFakeTimers()
    const reports: number[] = []
    const { translator } = setup({ onUndecryptable: (count) => reports.push(count) })
    const stub = (id: string): WaMessage => ({
      key: { remoteJid: ANA, id, fromMe: false },
      messageStubType: 2,
      messageTimestamp: 1,
    })
    await translator.messagesUpsert({ type: 'notify', messages: [stub('A'), stub('B'), stub('C')] })
    expect(translator.stats().droppedNoMessage).toBe(3)
    expect(reports).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reports).toEqual([3])
    // Nothing more to say until another one arrives.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(reports).toEqual([3])
    await translator.messagesUpsert({ type: 'notify', messages: [stub('D')] })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reports).toEqual([3, 1])
  })
})
