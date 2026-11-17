import { afterEach, describe, expect, it } from 'vitest'
import type { Conversation, MessageKind } from '../../src/domain/model.js'
import type { PersistenceBackend, SourceFixture } from '../support/persistence-backends.js'
import { conversation, message, participant } from '../unit/domain/factories.js'

/**
 * Contract of the DigestSource port (src/application/ports/digest-source.ts). Every adapter, in memory or real,
 * passes this same suite. Messages come from `message()`: id "m1", conversation "c1", timestamp 1000, unless a test
 * says otherwise.
 */
export function describeDigestSourceContract(backend: PersistenceBackend): void {
  describe(`DigestSource contract (${backend.name})`, () => {
    const open: SourceFixture[] = []
    const make = (): SourceFixture => {
      const fixture = backend.source()
      open.push(fixture)
      return fixture
    }
    afterEach(() => {
      for (const fixture of open.splice(0)) fixture.close()
    })

    const window = (since: number, until: number) => ({ since, until })
    const ids = (list: readonly { id: string }[]) => list.map((x) => x.id)

    describe('conversationsWithMessages', () => {
      it('is empty when there is nothing', async () => {
        const { source } = make()
        expect(await source.conversationsWithMessages(window(0, 10_000))).toEqual([])
      })

      it('returns only the conversations with a message inside the window', async () => {
        const { seed, source } = make()
        seed.addConversation(conversation({ id: 'in' }))
        seed.addConversation(conversation({ id: 'out' }))
        seed.addConversation(conversation({ id: 'empty' }))
        seed.addMessages(
          message({ id: 'a', conversationId: 'in', timestamp: 1_500 }),
          message({ id: 'b', conversationId: 'out', timestamp: 5_000 }),
        )
        expect(ids(await source.conversationsWithMessages(window(1_000, 2_000)))).toEqual(['in'])
      })

      it('includes the start of the window and excludes the end', async () => {
        const { seed, source } = make()
        seed.addConversation(conversation({ id: 'atStart' }))
        seed.addConversation(conversation({ id: 'atEnd' }))
        seed.addMessages(
          message({ id: 'a', conversationId: 'atStart', timestamp: 1_000 }),
          message({ id: 'b', conversationId: 'atEnd', timestamp: 2_000 }),
        )
        expect(ids(await source.conversationsWithMessages(window(1_000, 2_000)))).toEqual(['atStart'])
      })

      it('is empty for a window that starts after it ends', async () => {
        const { seed, source } = make()
        seed.addMessages(message({ timestamp: 1_500 }))
        expect(await source.conversationsWithMessages(window(2_000, 1_000))).toEqual([])
      })

      it('orders by the first message inside the window, oldest first, whatever happened before', async () => {
        const { seed, source } = make()
        for (const id of ['early', 'late', 'middle']) seed.addConversation(conversation({ id }))
        seed.addMessages(
          message({ id: 'e0', conversationId: 'early', timestamp: 100 }), // before the window: does not count
          message({ id: 'e1', conversationId: 'early', timestamp: 3_000 }),
          message({ id: 'l1', conversationId: 'late', timestamp: 2_500 }),
          message({ id: 'l2', conversationId: 'late', timestamp: 3_500 }),
          message({ id: 'm1', conversationId: 'middle', timestamp: 2_000 }),
        )
        expect(ids(await source.conversationsWithMessages(window(1_000, 4_000)))).toEqual(['middle', 'late', 'early'])
      })

      it('breaks a tie in the first timestamp by conversation id, ascending, whatever the insertion order', async () => {
        const { seed, source } = make()
        for (const id of ['c', 'a', 'b']) seed.addConversation(conversation({ id }))
        seed.addMessages(
          message({ id: '1', conversationId: 'c', timestamp: 2_000 }),
          message({ id: '2', conversationId: 'a', timestamp: 2_000 }),
          message({ id: '3', conversationId: 'b', timestamp: 2_000 }),
        )
        expect(ids(await source.conversationsWithMessages(window(0, 3_000)))).toEqual(['a', 'b', 'c'])
      })

      it('returns each conversation once however many messages it has', async () => {
        const { seed, source } = make()
        seed.addConversation(conversation())
        seed.addMessages(message({ id: 'a', timestamp: 1_000 }), message({ id: 'b', timestamp: 1_100 }))
        expect(await source.conversationsWithMessages(window(0, 2_000))).toHaveLength(1)
      })

      it('returns every field of the conversation', async () => {
        const { seed, source } = make()
        const group: Conversation = { id: 'g1', isGroup: true, name: 'Family', participantId: null, address: 'g1' }
        const named: Conversation = {
          id: 'p9',
          isGroup: false,
          name: 'Ana',
          participantId: 'p9',
          address: '+5491100000009',
        }
        seed.addConversation(group)
        seed.addConversation(named)
        seed.addMessages(
          message({ id: 'a', conversationId: 'g1', timestamp: 1_000 }),
          message({ id: 'b', conversationId: 'p9', timestamp: 1_100 }),
        )
        expect(await source.conversationsWithMessages(window(0, 2_000))).toEqual([group, named])
      })

      it('returns a conversation for a chat with messages and no metadata: no name, address is the id', async () => {
        const { seed, source } = make()
        seed.addMessages(message({ conversationId: 'stranger', timestamp: 1_000 }))
        expect(await source.conversationsWithMessages(window(0, 2_000))).toEqual([
          { id: 'stranger', isGroup: false, name: null, participantId: 'stranger', address: 'stranger' },
        ])
      })

      it('returns a group declared with no metadata as a group with no name and no participant', async () => {
        const { seed, source } = make()
        seed.markGroup('g2')
        seed.addMessages(message({ conversationId: 'g2', timestamp: 1_000 }))
        expect(await source.conversationsWithMessages(window(0, 2_000))).toEqual([
          { id: 'g2', isGroup: true, name: null, participantId: null, address: 'g2' },
        ])
      })
    })

    describe('messagesInWindow', () => {
      it('returns the messages of that conversation only, oldest first, however they were inserted', async () => {
        const { seed, source } = make()
        seed.addConversation(conversation({ id: 'c1' }))
        seed.addConversation(conversation({ id: 'c2' }))
        seed.addMessages(
          message({ id: 'b', timestamp: 1_300 }),
          message({ id: 'x', conversationId: 'c2', timestamp: 1_200 }),
          message({ id: 'a', timestamp: 1_100 }),
        )
        expect(ids(await source.messagesInWindow('c1', window(1_000, 2_000)))).toEqual(['a', 'b'])
      })

      it('includes the start of the window and excludes the end', async () => {
        const { seed, source } = make()
        seed.addMessages(
          message({ id: 'before', timestamp: 999 }),
          message({ id: 'start', timestamp: 1_000 }),
          message({ id: 'last', timestamp: 1_999 }),
          message({ id: 'end', timestamp: 2_000 }),
        )
        expect(ids(await source.messagesInWindow('c1', window(1_000, 2_000)))).toEqual(['start', 'last'])
      })

      it('keeps the order of insertion between messages with the same timestamp', async () => {
        const { seed, source } = make()
        seed.addMessages(
          message({ id: 'z', timestamp: 1_000 }),
          message({ id: 'a', timestamp: 1_000 }),
          message({ id: 'm', timestamp: 1_000 }),
        )
        expect(ids(await source.messagesInWindow('c1', window(0, 2_000)))).toEqual(['z', 'a', 'm'])
      })

      it('is empty for an unknown conversation', async () => {
        const { source } = make()
        expect(await source.messagesInWindow('nope', window(0, 2_000))).toEqual([])
      })

      it('keeps messages with the same id in different conversations apart', async () => {
        const { seed, source } = make()
        seed.addMessages(
          message({ id: 'same', conversationId: 'c1', text: 'one' }),
          message({ id: 'same', conversationId: 'c2', text: 'two' }),
        )
        expect((await source.messagesInWindow('c1', window(0, 2_000))).map((m) => m.text)).toEqual(['one'])
        expect((await source.messagesInWindow('c2', window(0, 2_000))).map((m) => m.text)).toEqual(['two'])
      })

      it('returns every field of every kind of message', async () => {
        const { seed, source } = make()
        const kinds: MessageKind[] = [
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
        ]
        const sent = kinds.map((kind, i) =>
          message({
            id: `m${i}`,
            timestamp: 1_000 + i,
            kind,
            text: i % 2 === 0 ? `text ${kind} áñ \u{1f600}` : null,
            transcript: kind === 'audio' ? 'what the audio says' : null,
            fromMe: i % 3 === 0,
            read: i % 2 === 1,
            senderId: i === 4 ? null : 'p1',
            senderName: i === 5 ? 'Beto' : null,
            senderAddress: i === 4 ? null : '+5491100000001',
          }),
        )
        seed.addMessages(...sent)
        expect(await source.messagesInWindow('c1', window(0, 2_000))).toEqual(sent)
      })
    })

    describe('participants', () => {
      it('returns the known ids with their names and leaves the unknown ones out', async () => {
        const { seed, source } = make()
        const ana = participant({ id: 'ana', savedName: 'Ana', publicName: 'Anita' })
        const beto = participant({ id: 'beto', savedName: null, publicName: 'Beto' })
        seed.addParticipant(ana)
        seed.addParticipant(beto)
        const found = await source.participants(['ana', 'ghost', 'beto'])
        expect([...found.keys()].sort()).toEqual(['ana', 'beto'])
        expect(found.get('ana')).toEqual(ana)
        expect(found.get('beto')).toEqual(beto)
        expect(found.has('ghost')).toBe(false)
      })

      it('is empty for no ids and for ids that are all unknown', async () => {
        const { seed, source } = make()
        seed.addParticipant(participant({ id: 'ana' }))
        expect((await source.participants([])).size).toBe(0)
        expect((await source.participants(['x', 'y'])).size).toBe(0)
      })

      it('copes with repeated ids', async () => {
        const { seed, source } = make()
        seed.addParticipant(participant({ id: 'ana', savedName: 'Ana' }))
        const found = await source.participants(['ana', 'ana'])
        expect([...found.keys()]).toEqual(['ana'])
      })

      it('keeps a participant with no names', async () => {
        const { seed, source } = make()
        seed.addParticipant(participant({ id: 'ana' }))
        expect((await source.participants(['ana'])).get('ana')).toEqual(participant({ id: 'ana' }))
      })
    })

    describe('unreadState', () => {
      it('is unknown for a conversation nobody said anything about, stored or not', async () => {
        const { seed, source } = make()
        seed.addConversation(conversation({ id: 'c1' }))
        expect(await source.unreadState('c1')).toEqual({ kind: 'unknown' })
        expect(await source.unreadState('nope')).toEqual({ kind: 'unknown' })
      })

      it('tells marked unread, a zero count and a positive count apart', async () => {
        const { seed, source } = make()
        for (const id of ['a', 'b', 'c']) seed.addConversation(conversation({ id }))
        seed.setUnread('a', { kind: 'markedUnread' })
        seed.setUnread('b', { kind: 'count', count: 0 })
        seed.setUnread('c', { kind: 'count', count: 7 })
        expect(await source.unreadState('a')).toEqual({ kind: 'markedUnread' })
        expect(await source.unreadState('b')).toEqual({ kind: 'count', count: 0 })
        expect(await source.unreadState('c')).toEqual({ kind: 'count', count: 7 })
      })

      it('keeps the last state set', async () => {
        const { seed, source } = make()
        seed.addConversation(conversation())
        seed.setUnread('c1', { kind: 'count', count: 3 })
        seed.setUnread('c1', { kind: 'unknown' })
        expect(await source.unreadState('c1')).toEqual({ kind: 'unknown' })
        seed.setUnread('c1', { kind: 'markedUnread' })
        expect(await source.unreadState('c1')).toEqual({ kind: 'markedUnread' })
      })
    })

    describe('lastIncoming', () => {
      const seeded = () => {
        const fixture = make()
        fixture.seed.addConversation(conversation({ id: 'c1' }))
        fixture.seed.addConversation(conversation({ id: 'c2' }))
        fixture.seed.addMessages(
          message({ id: 'i1', timestamp: 1_000, read: true }),
          message({ id: 'o1', timestamp: 1_100, fromMe: true }),
          message({ id: 'i2', timestamp: 1_200, read: false }),
          message({ id: 'x', conversationId: 'c2', timestamp: 1_250 }),
          message({ id: 'i3', timestamp: 1_300, read: false }),
          message({ id: 'o2', timestamp: 1_400, fromMe: true }),
        )
        return fixture.source
      }

      it('returns incoming messages of the whole conversation, newest first, with their read flag', async () => {
        expect(await seeded().lastIncoming('c1', 10)).toEqual([
          { id: 'i3', read: false },
          { id: 'i2', read: false },
          { id: 'i1', read: true },
        ])
      })

      it('is not limited to a window', async () => {
        const source = seeded()
        const all = await source.lastIncoming('c1', 10)
        expect(all).toHaveLength(3)
      })

      it('returns the newest `limit`', async () => {
        expect(ids(await seeded().lastIncoming('c1', 2))).toEqual(['i3', 'i2'])
      })

      it('returns nothing for a limit of 0 and for an unknown conversation', async () => {
        const source = seeded()
        expect(await source.lastIncoming('c1', 0)).toEqual([])
        expect(await source.lastIncoming('nope', 5)).toEqual([])
      })

      it('puts the later insertion first when timestamps tie', async () => {
        const { seed, source } = make()
        seed.addMessages(message({ id: 'first', timestamp: 1_000 }), message({ id: 'second', timestamp: 1_000 }))
        expect(ids(await source.lastIncoming('c1', 5))).toEqual(['second', 'first'])
      })
    })

    describe('messagesBefore', () => {
      const seeded = () => {
        const fixture = make()
        fixture.seed.addMessages(
          message({ id: 'a', timestamp: 1_000 }),
          message({ id: 'b', timestamp: 1_100, fromMe: true }),
          message({ id: 'c', timestamp: 1_200 }),
          message({ id: 'd', timestamp: 1_300 }),
          message({ id: 'e', timestamp: 1_400 }),
          message({ id: 'other', conversationId: 'c2', timestamp: 1_250 }),
        )
        return fixture.source
      }

      it('returns the messages strictly before the timestamp, oldest first, own ones included', async () => {
        expect(ids(await seeded().messagesBefore('c1', 1_300, 10))).toEqual(['a', 'b', 'c'])
      })

      it('keeps the nearest `limit` messages and still hands them over oldest first', async () => {
        expect(ids(await seeded().messagesBefore('c1', 1_400, 2))).toEqual(['c', 'd'])
      })

      it('returns nothing for a limit of 0, before the first message and for an unknown conversation', async () => {
        const source = seeded()
        expect(await source.messagesBefore('c1', 1_400, 0)).toEqual([])
        expect(await source.messagesBefore('c1', 1_000, 5)).toEqual([])
        expect(await source.messagesBefore('nope', 9_999, 5)).toEqual([])
      })

      it('returns whole messages', async () => {
        const { seed, source } = make()
        const sent = message({ id: 'a', timestamp: 1_000, kind: 'audio', text: null, transcript: 'hi', read: true })
        seed.addMessages(sent)
        expect(await source.messagesBefore('c1', 2_000, 5)).toEqual([sent])
      })

      it('keeps insertion order between messages with the same timestamp', async () => {
        const { seed, source } = make()
        seed.addMessages(
          message({ id: 'z', timestamp: 1_000 }),
          message({ id: 'a', timestamp: 1_000 }),
          message({ id: 'q', timestamp: 1_500 }),
        )
        expect(ids(await source.messagesBefore('c1', 1_400, 2))).toEqual(['z', 'a'])
      })
    })

    describe('ownMessageTexts', () => {
      it('returns every own message of the whole history, of any kind, from every conversation', async () => {
        const { seed, source } = make()
        seed.addMessages(
          message({ id: 'a', conversationId: 'c1', timestamp: 1, fromMe: true, text: 'one' }),
          message({ id: 'b', conversationId: 'c2', timestamp: 9_999_999, fromMe: true, text: 'two' }),
          message({ id: 'c', conversationId: 'c2', timestamp: 3, fromMe: true, kind: 'image', text: null }),
          message({ id: 'd', conversationId: 'c1', timestamp: 4, fromMe: false, text: 'theirs' }),
        )
        const own = [...(await source.ownMessageTexts())]
        const key = (x: { conversationId: string; text: string | null }) => `${x.conversationId}:${x.text}`
        expect(own.map(key).sort()).toEqual(['c1:one', 'c2:null', 'c2:two'])
      })

      it('is empty when there are no own messages', async () => {
        const { seed, source } = make()
        seed.addMessages(message({ fromMe: false }))
        expect([...(await source.ownMessageTexts())]).toEqual([])
      })

      it('can be iterated twice, and by two iterations at once, from the same iterable', async () => {
        const { seed, source } = make()
        seed.addMessages(
          message({ id: 'a', fromMe: true, text: 'one' }),
          message({ id: 'b', fromMe: true, text: 'two' }),
        )
        const texts = await source.ownMessageTexts()
        const a = texts[Symbol.iterator]()
        const b = texts[Symbol.iterator]()
        a.next()
        expect([...{ [Symbol.iterator]: () => b }]).toHaveLength(2)
        expect([...texts]).toHaveLength(2)
        expect([...texts]).toHaveLength(2)
      })
    })
  })
}
