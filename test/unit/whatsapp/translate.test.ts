import { describe, expect, it } from 'vitest'
import type { CaptureMessages } from '../../../src/application/capture-messages.js'
import { createCaptureMessages } from '../../../src/application/capture-messages.js'
import { createGenerateDigest } from '../../../src/application/generate-digest.js'
import { DEFAULT_SETTINGS } from '../../../src/domain/settings.js'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import {
  SqliteCaptureRepository,
  SqliteCaptureWriter,
  SqliteDigestSource,
  SqliteDigestStore,
} from '../../../src/infrastructure/persistence/sqlite/index.js'
import { createRenderers } from '../../../src/infrastructure/rendering/index.js'
import { OwnConversationIds } from '../../../src/infrastructure/whatsapp/own-ids.js'
import { createTranslator, type TranslatorPorts } from '../../../src/infrastructure/whatsapp/translate.js'
import type { WaMessage } from '../../../src/infrastructure/whatsapp/wa-types.js'
import { FakeSummarizer, FixedClock } from '../../support/application-fakes.js'
import { TempDatabase } from '../../support/persistence-backends.js'
import { type RecordedCall, recordingCapture } from '../../support/whatsapp-fakes.js'
import { BA, ba } from '../rendering/support.js'

const ANA = '5491100000001@s.whatsapp.net'
const ANA_LID = '99900000001@lid'
const BETO = '5491100000002@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'
const ME = '5491100000009@s.whatsapp.net'
const ME_LID = '99900000009@lid'
const NOW = 1_800_000_000_000

function setup(extra: Partial<TranslatorPorts> = {}, language: 'es' | 'en' = 'es') {
  const { capture, calls } = recordingCapture()
  const ownIds = new OwnConversationIds()
  ownIds.set([`${ME.replace('@', ':5@')}`, ME_LID])
  const translator = createTranslator({
    capture,
    catalog: getCatalog(language),
    clock: new FixedClock(NOW),
    ownIds,
    ...extra,
  })
  return { translator, calls, ownIds }
}

const eventAt = <T>(calls: RecordedCall[], method: keyof CaptureMessages, index = 0): T =>
  (only(calls, method)[index]?.event ?? {}) as T
const methods = (calls: RecordedCall[]) => calls.map((c) => c.method)
const only = (calls: RecordedCall[], method: keyof CaptureMessages) => calls.filter((c) => c.method === method)

const text = (id: string, remoteJid: string, body: string, extra: Partial<WaMessage> = {}): WaMessage => ({
  key: { remoteJid, id, fromMe: false, ...(extra.key ?? {}) },
  message: { conversation: body },
  messageTimestamp: 1_700_000_000,
  ...extra,
})

describe('messages.upsert (RF-10)', () => {
  it('turns a live incoming message of an individual chat into receiveMessage', async () => {
    const { translator, calls } = setup()
    await translator.messagesUpsert({ type: 'notify', messages: [text('M1', ANA, 'hola', { pushName: 'Ana' })] })
    expect(methods(calls)).toEqual(['conversationMetadata', 'receiveMessage'])
    expect(calls[0]?.event).toEqual({
      conversation: { id: ANA, isGroup: false, name: null, participantId: ANA, address: '+5491100000001' },
    })
    expect(calls[1]?.event).toEqual({
      isGroup: false,
      conversationName: null,
      sender: { id: ANA, savedName: null, publicName: 'Ana' },
      origin: 'live',
      message: {
        id: 'M1',
        conversationId: ANA,
        senderId: ANA,
        senderName: 'Ana',
        senderAddress: '+5491100000001',
        fromMe: false,
        timestamp: 1_700_000_000_000,
        kind: 'text',
        text: 'hola',
        transcript: null,
        read: false,
      },
    })
  })

  it('an own message has no sender', async () => {
    const { translator, calls } = setup()
    const msg = text('M2', ANA, 'listo')
    await translator.messagesUpsert({ type: 'notify', messages: [{ ...msg, key: { ...msg.key, fromMe: true } }] })
    const event = only(calls, 'receiveMessage')[0]?.event as { message: object; sender?: unknown }
    expect(event.sender).toBeUndefined()
    expect(event.message).toMatchObject({ fromMe: true, senderId: null, senderName: null, senderAddress: null })
  })

  it('a group message: the sender is the participant, the group name is asked once for a live message', async () => {
    const asked: string[] = []
    const { translator, calls } = setup({
      fetchGroupSubject: async (jid) => {
        asked.push(jid)
        return 'Grupo Vecinos'
      },
    })
    const msg = text('G1', GROUP, 'hola vecinos', { pushName: 'Beto' })
    await translator.messagesUpsert({
      type: 'notify',
      messages: [
        { ...msg, key: { ...msg.key, participant: `${BETO.replace('@', ':3@')}` } },
        text('G2', GROUP, 'otra'),
      ],
    })
    expect(asked).toEqual([GROUP])
    const received = only(calls, 'receiveMessage')
    expect(received[0]?.event).toMatchObject({
      isGroup: true,
      conversationName: 'Grupo Vecinos',
      sender: { id: BETO, publicName: 'Beto' },
      message: { senderId: BETO, senderAddress: '+5491100000002', conversationId: GROUP },
    })
    // a group message without a participant has no sender
    expect(received[1]?.event).toMatchObject({ message: { senderId: null, senderAddress: null } })
    expect(only(calls, 'conversationMetadata')).toHaveLength(1)
    expect(only(calls, 'conversationMetadata')[0]?.event).toEqual({
      conversation: { id: GROUP, isGroup: true, name: 'Grupo Vecinos', participantId: null, address: GROUP },
    })
  })

  it('a failed group lookup is not repeated for a while', async () => {
    let asked = 0
    const { translator } = setup({
      fetchGroupSubject: async () => {
        asked++
        return null
      },
    })
    await translator.messagesUpsert({ type: 'notify', messages: [text('G1', GROUP, 'a'), text('G2', GROUP, 'b')] })
    expect(asked).toBe(1)
  })

  it('ANY messages.upsert is live while connected, notify or append (decision: as the previous tool)', async () => {
    const { translator, calls } = setup()
    await translator.messagesUpsert({ type: 'notify', messages: [text('A', ANA, 'one')] })
    await translator.messagesUpsert({ type: 'append', messages: [text('B', ANA, 'two')] })
    await translator.messagesUpsert({ messages: [text('C', ANA, 'three')] })
    expect(only(calls, 'receiveMessage').map((c) => (c.event as { origin: string }).origin)).toEqual([
      'live',
      'live',
      'live',
    ])
  })

  it('skips status, broadcasts, newsletters, the own chat (any variant), reactions, protocol messages and empties', async () => {
    const { translator, calls } = setup()
    const reaction: WaMessage = { ...text('R', ANA, ''), message: { protocolMessage: { type: 0 } } }
    await translator.messagesUpsert({
      type: 'notify',
      messages: [
        text('S', 'status@broadcast', 'status'),
        text('L', '120363000000000009@broadcast', 'list'),
        text('N', '120363000000000002@newsletter', 'news'),
        text('O1', ME, 'to myself'),
        text('O2', ME_LID, 'to myself via lid'),
        text('O3', `${ME.replace('@', ':7@')}`, 'to myself with device'),
        reaction,
        text('E', ANA, ''),
        { key: { remoteJid: ANA, id: 'NOMSG' } },
        { key: { remoteJid: ANA, id: 'NOTS' }, message: { conversation: 'x' } },
        { message: { conversation: 'no key' } },
      ],
    })
    expect(calls).toEqual([])
  })

  it('one bad message does not lose the rest, and the failure is reported without content', async () => {
    const warnings: string[] = []
    const { capture, calls } = recordingCapture()
    const failing: CaptureMessages = {
      ...capture,
      receiveMessage: async (event) => {
        if (event.message.id === 'BAD') throw new Error('secret chat text')
        return capture.receiveMessage(event)
      },
    }
    const translator = createTranslator({
      capture: failing,
      catalog: getCatalog('es'),
      clock: new FixedClock(NOW),
      ownIds: new OwnConversationIds(),
      onWarning: (code) => warnings.push(code),
    })
    await translator.messagesUpsert({ type: 'notify', messages: [text('BAD', ANA, 'x'), text('OK', ANA, 'y')] })
    expect(warnings).toEqual(['item-failed'])
    expect(only(calls, 'receiveMessage')).toHaveLength(1)
  })
})

describe('LID to phone number (RF-13)', () => {
  it('uses the alternative id that WhatsApp attaches to the key', async () => {
    const { translator, calls } = setup()
    const msg = text('M', ANA_LID, 'hola')
    await translator.messagesUpsert({ type: 'notify', messages: [{ ...msg, key: { ...msg.key, remoteJidAlt: ANA } }] })
    expect(only(calls, 'receiveMessage')[0]?.event).toMatchObject({
      message: { conversationId: ANA, senderId: ANA, senderAddress: '+5491100000001' },
    })
  })

  it('learns the pair and translates later messages that carry no alternative', async () => {
    const { translator, calls } = setup()
    const first = text('M1', ANA_LID, 'a')
    await translator.messagesUpsert({
      type: 'notify',
      messages: [{ ...first, key: { ...first.key, remoteJidAlt: ANA } }, text('M2', ANA_LID, 'b')],
    })
    expect(
      only(calls, 'receiveMessage').map(
        (c) => (c.event as { message: { conversationId: string } }).message.conversationId,
      ),
    ).toEqual([ANA, ANA])
  })

  it('asks the platform mapping, and keeps the LID when nobody knows the number', async () => {
    const { translator, calls } = setup({
      resolvePhoneNumber: async (lid) => (lid === ANA_LID ? `${ANA.replace('@', ':9@')}` : null),
    })
    await translator.messagesUpsert({
      type: 'notify',
      messages: [text('M1', ANA_LID, 'a'), text('M2', '99900000077@lid', 'b')],
    })
    const ids = only(calls, 'receiveMessage').map(
      (c) => (c.event as { message: { conversationId: string } }).message.conversationId,
    )
    expect(ids).toEqual([ANA, '99900000077@lid'])
    const unknown = only(calls, 'conversationMetadata')[1]?.event as { conversation: { address: string } }
    expect(unknown.conversation.address).toBe('99900000077@lid')
  })

  it('a resolver that throws is the same as no mapping', async () => {
    const { translator, calls } = setup({
      resolvePhoneNumber: async () => {
        throw new Error('boom')
      },
    })
    await translator.messagesUpsert({ type: 'notify', messages: [text('M1', ANA_LID, 'a')] })
    expect(only(calls, 'receiveMessage')).toHaveLength(1)
  })

  it('a LID mapping event and the history mappings are used', async () => {
    const { translator, calls } = setup()
    translator.learnLidMapping({ lid: ANA_LID, pn: ANA })
    await translator.historySet({
      lidPnMappings: [{ lid: '99900000002@lid', pn: BETO }],
      messages: [text('H1', ANA_LID, 'a'), text('H2', '99900000002@lid', 'b')],
    })
    const ids = only(calls, 'receiveMessage').map(
      (c) => (c.event as { message: { conversationId: string } }).message.conversationId,
    )
    expect(ids).toEqual([ANA, BETO])
  })

  it('the sender of a group message is translated through participantAlt', async () => {
    const { translator, calls } = setup()
    const msg = text('G1', GROUP, 'hola')
    await translator.messagesUpsert({
      type: 'notify',
      messages: [{ ...msg, pushName: 'Ana', key: { ...msg.key, participant: ANA_LID, participantAlt: ANA } }],
    })
    expect(only(calls, 'receiveMessage')[0]?.event).toMatchObject({ message: { senderId: ANA }, sender: { id: ANA } })
  })
})

describe('two ids of one person (marks cover both)', () => {
  it('tells onAlias when a pair is learned, once per new pair, and waits for it before capturing the event', async () => {
    const told: [string, string][] = []
    let capturedWhenDone: string[] | null = null
    let callsOf: RecordedCall[] = []
    const { translator, calls } = setup({
      onAlias: async (a, b) => {
        told.push([a, b])
        await new Promise((resolve) => setTimeout(resolve, 5))
        capturedWhenDone ??= callsOf.map((c) => c.method)
      },
    })
    callsOf = calls
    const first = text('M1', ANA_LID, 'a')
    await translator.messagesUpsert({
      type: 'notify',
      messages: [{ ...first, key: { ...first.key, remoteJidAlt: ANA } }, text('M2', ANA_LID, 'b')],
    })
    expect(told).toEqual([[ANA_LID, ANA]])
    // nothing of the event had reached the use case when the listener finished
    expect(capturedWhenDone).toEqual([])
    expect(only(calls, 'receiveMessage')).toHaveLength(2)
    await translator.learnLidMapping({ lid: ANA_LID, pn: ANA })
    expect(told).toHaveLength(1)
    await translator.learnLidMapping({ lid: '99900000002@lid', pn: BETO })
    expect(told).toHaveLength(2)
  })

  it('a listener that fails does not stop the capture', async () => {
    const { translator, calls } = setup({
      onAlias: () => {
        throw new Error('boom')
      },
    })
    const msg = text('M', ANA_LID, 'hola')
    await translator.messagesUpsert({ type: 'notify', messages: [{ ...msg, key: { ...msg.key, remoteJidAlt: ANA } }] })
    expect(only(calls, 'receiveMessage')).toHaveLength(1)
  })

  it('aliasesOf gives the other ids that are known, in both directions, and nothing for the unknown', async () => {
    const { translator } = setup({
      resolveLid: async (phone) => (phone === BETO ? '99900000002@lid' : null),
      resolvePhoneNumber: async (lid) => (lid === '99900000003@lid' ? '5491100000003@s.whatsapp.net' : null),
    })
    expect(await translator.aliasesOf(ANA)).toEqual([])
    await translator.learnLidMapping({ lid: ANA_LID, pn: ANA })
    expect(await translator.aliasesOf(ANA)).toEqual([ANA_LID])
    expect(await translator.aliasesOf(ANA_LID)).toEqual([ANA])
    // from the platform's own mapping
    expect(await translator.aliasesOf(BETO)).toEqual(['99900000002@lid'])
    expect(await translator.aliasesOf('99900000003@lid')).toEqual(['5491100000003@s.whatsapp.net'])
    expect(await translator.aliasesOf('99900000077@lid')).toEqual([])
  })
})

describe('edits (RF-11)', () => {
  const editOf = (id: string, remoteJid: string, original: string, body: string, ts = 1_700_000_100): WaMessage => ({
    key: { remoteJid, id, fromMe: false },
    pushName: 'Ana',
    messageTimestamp: ts,
    message: { protocolMessage: { type: 14, key: { id: original }, editedMessage: { conversation: body } } },
  })

  it('an edit protocol message becomes MessageEdited under the id of the ORIGINAL, with the catalog prefix', async () => {
    const { translator, calls } = setup()
    await translator.messagesUpsert({ type: 'notify', messages: [editOf('E1', ANA, 'M1', 'texto nuevo')] })
    const edited = only(calls, 'editMessage')[0]?.event as {
      message: { id: string; text: string }
      editedAt: number
    }
    expect(edited.message).toMatchObject({
      id: 'M1',
      text: '(editado) texto nuevo',
      conversationId: ANA,
      senderId: ANA,
    })
    expect(edited.editedAt).toBe(1_700_000_100_000)
    expect(only(calls, 'receiveMessage')).toEqual([])
    expect(Object.keys(edited).sort()).toEqual(['conversationName', 'editedAt', 'isGroup', 'message', 'sender'])
  })

  it('a spoofed group edit carries the EDITOR as sender, not the author of the original', async () => {
    const { translator, calls } = setup()
    const spoof: WaMessage = {
      key: { remoteJid: GROUP, id: 'E1', fromMe: false, participant: BETO },
      pushName: 'Beto',
      messageTimestamp: 1_700_000_100,
      message: { protocolMessage: { type: 14, key: { id: 'ANAS-MSG' }, editedMessage: { conversation: 'forged' } } },
    }
    await translator.messagesUpsert({ type: 'notify', messages: [spoof] })
    expect(eventAt<{ message: object }>(calls, 'editMessage').message).toMatchObject({
      id: 'ANAS-MSG',
      senderId: BETO,
      fromMe: false,
    })
    // the owner's edit has no sender, so it can never match a message from someone else
    const own: WaMessage = { ...spoof, key: { remoteJid: GROUP, id: 'E2', fromMe: true }, pushName: undefined }
    await translator.messagesUpsert({ type: 'notify', messages: [own] })
    expect(eventAt<{ message: object }>(calls, 'editMessage', 1).message).toMatchObject({
      id: 'ANAS-MSG',
      senderId: null,
      fromMe: true,
    })
  })

  it('a forged edit with the same text does not hide the real author edit', async () => {
    const { translator, calls } = setup()
    const edit = (id: string, participant: string): WaMessage => ({
      key: { remoteJid: GROUP, id, fromMe: false, participant },
      messageTimestamp: 1_700_000_100,
      message: { protocolMessage: { type: 14, key: { id: 'M1' }, editedMessage: { conversation: 'same text' } } },
    })
    await translator.messagesUpsert({ type: 'notify', messages: [edit('E1', BETO), edit('E2', ANA)] })
    expect(
      only(calls, 'editMessage').map((c) => (c.event as { message: { senderId: string } }).message.senderId),
    ).toEqual([BETO, ANA])
  })

  it('uses the English prefix in an English account', async () => {
    const { translator, calls } = setup({}, 'en')
    await translator.messagesUpsert({ type: 'notify', messages: [editOf('E1', ANA, 'M1', 'new text')] })
    expect(eventAt<{ message: { text: string } }>(calls, 'editMessage').message.text).toBe('(edited) new text')
  })

  it('an edit reported by messages.update is the same edit: it is processed once', async () => {
    const { translator, calls } = setup()
    await translator.messagesUpsert({ type: 'notify', messages: [editOf('E1', ANA, 'M1', 'texto nuevo')] })
    await translator.messagesUpdate([
      {
        key: { remoteJid: ANA, id: 'M1', fromMe: false },
        update: {
          message: { editedMessage: { message: { conversation: 'texto nuevo' } } },
          messageTimestamp: 1_700_000_100,
        },
      },
    ])
    expect(only(calls, 'editMessage')).toHaveLength(1)
  })

  it('an edit that only messages.update reports is translated, and a different edit time is another edit', async () => {
    const { translator, calls } = setup()
    const update = (ts: number, body: string) => ({
      key: { remoteJid: GROUP, id: 'M1', fromMe: false, participant: BETO },
      update: { message: { editedMessage: { message: { conversation: body } } }, messageTimestamp: ts },
    })
    await translator.messagesUpdate([update(1_700_000_200, 'v1'), update(1_700_000_300, 'v2')])
    const edits = only(calls, 'editMessage').map(
      (c) => c.event as { message: { text: string; senderId: string }; editedAt: number },
    )
    expect(edits.map((e) => e.message.text)).toEqual(['(editado) v1', '(editado) v2'])
    expect(edits[0]?.message.senderId).toBe(BETO)
  })

  it('an edit update without a timestamp uses the clock; one with nothing to show is dropped', async () => {
    const { translator, calls } = setup()
    await translator.messagesUpdate([
      { key: { remoteJid: ANA, id: 'M1' }, update: { message: { editedMessage: { message: { conversation: 'x' } } } } },
      { key: { remoteJid: ANA, id: 'M2' }, update: { message: { editedMessage: { message: { conversation: '' } } } } },
      {
        key: { remoteJid: ME, id: 'M3' },
        update: { message: { editedMessage: { message: { conversation: 'mine' } } } },
      },
    ])
    const edits = only(calls, 'editMessage')
    expect(edits).toHaveLength(1)
    expect(eventAt<{ editedAt: number }>(calls, 'editMessage').editedAt).toBe(NOW)
  })
})

describe('read marks and unread counters (RF-12)', () => {
  it('a READ status on an incoming message is MessagesRead, grouped by chat', async () => {
    const { translator, calls } = setup()
    await translator.messagesUpdate([
      { key: { remoteJid: ANA, id: 'M1', fromMe: false }, update: { status: 4 } },
      { key: { remoteJid: ANA, id: 'M2', fromMe: false }, update: { status: 5 } },
      { key: { remoteJid: BETO, id: 'M3', fromMe: false }, update: { status: 4 } },
    ])
    expect(only(calls, 'messagesRead').map((c) => c.event)).toEqual([
      { conversationId: ANA, isGroup: false, conversationName: null, messageIds: ['M1', 'M2'] },
      { conversationId: BETO, isGroup: false, conversationName: null, messageIds: ['M3'] },
    ])
  })

  it('ignores delivery statuses, own messages, the own chat and updates without a status', async () => {
    const { translator, calls } = setup()
    await translator.messagesUpdate([
      { key: { remoteJid: ANA, id: 'M1', fromMe: false }, update: { status: 3 } },
      { key: { remoteJid: ANA, id: 'M2', fromMe: true }, update: { status: 4 } },
      { key: { remoteJid: ME, id: 'M3', fromMe: false }, update: { status: 4 } },
      { key: { remoteJid: ANA, id: 'M4', fromMe: false }, update: {} },
      { key: { id: 'M5' }, update: { status: 4 } },
    ])
    expect(calls).toEqual([])
  })

  it('chats.update: 0 and -1 are unreadChanged, a positive count or no count is ignored', async () => {
    const { translator, calls } = setup()
    await translator.chatsUpdate([
      { id: ANA, unreadCount: 0 },
      { id: BETO, unreadCount: -1 },
      { id: GROUP, unreadCount: 3 },
      { id: ANA },
      { id: ME, unreadCount: 0 },
      { id: 'status@broadcast', unreadCount: 0 },
    ])
    expect(only(calls, 'unreadChanged').map((c) => c.event)).toEqual([
      { conversationId: ANA, isGroup: false, conversationName: null, state: { kind: 'count', count: 0 } },
      { conversationId: BETO, isGroup: false, conversationName: null, state: { kind: 'markedUnread' } },
    ])
  })
})

describe('history (RF-12, RF-13)', () => {
  it('processes contacts, then chats, then messages; the unread snapshot carries the session start', async () => {
    const { translator, calls } = setup()
    translator.beginSession(NOW - 5_000)
    await translator.historySet({
      messages: [text('H1', ANA, 'older', { pushName: 'Ana' })],
      chats: [
        { id: ANA, name: 'Ana G', unreadCount: 2 },
        { id: BETO, unreadCount: 0 },
        { id: GROUP, name: 'Vecinos', markedAsUnread: true },
        { id: 'C', unreadCount: -1 },
        { id: ME, unreadCount: 5 },
        { id: 'status@broadcast', unreadCount: 5 },
      ],
      contacts: [{ id: ANA, name: 'Ana Gómez', notify: 'Anita' }],
    })
    const order = methods(calls)
    expect(order.indexOf('participantInfo')).toBeLessThan(order.indexOf('conversationMetadata'))
    expect(order.lastIndexOf('unreadSnapshot')).toBeLessThan(order.indexOf('receiveMessage'))
    expect(order.at(-1)).toBe('receiveMessage')
    expect(only(calls, 'participantInfo')[0]?.event).toEqual({
      participant: { id: ANA, savedName: 'Ana Gómez', publicName: 'Anita' },
    })
    const snapshots = only(calls, 'unreadSnapshot').map(
      (c) => c.event as { conversationId: string; state: unknown; snapshotStartedAt: number },
    )
    expect(snapshots.map((s) => [s.conversationId, s.state])).toEqual([
      [ANA, { kind: 'count', count: 2 }],
      [BETO, { kind: 'count', count: 0 }],
      [GROUP, { kind: 'markedUnread' }],
      ['C', { kind: 'markedUnread' }],
    ])
    expect(snapshots.every((s) => s.snapshotStartedAt === NOW - 5_000)).toBe(true)
    // messages from history are history, and the group name is never asked for history
    expect(only(calls, 'receiveMessage')[0]?.event).toMatchObject({
      origin: 'history',
      conversationName: 'Ana Gómez',
    })
  })

  it('without a session start the snapshot is stamped with the clock', async () => {
    const { translator, calls } = setup()
    await translator.historySet({ chats: [{ id: ANA, unreadCount: 1 }] })
    expect(eventAt<{ snapshotStartedAt: number }>(calls, 'unreadSnapshot').snapshotStartedAt).toBe(NOW)
  })

  it('the address book is stored under the phone number once, whatever ids it comes with', async () => {
    const { translator, calls } = setup()
    await translator.contacts([
      { id: ANA_LID, lid: ANA_LID, phoneNumber: ANA, name: 'Ana Gómez' },
      { id: ANA, notify: 'Anita' },
      { id: BETO },
      { id: GROUP, name: 'Not a person' },
      { id: ME, name: 'Me' },
      { id: 'status@broadcast', name: 'x' },
    ])
    expect(only(calls, 'participantInfo').map((c) => c.event)).toEqual([
      { participant: { id: ANA, savedName: 'Ana Gómez', publicName: null } },
      { participant: { id: ANA, savedName: null, publicName: 'Anita' } },
    ])
  })

  it('a name from a contact is the conversation name of the individual chat', async () => {
    const { translator, calls } = setup()
    await translator.contacts([{ id: ANA, notify: 'Anita' }])
    await translator.messagesUpsert({ type: 'notify', messages: [text('M1', ANA, 'hola')] })
    expect(only(calls, 'receiveMessage')[0]?.event).toMatchObject({ conversationName: 'Anita' })
  })
})

describe('chat and group names (RF-13)', () => {
  it('chats and groups events announce names once, and a group name is remembered', async () => {
    const { translator, calls } = setup()
    await translator.chatsUpsert([
      { id: ANA, name: 'Ana' },
      { id: ANA, name: 'Ana' },
      { id: BETO },
      { id: ME, name: 'Me' },
    ])
    await translator.chatsUpdate([{ id: GROUP, name: 'Vecinos' }])
    await translator.groups([{ id: GROUP, subject: 'Vecinos 2' }, { id: ANA, subject: 'not a group' }, { id: GROUP }])
    expect(
      only(calls, 'conversationMetadata').map(
        (c) => (c.event as { conversation: { id: string; name: string } }).conversation,
      ),
    ).toMatchObject([
      { id: ANA, name: 'Ana' },
      { id: GROUP, name: 'Vecinos' },
      { id: GROUP, name: 'Vecinos 2' },
    ])
    await translator.messagesUpsert({ type: 'notify', messages: [text('G1', GROUP, 'hola')] })
    expect(only(calls, 'receiveMessage')[0]?.event).toMatchObject({ conversationName: 'Vecinos 2' })
  })
})

describe('asking WhatsApp for a group name', () => {
  it('only when no name is stored (as the previous tool did)', async () => {
    const asked: string[] = []
    const { translator, calls } = setup({
      storedConversationName: async (id) => (id === GROUP ? 'Stored name' : null),
      fetchGroupSubject: async (jid) => {
        asked.push(jid)
        return 'From WhatsApp'
      },
    })
    const other = '120363000000000077@g.us'
    await translator.messagesUpsert({ type: 'notify', messages: [text('A', GROUP, 'a'), text('B', other, 'b')] })
    expect(asked).toEqual([other])
    const names = only(calls, 'receiveMessage').map((c) => (c.event as { conversationName: string }).conversationName)
    expect(names).toEqual(['Stored name', 'From WhatsApp'])
  })

  it('a stored-name lookup that throws is the same as no stored name', async () => {
    const { translator, calls } = setup({
      storedConversationName: async () => {
        throw new Error('db down')
      },
      fetchGroupSubject: async () => 'From WhatsApp',
    })
    await translator.messagesUpsert({ type: 'notify', messages: [text('A', GROUP, 'a')] })
    expect(eventAt<{ conversationName: string }>(calls, 'receiveMessage').conversationName).toBe('From WhatsApp')
  })

  it('a lookup that could not be made (no socket) is not remembered as a failure', async () => {
    let socket = false
    let asked = 0
    const { translator, calls } = setup({
      fetchGroupSubject: async () => {
        asked++
        return socket ? 'Vecinos' : undefined
      },
    })
    await translator.messagesUpsert({ type: 'notify', messages: [text('A', GROUP, 'a')] })
    socket = true
    await translator.messagesUpsert({ type: 'notify', messages: [text('B', GROUP, 'b')] })
    expect(asked).toBe(2)
    expect(eventAt<{ conversationName: string }>(calls, 'receiveMessage', 1).conversationName).toBe('Vecinos')
  })
})

describe('what the translator never does', () => {
  it('has no way to send: its ports are the capture use case and read-only lookups', () => {
    const { translator } = setup()
    expect(Object.keys(translator).sort()).toEqual(
      [
        'aliasesOf',
        'beginSession',
        'chatsUpdate',
        'chatsUpsert',
        'contacts',
        'groups',
        'historySet',
        'knownAliases',
        'learnLidMapping',
        'messagesUpdate',
        'messagesUpsert',
      ].sort(),
    )
  })
})

describe('history order matters for exclusion (RF-14), on SQLite', () => {
  it('contacts and chats before messages: a contact excluded by name never reaches the summarizer', async () => {
    const temp = new TempDatabase()
    try {
      const db = temp.open()
      const until = ba(3, 10, 12, 0)
      const clock = new FixedClock(until)
      const repository = new SqliteCaptureRepository(new SqliteCaptureWriter(db, () => clock.time))
      const capture = createCaptureMessages({
        repository,
        clock,
        excludePatterns: () => ['mariana'],
        ownConversationIds: () => [],
      })
      const translator = createTranslator({
        capture,
        catalog: getCatalog('en'),
        clock,
        ownIds: new OwnConversationIds(),
      })
      const stamp = Math.floor(ba(3, 10, 9, 0) / 1000)
      const mariana = '5491100000003@s.whatsapp.net'
      await translator.historySet({
        // messages listed FIRST in the payload, as Baileys may order them: the adapter must still do contacts first
        messages: [
          text('H1', mariana, 'secret from mariana', { messageTimestamp: stamp }),
          text('H2', ANA, 'lunch?', { messageTimestamp: stamp }),
        ],
        chats: [{ id: mariana, name: 'Mariana' }],
        contacts: [
          { id: mariana, name: 'Mariana López' },
          { id: ANA, name: 'Ana Gómez' },
        ],
      })
      const summarizer = new FakeSummarizer()
      const run = createGenerateDigest({
        source: new SqliteDigestSource(db),
        summarizer,
        store: new SqliteDigestStore(db),
        clock,
        renderers: createRenderers('en', BA),
      })
      await run({
        until,
        from: ba(3, 10, 0, 0),
        preview: true,
        settings: { ...DEFAULT_SETTINGS, excludePatterns: ['mariana'] },
        promptTemplate: null,
        platformName: 'WhatsApp',
      })
      const sent = JSON.stringify(summarizer.calls)
      expect(sent).toContain('lunch?')
      expect(sent).not.toContain('secret from mariana')
      // and capture itself dropped it: only Ana's message is stored
      expect(await repository.findConversation(mariana)).toMatchObject({ name: 'Mariana López' })
      expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 })
    } finally {
      temp.dispose()
    }
  })
})
