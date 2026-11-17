import { afterEach, describe, expect, it } from 'vitest'
import { SqliteCaptureWriter, SqliteDigestSource } from '../../../src/infrastructure/persistence/sqlite/index.js'
import { TempDatabase } from '../../support/persistence-backends.js'
import { conversation, message, participant } from '../domain/factories.js'

const temp: TempDatabase[] = []
const setup = () => {
  const t = new TempDatabase()
  temp.push(t)
  const db = t.open()
  const clock = { time: 1_000 }
  const writer = new SqliteCaptureWriter(db, () => clock.time)
  return { db, writer, clock, source: new SqliteDigestSource(db), temp: t }
}
afterEach(() => {
  for (const t of temp.splice(0)) t.dispose()
})
const all = { since: 0, until: 1_000_000 }

describe('SqliteCaptureWriter', () => {
  it('keeps the known name when a conversation is upserted with a null one', async () => {
    const { writer, source } = setup()
    writer.upsertConversation(conversation({ name: 'Ana' }))
    writer.upsertConversation(conversation({ name: null, address: 'new address' }))
    writer.insertMessage(message())
    const [c] = await source.conversationsWithMessages(all)
    expect(c).toMatchObject({ name: 'Ana', address: 'new address' })
  })

  it('keeps the known names when a participant is upserted with null ones', async () => {
    const { writer, source } = setup()
    writer.upsertParticipant(participant({ savedName: 'Ana', publicName: 'Anita' }))
    writer.upsertParticipant(participant({ savedName: null, publicName: 'Ani' }))
    expect((await source.participants(['p1'])).get('p1')).toEqual({ id: 'p1', savedName: 'Ana', publicName: 'Ani' })
  })

  it('updates a message in place: keeps its position, fills a missing text, never nulls one', async () => {
    const { writer, source } = setup()
    writer.insertMessage(message({ id: 'a', timestamp: 1_000, text: null, kind: 'audio' }))
    writer.insertMessage(message({ id: 'b', timestamp: 1_000, text: 'second' }))
    writer.insertMessage(message({ id: 'a', timestamp: 1_000, text: 'now with text', kind: 'audio' }))
    writer.insertMessage(message({ id: 'b', timestamp: 1_000, text: null }))
    const messages = await source.messagesInWindow('c1', all)
    expect(messages.map((m) => [m.id, m.text])).toEqual([
      ['a', 'now with text'],
      ['b', 'second'],
    ])
  })

  it('records an edit: the new text replaces the original (RF-11)', async () => {
    const { writer, source, db } = setup()
    writer.insertMessage(message({ id: 'a', text: 'original' }))
    expect(writer.editMessage('c1', 'a', 'edited', 5_000)).toBe(true)
    expect(writer.editMessage('c1', 'missing', 'x', 5_000)).toBe(false)
    expect((await source.messagesInWindow('c1', all))[0]?.text).toBe('edited')
    expect(db.prepare('SELECT edited_at FROM messages WHERE id = ?').get('a')).toEqual({ edited_at: 5_000 })
  })

  it('stores a transcript and read marks', async () => {
    const { writer, source } = setup()
    writer.insertMessage(message({ id: 'a', kind: 'audio', text: null }))
    writer.insertMessage(message({ id: 'b', timestamp: 1_100 }))
    expect(writer.setTranscript('c1', 'a', 'hello there')).toBe(true)
    writer.markRead('c1', ['b', 'unknown'])
    const [a, b] = await source.messagesInWindow('c1', all)
    expect([a?.transcript, a?.read, b?.read]).toEqual(['hello there', false, true])
  })

  it('creates a stub conversation for a message or an unread state that arrives before it', async () => {
    const { writer, source } = setup()
    writer.setUnread('early', { kind: 'count', count: 2 })
    writer.insertMessage(message({ conversationId: 'late' }))
    expect(await source.unreadState('early')).toEqual({ kind: 'count', count: 2 })
    expect(await source.conversationsWithMessages(all)).toEqual([
      { id: 'late', isGroup: false, name: null, participantId: 'late', address: 'late' },
    ])
  })

  it('does not let a conversation upsert touch the unread state', async () => {
    const { writer, source } = setup()
    writer.upsertConversation(conversation())
    writer.setUnread('c1', { kind: 'count', count: 4 })
    writer.upsertConversation(conversation({ name: 'Renamed' }))
    expect(await source.unreadState('c1')).toEqual({ kind: 'count', count: 4 })
  })

  describe('unread state and the initial snapshot (RF-12)', () => {
    it('the first snapshot fills a conversation with no state', async () => {
      const { writer, source } = setup()
      writer.setUnreadFromSnapshot('a', { kind: 'count', count: 3 }, 500)
      expect(await source.unreadState('a')).toEqual({ kind: 'count', count: 3 })
    })

    it('a live update after the snapshot started wins over a snapshot batch that arrives later', async () => {
      const { writer, source, clock } = setup()
      clock.time = 600 // the live event
      writer.setUnread('a', { kind: 'count', count: 0 })
      writer.setUnreadFromSnapshot('a', { kind: 'count', count: 5 }, 500) // the snapshot started at 500
      expect(await source.unreadState('a')).toEqual({ kind: 'count', count: 0 })
    })

    it('a live update arriving after the snapshot batch replaces it', async () => {
      const { writer, source, clock } = setup()
      writer.setUnreadFromSnapshot('a', { kind: 'count', count: 5 }, 500)
      clock.time = 700
      writer.setUnread('a', { kind: 'markedUnread' })
      expect(await source.unreadState('a')).toEqual({ kind: 'markedUnread' })
    })

    it('a later reconnect snapshot replaces a stale value of a previous session', async () => {
      const { writer, source, clock } = setup()
      clock.time = 100
      writer.setUnread('a', { kind: 'count', count: 9 }) // last session, long ago
      writer.setUnreadFromSnapshot('a', { kind: 'count', count: 2 }, 5_000) // snapshot of the new session
      expect(await source.unreadState('a')).toEqual({ kind: 'count', count: 2 })
    })

    it('a snapshot does not overwrite an update made at the same instant', async () => {
      const { writer, source, clock } = setup()
      clock.time = 500
      writer.setUnread('a', { kind: 'count', count: 1 })
      writer.setUnreadFromSnapshot('a', { kind: 'count', count: 8 }, 500)
      expect(await source.unreadState('a')).toEqual({ kind: 'count', count: 1 })
    })
  })

  it('creates stub conversations as groups or individual chats depending on the hint', async () => {
    const { writer, source } = setup()
    writer.insertMessage(message({ id: 'a', conversationId: 'g', timestamp: 1_000 }), { isGroup: true })
    writer.insertMessage(message({ id: 'b', conversationId: 'p', timestamp: 1_001 }))
    writer.setUnread('u', { kind: 'markedUnread' }, { isGroup: true })
    writer.setUnreadFromSnapshot('v', { kind: 'markedUnread' }, 1)
    writer.insertMessage(message({ id: 'c', conversationId: 'u', timestamp: 1_002 }))
    writer.insertMessage(message({ id: 'd', conversationId: 'v', timestamp: 1_003 }))
    const found = await source.conversationsWithMessages(all)
    expect(found.map((c) => [c.id, c.isGroup, c.name, c.participantId])).toEqual([
      ['g', true, null, null],
      ['p', false, null, 'p'],
      ['u', true, null, null],
      ['v', false, null, 'v'],
    ])
  })

  it('a hint does not change an existing conversation', async () => {
    const { writer, source } = setup()
    writer.upsertConversation(conversation({ id: 'c1', isGroup: false, participantId: 'p1', address: 'addr' }))
    writer.insertMessage(message(), { isGroup: true })
    expect(await source.conversationsWithMessages(all)).toEqual([
      conversation({ id: 'c1', isGroup: false, participantId: 'p1', address: 'addr' }),
    ])
  })

  describe('edits and replays (RF-11)', () => {
    it('a replay of the original message does not undo an edit', async () => {
      const { writer, source } = setup()
      writer.insertMessage(message({ id: 'a', text: 'original' }))
      writer.editMessage('c1', 'a', 'edited', 5_000)
      writer.insertMessage(message({ id: 'a', text: 'original' }))
      expect((await source.messagesInWindow('c1', all))[0]?.text).toBe('edited')
    })

    it('an edit that is older than the applied one is ignored', async () => {
      const { writer, source } = setup()
      writer.insertMessage(message({ id: 'a', text: 'original' }))
      expect(writer.editMessage('c1', 'a', 'second', 6_000)).toBe(true)
      expect(writer.editMessage('c1', 'a', 'first', 5_000)).toBe(false)
      expect(writer.editMessage('c1', 'a', 'same time', 6_000)).toBe(false)
      expect((await source.messagesInWindow('c1', all))[0]?.text).toBe('second')
      expect(writer.editMessage('c1', 'a', 'third', 7_000)).toBe(true)
      expect((await source.messagesInWindow('c1', all))[0]?.text).toBe('third')
    })
  })

  describe('read marks', () => {
    it('a replay with read = false after markRead keeps the message read', async () => {
      const { writer, source } = setup()
      writer.insertMessage(message({ id: 'a', read: false }))
      writer.markRead('c1', ['a'])
      writer.insertMessage(message({ id: 'a', read: false }))
      expect((await source.messagesInWindow('c1', all))[0]?.read).toBe(true)
    })

    it('a replay with read = true marks an unread message read', async () => {
      const { writer, source } = setup()
      writer.insertMessage(message({ id: 'a', read: false }))
      writer.insertMessage(message({ id: 'a', read: true }))
      expect((await source.messagesInWindow('c1', all))[0]?.read).toBe(true)
    })

    it('a message inserted as read stays read after an unread replay', async () => {
      const { writer, source } = setup()
      writer.insertMessage(message({ id: 'a', read: true }))
      writer.insertMessage(message({ id: 'a', read: false }))
      expect((await source.messagesInWindow('c1', all))[0]?.read).toBe(true)
    })
  })

  describe('names are cleaned here', () => {
    it('a masked conversation name is stored as no name and never overwrites a real one', async () => {
      const { writer, source } = setup()
      writer.upsertConversation(conversation({ name: 'Ana' }))
      writer.upsertConversation(conversation({ name: '+54∙∙∙∙15' }))
      writer.insertMessage(message())
      expect((await source.conversationsWithMessages(all))[0]?.name).toBe('Ana')
      writer.upsertConversation(conversation({ id: 'c2', name: '+54∙∙∙∙16' }))
      writer.insertMessage(message({ id: 'z', conversationId: 'c2' }))
      expect((await source.conversationsWithMessages(all)).find((c) => c.id === 'c2')?.name).toBeNull()
    })

    it('masked participant names never overwrite real ones', async () => {
      const { writer, source } = setup()
      writer.upsertParticipant(participant({ savedName: 'Ana', publicName: 'Anita' }))
      writer.upsertParticipant(participant({ savedName: '+54∙∙∙∙15', publicName: '+54∙∙∙∙15' }))
      expect((await source.participants(['p1'])).get('p1')).toEqual({ id: 'p1', savedName: 'Ana', publicName: 'Anita' })
      writer.upsertParticipant(participant({ id: 'p2', savedName: '+54∙∙∙∙15', publicName: null }))
      expect((await source.participants(['p2'])).get('p2')).toEqual({ id: 'p2', savedName: null, publicName: null })
    })

    it('a masked sender name is stored as null and keeps the real one', async () => {
      const { writer, source } = setup()
      writer.insertMessage(message({ id: 'a', senderName: 'Beto' }))
      writer.insertMessage(message({ id: 'a', senderName: '+54∙∙∙∙15' }))
      writer.insertMessage(message({ id: 'b', timestamp: 1_100, senderName: '+54∙∙∙∙15' }))
      const [a, b] = await source.messagesInWindow('c1', all)
      expect([a?.senderName, b?.senderName]).toEqual(['Beto', null])
    })
  })

  it('refuses a message kind the domain does not know', () => {
    const { writer } = setup()
    expect(() => writer.insertMessage(message({ kind: 'hologram' as never }))).toThrow(/kind/)
  })

  it('keeps the seq of a message across upserts, which is what orders equal timestamps', async () => {
    const { writer, source } = setup()
    writer.insertMessage(message({ id: 'first', timestamp: 1_000, text: null }))
    writer.insertMessage(message({ id: 'second', timestamp: 1_000 }))
    writer.insertMessage(message({ id: 'first', timestamp: 1_000, text: 'filled later' }))
    expect((await source.messagesInWindow('c1', all)).map((m) => m.id)).toEqual(['first', 'second'])
  })

  it('rejects a negative unread count', () => {
    const { writer } = setup()
    expect(() => writer.setUnread('a', { kind: 'count', count: -1 })).toThrow()
  })
})

describe('indexes for the DigestSource queries (RNF-11)', () => {
  const plan = (db: ReturnType<typeof setup>['db'], sql: string, ...params: number[]): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(' | ')

  it('never scans the whole messages table for the window, per-conversation and incoming queries', () => {
    const { db } = setup()
    const window = plan(
      db,
      'SELECT conversation_id, MIN(timestamp) FROM messages WHERE timestamp >= ? AND timestamp < ? GROUP BY conversation_id',
      0,
      1,
    )
    expect(window).toMatch(/USING (COVERING )?INDEX messages_by_time/)
    const inWindow = plan(
      db,
      "SELECT id FROM messages WHERE conversation_id = 'c' AND timestamp >= ? AND timestamp < ? ORDER BY timestamp, rowid",
      0,
      1,
    )
    expect(inWindow).toMatch(/INDEX messages_by_conversation_time|PRIMARY KEY/)
    expect(inWindow).not.toMatch(/SCAN messages(?! USING)/)
    const incoming = plan(
      db,
      "SELECT id FROM messages WHERE conversation_id = 'c' AND from_me = 0 ORDER BY timestamp DESC, rowid DESC LIMIT 5",
    )
    expect(incoming).toMatch(/INDEX messages_incoming/)
    const own = plan(db, 'SELECT conversation_id, text FROM messages WHERE from_me = 1')
    expect(own).toMatch(/INDEX messages_own/)
  })

  describe('a new message and its unread effect are one transaction (RNF-08)', () => {
    for (const effect of ['increment', 'markRead'] as const) {
      it(`${effect}: if the effect fails, the message is not stored either`, async () => {
        const { db, writer, source } = setup()
        writer.insertMessage(message({ id: 'first' }), {}) // the conversation exists
        db.exec(
          "CREATE TRIGGER fail_unread BEFORE UPDATE OF unread_kind ON conversations BEGIN SELECT RAISE(ABORT, 'boom'); END",
        )
        expect(() => writer.insertMessage(message({ id: 'second', timestamp: 2_000 }), {}, effect)).toThrow(/boom/)
        expect((await source.messagesInWindow('c1', all)).map((m) => m.id)).toEqual(['first'])
        db.exec('DROP TRIGGER fail_unread')
        writer.insertMessage(message({ id: 'second', timestamp: 2_000 }), {}, effect)
        expect((await source.messagesInWindow('c1', all)).map((m) => m.id)).toEqual(['first', 'second'])
      })
    }
  })
})
