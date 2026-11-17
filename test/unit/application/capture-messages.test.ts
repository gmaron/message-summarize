import { describe, expect, it } from 'vitest'
import type { MessageReceived } from '../../../src/application/capture-events.js'
import { type CaptureMessagesDeps, createCaptureMessages } from '../../../src/application/capture-messages.js'
import { createGenerateDigest } from '../../../src/application/generate-digest.js'
import type { CaptureRepository } from '../../../src/application/ports/capture-repository.js'
import type { DigestSource } from '../../../src/application/ports/digest-source.js'
import { DEFAULT_SETTINGS } from '../../../src/domain/settings.js'
import {
  SqliteCaptureRepository,
  SqliteCaptureWriter,
  SqliteDigestSource,
  SqliteDigestStore,
} from '../../../src/infrastructure/persistence/sqlite/index.js'
import { createRenderers } from '../../../src/infrastructure/rendering/index.js'
import { FakeSummarizer, FixedClock } from '../../support/application-fakes.js'
import { InMemoryCaptureRepository } from '../../support/capture-fakes.js'
import { TempDatabase } from '../../support/persistence-backends.js'
import { conversation, message, participant, textOf } from '../domain/factories.js'
import { BA, ba } from '../rendering/support.js'

const NOW = 5_000_000_000
const DAY = 86_400_000
const all = { since: 0, until: Number.MAX_SAFE_INTEGER }
const MASS = textOf(45, 'm')

function setup(patterns: readonly string[] = [], extra: Partial<CaptureMessagesDeps> = {}) {
  const clock = new FixedClock(NOW)
  const repository = new InMemoryCaptureRepository(() => clock.time)
  const capture = createCaptureMessages({
    repository,
    clock,
    excludePatterns: () => patterns,
    ownConversationIds: () => [],
    ...extra,
  })
  return { repository, source: repository.source, capture, clock }
}

const received = (
  overrides: Parameters<typeof message>[0] = {},
  rest: Partial<MessageReceived> = {},
): MessageReceived => ({
  message: message(overrides),
  isGroup: false,
  origin: 'live',
  ...rest,
})

const own = (overrides: Parameters<typeof message>[0] = {}): MessageReceived =>
  received({ fromMe: true, senderId: null, ...overrides })

describe('CaptureMessages: receiving (RF-10)', () => {
  it('stores messages of every kind with the text the adapter gave, and never invents one', async () => {
    const { capture, source } = setup()
    const kinds = [
      'text',
      'image',
      'video',
      'audio',
      'document',
      'sticker',
      'location',
      'contact',
      'poll',
      'event',
    ] as const
    for (const [i, kind] of kinds.entries()) {
      await capture.receiveMessage(received({ id: `m${i}`, kind, timestamp: 1_000 + i, text: `[${kind}]` }))
    }
    await capture.receiveMessage(received({ id: 'none', kind: 'sticker', timestamp: 2_000, text: null }))
    const stored = await source.messagesInWindow('c1', all)
    expect(stored.map((m) => [m.kind, m.text])).toEqual([...kinds.map((k) => [k, `[${k}]`]), ['sticker', null]])
  })

  it('a replay is idempotent: nothing is duplicated and the counter does not move again', async () => {
    const { capture, source } = setup()
    const first = await capture.receiveMessage(received({ id: 'a' }))
    const second = await capture.receiveMessage(received({ id: 'a' }))
    expect([first.isNew, second.isNew]).toEqual([true, false])
    expect(await source.messagesInWindow('c1', all)).toHaveLength(1)
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 1 })
  })

  it('uses the isGroup hint for a conversation it does not know yet', async () => {
    const { capture, repository } = setup()
    await capture.receiveMessage(received({ conversationId: 'g' }, { isGroup: true }))
    expect(await repository.findConversation('g')).toMatchObject({ isGroup: true, participantId: null })
  })

  it('stores the sender the event carries (RF-13)', async () => {
    const { capture, repository } = setup()
    await capture.receiveMessage(received({}, { sender: participant({ publicName: 'Anita', savedName: null }) }))
    expect(await repository.findParticipant('p1')).toEqual(participant({ publicName: 'Anita' }))
  })
})

describe('CaptureMessages: the owner’s own chat', () => {
  it('drops every content event of it and stores nothing, not even the sender', async () => {
    const { capture, repository, source } = setup([], { ownConversationIds: () => ['me', 'me-lid'] })
    const ids = ['me', 'me-lid']
    for (const conversationId of ids) {
      const outcome = await capture.receiveMessage(
        received({ conversationId }, { sender: participant({ id: 'ghost', publicName: 'Ghost' }) }),
      )
      expect(outcome).toEqual({ stored: false, isNew: false, downloadAudio: false })
      const base = { conversationId, isGroup: false }
      expect(
        await capture.editMessage({ message: message({ conversationId }), editedAt: 5, isGroup: false }),
      ).toBeNull()
      await capture.messagesRead({ ...base, messageIds: ['m1'] })
      await capture.unreadChanged({ ...base, state: { kind: 'markedUnread' } })
      await capture.unreadSnapshot({ ...base, state: { kind: 'count', count: 2 }, snapshotStartedAt: 1 })
      await capture.transcriptReady({ ...base, messageId: 'm1', transcript: 't' })
      expect(await repository.findConversation(conversationId)).toBeNull()
    }
    expect(await repository.findParticipant('ghost')).toBeNull()
    expect(await source.conversationsWithMessages(all)).toEqual([])
    // other chats are not affected
    expect((await capture.receiveMessage(received({ conversationId: 'friend' }))).stored).toBe(true)
  })
})

describe('CaptureMessages: exclusion (RF-14)', () => {
  it('stores nothing of a conversation excluded by id', async () => {
    const { capture, source, repository } = setup(['spam-chat'])
    const outcome = await capture.receiveMessage(received({ conversationId: 'spam-chat@g.us' }, { isGroup: true }))
    expect(outcome).toEqual({ stored: false, isNew: false, downloadAudio: false })
    expect(await source.conversationsWithMessages(all)).toEqual([])
    expect(await repository.findConversation('spam-chat@g.us')).toBeNull()
  })

  it('with no exclusions nothing is excluded, even an empty id', async () => {
    const { capture, source } = setup([])
    await capture.receiveMessage(received({ conversationId: '' }))
    expect(await source.conversationsWithMessages(all)).toHaveLength(1)
  })

  it('reads the patterns on every event', async () => {
    let patterns: readonly string[] = []
    const clock = new FixedClock(NOW)
    const repository = new InMemoryCaptureRepository()
    const capture = createCaptureMessages({
      repository,
      clock,
      excludePatterns: () => patterns,
      ownConversationIds: () => [],
    })
    expect((await capture.receiveMessage(received({ id: 'a' }))).stored).toBe(true)
    patterns = ['c1']
    expect((await capture.receiveMessage(received({ id: 'b' }))).stored).toBe(false)
  })

  describe('metadata is always stored, so exclusion by name works afterwards', () => {
    it('an excluded group keeps its name, and its later messages are dropped', async () => {
      const { capture, source, repository } = setup(['PROVEEDORES'])
      await capture.conversationMetadata({
        conversation: conversation({ id: 'g1', isGroup: true, name: 'Grupo Proveedores', participantId: null }),
      })
      expect(await repository.findConversation('g1')).toMatchObject({ name: 'Grupo Proveedores' })
      const outcome = await capture.receiveMessage(received({ conversationId: 'g1' }, { isGroup: true }))
      expect(outcome.stored).toBe(false)
      expect(await source.conversationsWithMessages(all)).toEqual([])
    })

    it('an excluded contact keeps their name, and their chat is dropped (same matcher: a substring)', async () => {
      const { capture, source, repository } = setup(['mariana'])
      await capture.participantInfo({ participant: participant({ id: 'p9', savedName: 'Mariana López' }) })
      expect(await repository.findParticipant('p9')).toMatchObject({ savedName: 'Mariana López' })
      const outcome = await capture.receiveMessage(received({ conversationId: 'p9', senderId: 'p9' }))
      expect(outcome.stored).toBe(false)
      expect(await source.conversationsWithMessages(all)).toEqual([])
    })
  })

  describe('the first message of a chat with no stored name', () => {
    it('is excluded by the conversation name the event carries', async () => {
      const { capture } = setup(['proveedores'])
      const outcome = await capture.receiveMessage(
        received({ conversationId: 'g1' }, { isGroup: true, conversationName: 'Grupo Proveedores' }),
      )
      expect(outcome.stored).toBe(false)
    })

    it('is excluded by the push name of the sender the event carries (individual chat)', async () => {
      const { capture, source, repository } = setup(['mariana'])
      const outcome = await capture.receiveMessage(
        received(
          { conversationId: 'p9', senderId: 'p9' },
          { sender: participant({ id: 'p9', savedName: null, publicName: 'Mariana' }) },
        ),
      )
      expect(outcome.stored).toBe(false)
      expect(await source.conversationsWithMessages(all)).toEqual([])
      // the name itself is kept: that is what excludes the next events
      expect(await repository.findParticipant('p9')).toMatchObject({ publicName: 'Mariana' })
    })

    it('can only be excluded by id when no name is known anywhere', async () => {
      const { capture } = setup(['mariana'])
      expect((await capture.receiveMessage(received({ conversationId: 'p9' }))).stored).toBe(true)
      expect((await capture.receiveMessage(received({ conversationId: 'mariana-id', id: 'x' }))).stored).toBe(false)
    })
  })

  describe('the event name and the stored name both count', () => {
    it('a group renamed to something innocent is still excluded by the stored name', async () => {
      const { capture, repository } = setup(['proveedores'])
      await repository.upsertConversation(
        conversation({ id: 'g1', isGroup: true, name: 'Grupo Proveedores', participantId: null }),
      )
      const outcome = await capture.receiveMessage(
        received({ conversationId: 'g1' }, { isGroup: true, conversationName: 'Family' }),
      )
      expect(outcome.stored).toBe(false)
    })

    it('a group with an innocent stored name is excluded by the name the event carries', async () => {
      const { capture, repository } = setup(['proveedores'])
      await repository.upsertConversation(
        conversation({ id: 'g1', isGroup: true, name: 'Family', participantId: null }),
      )
      const outcome = await capture.receiveMessage(
        received({ conversationId: 'g1' }, { isGroup: true, conversationName: 'Grupo Proveedores' }),
      )
      expect(outcome.stored).toBe(false)
    })

    it('a chat that matches neither is stored', async () => {
      const { capture, repository } = setup(['proveedores'])
      await repository.upsertConversation(
        conversation({ id: 'g1', isGroup: true, name: 'Family', participantId: null }),
      )
      const outcome = await capture.receiveMessage(
        received({ conversationId: 'g1' }, { isGroup: true, conversationName: 'Friends' }),
      )
      expect(outcome.stored).toBe(true)
    })
  })

  describe('every content event of a chat excluded by name is dropped', () => {
    type Chat = { id: string; isGroup: boolean; seed(c: ReturnType<typeof setup>): Promise<void> }
    const chats: [string, Chat][] = [
      [
        'a group',
        {
          id: 'g1',
          isGroup: true,
          seed: ({ repository }) =>
            repository.upsertConversation(
              conversation({ id: 'g1', isGroup: true, name: 'Grupo Proveedores', participantId: null }),
            ),
        },
      ],
      [
        'a contact',
        {
          id: 'p9',
          isGroup: false,
          seed: ({ repository }) =>
            repository.upsertParticipant(participant({ id: 'p9', savedName: 'Proveedores Sur' })),
        },
      ],
    ]

    for (const [label, chat] of chats) {
      describe(label, () => {
        const prepare = async () => {
          const ctx = setup(['proveedores'])
          await chat.seed(ctx)
          return ctx
        }
        const base = { conversationId: chat.id, isGroup: chat.isGroup }

        it('message', async () => {
          const { capture, source } = await prepare()
          const outcome = await capture.receiveMessage(received({ conversationId: chat.id }, { isGroup: chat.isGroup }))
          expect(outcome.stored).toBe(false)
          expect(await source.messagesInWindow(chat.id, all)).toEqual([])
        })

        it('edit: not stored, not even as the message itself', async () => {
          const { capture, source } = await prepare()
          const result = await capture.editMessage({
            message: message({ id: 'a', conversationId: chat.id, text: '(edited) x' }),
            editedAt: 5,
            isGroup: chat.isGroup,
          })
          expect(result).toBeNull()
          expect(await source.messagesInWindow(chat.id, all)).toEqual([])
        })

        it('read receipt', async () => {
          const { capture, source, repository } = await prepare()
          await repository.insertMessage(message({ id: 'a', conversationId: chat.id }))
          await capture.messagesRead({ ...base, messageIds: ['a'] })
          expect((await source.messagesInWindow(chat.id, all))[0]?.read).toBe(false)
        })

        it('live unread change', async () => {
          const { capture, source } = await prepare()
          await capture.unreadChanged({ ...base, state: { kind: 'markedUnread' } })
          await capture.unreadChanged({ ...base, state: { kind: 'count', count: 0 } })
          expect(await source.unreadState(chat.id)).toEqual({ kind: 'unknown' })
        })

        it('unread snapshot', async () => {
          const { capture, source } = await prepare()
          await capture.unreadSnapshot({ ...base, state: { kind: 'count', count: 3 }, snapshotStartedAt: 1 })
          expect(await source.unreadState(chat.id)).toEqual({ kind: 'unknown' })
        })

        it('transcript', async () => {
          const { capture, source, repository } = await prepare()
          await repository.insertMessage(message({ id: 'a', conversationId: chat.id, kind: 'audio' }))
          await capture.transcriptReady({ ...base, messageId: 'a', transcript: 'secret words' })
          expect((await source.messagesInWindow(chat.id, all))[0]?.transcript).toBeNull()
        })
      })
    }
  })
})

describe('CaptureMessages: unread (RF-12) and own messages (RF-33)', () => {
  it('a live incoming message adds one unread; history does not', async () => {
    const { capture, source } = setup()
    await capture.receiveMessage(received({ id: 'a' }))
    await capture.receiveMessage(received({ id: 'b', timestamp: 1_001 }))
    await capture.receiveMessage(received({ id: 'h', conversationId: 'old' }, { origin: 'history' }))
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 2 })
    expect(await source.unreadState('old')).toEqual({ kind: 'unknown' })
  })

  it('a normal own message marks the conversation as read', async () => {
    const { capture, source } = setup()
    await capture.receiveMessage(received({ id: 'a', timestamp: 1_000 }))
    await capture.receiveMessage(received({ id: 'b', timestamp: 1_001 }))
    await capture.receiveMessage(own({ id: 'mine', timestamp: 1_002, text: 'ok' }))
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 0 })
    expect((await source.messagesInWindow('c1', all)).map((m) => m.read)).toEqual([true, true, false])
  })

  it('an own mass message does not mark the conversation as read, and is stored', async () => {
    const { capture, source, repository } = setup()
    for (const other of ['x', 'y']) {
      await repository.insertMessage(message({ id: `own-${other}`, conversationId: other, fromMe: true, text: MASS }))
    }
    await capture.receiveMessage(received({ id: 'a' }))
    await capture.receiveMessage(own({ id: 'mass', timestamp: 1_001, text: MASS }))
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 1 })
    const stored = await source.messagesInWindow('c1', all)
    expect(stored[0]?.read).toBe(false)
    expect(stored.map((m) => m.text)).toContain(MASS)
  })

  it('the same long text sent to only one other conversation is not mass: it marks as read', async () => {
    const { capture, source, repository } = setup()
    await repository.insertMessage(message({ id: 'own-x', conversationId: 'x', fromMe: true, text: MASS }))
    await capture.receiveMessage(received({ id: 'a' }))
    await capture.receiveMessage(own({ id: 'm', timestamp: 1_001, text: MASS }))
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 0 })
  })

  it('a short text sent to many conversations is not mass (40 code points minimum)', async () => {
    const { capture, source, repository } = setup()
    const short = textOf(39, 's')
    for (const other of ['x', 'y', 'z']) {
      await repository.insertMessage(message({ id: `o-${other}`, conversationId: other, fromMe: true, text: short }))
    }
    await capture.receiveMessage(received({ id: 'a' }))
    await capture.receiveMessage(own({ id: 'm', timestamp: 1_001, text: short }))
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 0 })
  })

  it('an own message with no text counts as a normal reply', async () => {
    const { capture, source } = setup()
    await capture.receiveMessage(received({ id: 'a' }))
    await capture.receiveMessage(own({ id: 'm', kind: 'sticker', text: null }))
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 0 })
  })

  it('an own message replayed from history, or a replay of a live one, marks nothing', async () => {
    const { capture, source } = setup()
    await capture.receiveMessage(received({ id: 'a' }))
    await capture.receiveMessage(own({ id: 'm' }))
    await capture.receiveMessage(received({ id: 'b', timestamp: 1_001 }))
    await capture.receiveMessage(own({ id: 'm' })) // replay of the live own message
    await capture.receiveMessage(
      received({ fromMe: true, senderId: null, id: 'm2', timestamp: 1_002 }, { origin: 'history' }),
    )
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 1 })
  })

  it('a live counter of 0 means read on the phone: messages read, counter 0', async () => {
    const { capture, source } = setup()
    await capture.receiveMessage(received({ id: 'a' }))
    await capture.unreadChanged({ conversationId: 'c1', isGroup: false, state: { kind: 'count', count: 0 } })
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 0 })
    expect((await source.messagesInWindow('c1', all))[0]?.read).toBe(true)
  })

  it('marked as unread on the phone is stored; positive counts and unknown are ignored', async () => {
    const { capture, source } = setup()
    await capture.unreadChanged({ conversationId: 'c1', isGroup: false, state: { kind: 'markedUnread' } })
    expect(await source.unreadState('c1')).toEqual({ kind: 'markedUnread' })
    await capture.unreadChanged({ conversationId: 'c1', isGroup: false, state: { kind: 'count', count: 7 } })
    await capture.unreadChanged({ conversationId: 'c1', isGroup: false, state: { kind: 'unknown' } })
    expect(await source.unreadState('c1')).toEqual({ kind: 'markedUnread' })
  })

  it('the initial snapshot does not overwrite what arrived live after it started', async () => {
    const { capture, source, clock } = setup()
    clock.time = 2_000
    await capture.receiveMessage(received({ id: 'a' }))
    await capture.unreadSnapshot({
      conversationId: 'c1',
      isGroup: false,
      state: { kind: 'count', count: 9 },
      snapshotStartedAt: 1_000,
    })
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 1 })
    await capture.unreadSnapshot({
      conversationId: 'fresh',
      isGroup: false,
      state: { kind: 'count', count: 4 },
      snapshotStartedAt: 1_000,
    })
    expect(await source.unreadState('fresh')).toEqual({ kind: 'count', count: 4 })
  })

  it('messages read on another device mark those and the earlier incoming ones', async () => {
    const { capture, source } = setup()
    await capture.receiveMessage(received({ id: 'a', timestamp: 1_000 }))
    await capture.receiveMessage(received({ id: 'b', timestamp: 1_001 }))
    await capture.receiveMessage(received({ id: 'c', timestamp: 1_002 }))
    await capture.messagesRead({ conversationId: 'c1', isGroup: false, messageIds: ['b'] })
    expect((await source.messagesInWindow('c1', all)).map((m) => m.read)).toEqual([true, true, false])
  })
})

describe('CaptureMessages: edits (RF-11)', () => {
  const edited = (overrides: Parameters<typeof message>[0] = {}) => ({
    message: message({ id: 'a', text: '(edited) new', ...overrides }),
    editedAt: 9,
    isGroup: false,
  })

  it('an edit replaces the text of the original and is not a new message', async () => {
    const { capture, source } = setup()
    await capture.receiveMessage(received({ id: 'a', text: 'original' }))
    expect(await capture.editMessage(edited())).toBe('applied')
    expect((await source.messagesInWindow('c1', all))[0]?.text).toBe('(edited) new')
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 1 })
  })

  it('an edit whose original never arrives is stored as the message itself', async () => {
    const { capture, source } = setup()
    expect(await capture.editMessage(edited({ senderName: 'Ana' }))).toBe('inserted')
    const [stored] = await source.messagesInWindow('c1', all)
    expect(stored).toMatchObject({ id: 'a', text: '(edited) new', senderName: 'Ana', fromMe: false })
  })

  it('an incoming edit of a message never seen leaves the unread state unchanged (as the previous tool)', async () => {
    const { capture, source } = setup()
    expect(await capture.editMessage(edited())).toBe('inserted')
    expect(await source.unreadState('c1')).toEqual({ kind: 'unknown' })
    // with a counter already there, it does not move either
    await capture.receiveMessage(received({ id: 'other', timestamp: 2_000 }))
    await capture.editMessage(edited({ id: 'unseen-2' }))
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 1 })
  })

  it('an own edit of a message never seen does not mark the chat as read', async () => {
    const { capture, source } = setup()
    await capture.receiveMessage(received({ id: 'in1', timestamp: 1_000 }))
    await capture.editMessage(edited({ id: 'mine', fromMe: true, senderId: null, text: '(edited) ok' }))
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 1 })
    expect((await source.messagesInWindow('c1', all)).find((m) => m.id === 'in1')?.read).toBe(false)
  })

  it('when the original arrives after the edit, the edited text stays', async () => {
    const { capture, source } = setup()
    await capture.editMessage(edited({ timestamp: 5_000 }))
    const outcome = await capture.receiveMessage(received({ id: 'a', text: 'original', timestamp: 1_000 }))
    expect(outcome.isNew).toBe(false)
    const [stored] = await source.messagesInWindow('c1', all)
    expect([stored?.text, stored?.timestamp]).toEqual(['(edited) new', 1_000])
    expect(await source.unreadState('c1')).toEqual({ kind: 'unknown' }) // not counted by the edit, not counted by the late original
  })

  it('a replay of the original after the edit does not undo it', async () => {
    const { capture, source } = setup()
    await capture.receiveMessage(received({ id: 'a', text: 'original' }))
    await capture.editMessage(edited())
    await capture.receiveMessage(received({ id: 'a', text: 'original' }, { origin: 'history' }))
    expect((await source.messagesInWindow('c1', all))[0]?.text).toBe('(edited) new')
  })

  it('stores the sender of the edit event', async () => {
    const { capture, repository } = setup()
    await capture.editMessage({ ...edited(), sender: participant({ publicName: 'Anita' }) })
    expect(await repository.findParticipant('p1')).toMatchObject({ publicName: 'Anita' })
  })
})

describe('CaptureMessages: identity (RF-13), metadata and transcripts', () => {
  it('stores conversation metadata and participants with cleaned names', async () => {
    const { capture, repository } = setup()
    await capture.conversationMetadata({ conversation: conversation({ name: 'Ana' }) })
    await capture.conversationMetadata({ conversation: conversation({ name: '+54∙∙15' }) })
    await capture.participantInfo({ participant: participant({ savedName: 'Ana G', publicName: '+54∙∙15' }) })
    expect(await repository.findConversation('c1')).toMatchObject({ name: 'Ana' })
    expect(await repository.findParticipant('p1')).toEqual(participant({ savedName: 'Ana G', publicName: null }))
  })

  it('stores a transcript for a stored audio', async () => {
    const { capture, source } = setup()
    await capture.receiveMessage(received({ id: 'a', kind: 'audio', text: '[audio]' }))
    await capture.transcriptReady({ conversationId: 'c1', isGroup: false, messageId: 'a', transcript: 'hola' })
    expect((await source.messagesInWindow('c1', all))[0]?.transcript).toBe('hola')
  })
})

describe('CaptureMessages: audio download (RF-15)', () => {
  const audio = (timestamp: number, origin: 'live' | 'history', overrides = {}) =>
    received({ id: `a${timestamp}`, kind: 'audio', text: '[audio]', timestamp, ...overrides }, { origin })

  it('asks to download every live audio and recent history audios only (14 days by default)', async () => {
    const { capture } = setup()
    expect((await capture.receiveMessage(audio(NOW - 100 * DAY, 'live'))).downloadAudio).toBe(true)
    expect((await capture.receiveMessage(audio(NOW - 14 * DAY, 'history'))).downloadAudio).toBe(true)
    expect((await capture.receiveMessage(audio(NOW - 14 * DAY - 1, 'history'))).downloadAudio).toBe(false)
  })

  it('the history window is configurable', async () => {
    const { capture } = setup([], { audioHistoryDays: 3 })
    expect((await capture.receiveMessage(audio(NOW - 3 * DAY, 'history'))).downloadAudio).toBe(true)
    expect((await capture.receiveMessage(audio(NOW - 3 * DAY - 1, 'history'))).downloadAudio).toBe(false)
  })

  it('not for other kinds', async () => {
    const { capture } = setup()
    expect((await capture.receiveMessage(received({ id: 'i', kind: 'image' }))).downloadAudio).toBe(false)
  })

  it('a replay of an audio that is already transcribed is not downloaded again', async () => {
    const { capture } = setup()
    const event = audio(NOW, 'live')
    expect((await capture.receiveMessage(event)).downloadAudio).toBe(true)
    await capture.transcriptReady({
      conversationId: 'c1',
      isGroup: false,
      messageId: event.message.id,
      transcript: 't',
    })
    expect((await capture.receiveMessage(event)).downloadAudio).toBe(false)
    expect((await capture.receiveMessage({ ...event, origin: 'history' })).downloadAudio).toBe(false)
  })

  it('a replay of an audio that is still untranscribed asks again', async () => {
    const { capture } = setup()
    const event = audio(NOW, 'history')
    expect((await capture.receiveMessage(event)).downloadAudio).toBe(true)
    expect((await capture.receiveMessage(event)).downloadAudio).toBe(true)
  })

  it('an audio that arrives with its transcript is not downloaded', async () => {
    const { capture } = setup()
    expect((await capture.receiveMessage(audio(NOW, 'live', { transcript: 'done' }))).downloadAudio).toBe(false)
  })
})

describe('capture to digest, on SQLite', () => {
  const renderers = createRenderers('en', BA)
  const until = ba(3, 10, 12, 0)
  const hourAt = (hour: number) => ba(3, 10, hour, 0)

  // The same patterns for capture and for the digest, as the composition root will configure them.
  const EXCLUDED = ['excluded', 'proveedores', 'mariana']

  function sqliteSetup(unreadOnly = false) {
    const temp = new TempDatabase()
    const db = temp.open()
    const clock = new FixedClock(until)
    const repository: CaptureRepository = new SqliteCaptureRepository(new SqliteCaptureWriter(db, () => clock.time))
    const source: DigestSource = new SqliteDigestSource(db)
    const capture = createCaptureMessages({
      repository,
      clock,
      excludePatterns: () => EXCLUDED,
      ownConversationIds: () => [],
    })
    const summarizer = new FakeSummarizer()
    const run = createGenerateDigest({ source, summarizer, store: new SqliteDigestStore(db), clock, renderers })
    const digest = () =>
      run({
        until,
        from: hourAt(0),
        preview: true,
        settings: { ...DEFAULT_SETTINGS, unreadOnly, excludePatterns: EXCLUDED },
        promptTemplate: null,
        platformName: 'WhatsApp',
      })
    return { temp, repository, capture, summarizer, digest }
  }

  const live = (id: string, conversationId: string, hour: number, text: string, fromMe = false) =>
    received({
      id,
      conversationId,
      timestamp: hourAt(hour),
      text,
      fromMe,
      senderId: fromMe ? null : conversationId,
    })

  it('a captured conversation ends up in the digest, one excluded by id does not', async () => {
    const { temp, capture, summarizer, digest } = sqliteSetup()
    try {
      await capture.participantInfo({ participant: participant({ id: '5491100000001', savedName: 'Ana Gómez' }) })
      await capture.conversationMetadata({
        conversation: conversation({ id: '5491100000001', participantId: '5491100000001', address: '+5491100000001' }),
      })
      await capture.receiveMessage(live('m1', '5491100000001', 9, 'lunch at noon?'))
      await capture.receiveMessage(live('m2', 'excluded-chat', 10, 'private stuff'))
      const result = await digest()
      expect(result.ok && result.value.summarized).toBe(1)
      expect(summarizer.calls).toHaveLength(1)
      expect(summarizer.calls[0]?.transcript).toContain('lunch at noon?')
      expect(JSON.stringify(summarizer.calls)).not.toContain('private stuff')
    } finally {
      temp.dispose()
    }
  })

  it('a group and a contact excluded by name never reach the summarizer, whatever the event', async () => {
    const { temp, capture, summarizer, digest } = sqliteSetup()
    try {
      // Metadata first (contacts, then chats), as the adapter should do on a history sync.
      await capture.conversationMetadata({
        conversation: conversation({ id: 'g-prov', isGroup: true, name: 'Grupo Proveedores', participantId: null }),
      })
      await capture.participantInfo({ participant: participant({ id: 'p-mar', savedName: 'Mariana López' }) })
      await capture.conversationMetadata({
        conversation: conversation({ id: 'p-mar', participantId: 'p-mar', address: '+5491100000009' }),
      })
      await capture.participantInfo({ participant: participant({ id: 'p-ana', savedName: 'Ana Gómez' }) })

      await capture.receiveMessage(live('g1', 'g-prov', 9, 'price list secret', false))
      await capture.receiveMessage(live('m1', 'p-mar', 9, 'private note from mariana'))
      await capture.editMessage({
        message: message({
          id: 'g1',
          conversationId: 'g-prov',
          text: '(edited) price list secret v2',
          timestamp: hourAt(9),
        }),
        editedAt: hourAt(10),
        isGroup: true,
      })
      await capture.editMessage({
        message: message({
          id: 'm9',
          conversationId: 'p-mar',
          senderId: 'p-mar',
          text: '(edited) lost original',
          timestamp: hourAt(9),
        }),
        editedAt: hourAt(10),
        isGroup: false,
      })
      await capture.unreadChanged({ conversationId: 'g-prov', isGroup: true, state: { kind: 'markedUnread' } })
      await capture.receiveMessage(live('a1', 'p-ana', 9, 'lunch tomorrow?'))

      const result = await digest()
      expect(result.ok && result.value.summarized).toBe(1)
      const sent = JSON.stringify(summarizer.calls)
      expect(sent).toContain('lunch tomorrow?')
      for (const secret of ['price list', 'private note', 'lost original', 'Proveedores', 'Mariana']) {
        expect(sent).not.toContain(secret)
      }
    } finally {
      temp.dispose()
    }
  })

  it('content captured before the name is known stays stored, and the digest still excludes it', async () => {
    const { temp, repository, capture, summarizer, digest } = sqliteSetup()
    try {
      // The messages of a group arrive before any metadata: nothing says yet that it is excluded.
      expect((await capture.receiveMessage(live('g1', 'g-late', 9, 'late secret one'))).stored).toBe(true)
      await capture.receiveMessage(live('a1', 'p-ana', 9, 'lunch tomorrow?'))
      // Then the name arrives.
      await capture.conversationMetadata({
        conversation: conversation({ id: 'g-late', isGroup: true, name: 'Grupo Proveedores', participantId: null }),
      })
      // Stored, not deleted (documented in the CaptureRepository port)...
      expect(await repository.findConversation('g-late')).toMatchObject({ name: 'Grupo Proveedores' })
      // ...later content is dropped...
      expect((await capture.receiveMessage(live('g2', 'g-late', 10, 'late secret two'))).stored).toBe(false)
      // ...and the digest never sends any of it.
      const result = await digest()
      expect(result.ok && result.value.summarized).toBe(1)
      const sent = JSON.stringify(summarizer.calls)
      expect(sent).toContain('lunch tomorrow?')
      expect(sent).not.toContain('late secret')
      expect(sent).not.toContain('Proveedores')
    } finally {
      temp.dispose()
    }
  })

  it('an edit whose original never arrives shows up in the digest', async () => {
    const { temp, capture, summarizer, digest } = sqliteSetup()
    try {
      await capture.editMessage({
        message: message({
          id: 'm1',
          conversationId: 'ana',
          senderId: 'ana',
          text: '(edited) lunch at one',
          timestamp: hourAt(9),
        }),
        editedAt: hourAt(9) + 1,
        isGroup: false,
      })
      await digest()
      expect(summarizer.calls[0]?.transcript).toContain('lunch at one')
    } finally {
      temp.dispose()
    }
  })

  it('with unreadOnly, a chat answered after the message leaves the digest; an own mass message does not answer', async () => {
    const { temp, capture, summarizer, digest } = sqliteSetup(true)
    try {
      await capture.receiveMessage(live('a1', 'ana', 9, 'are you coming?'))
      await capture.receiveMessage(live('b1', 'beto', 9, 'call me'))
      await capture.receiveMessage(live('a2', 'ana', 10, 'yes, on my way', true))
      for (const other of ['x', 'y']) {
        await capture.receiveMessage(live(`mass-${other}`, other, 8, MASS, true))
      }
      await capture.receiveMessage(live('b2', 'beto', 11, MASS, true))
      const result = await digest()
      expect(result.ok && result.value.summarized).toBe(1)
      expect(summarizer.calls[0]?.transcript).toContain('call me')
      expect(summarizer.calls[0]?.transcript).not.toContain('are you coming?')
    } finally {
      temp.dispose()
    }
  })
})
