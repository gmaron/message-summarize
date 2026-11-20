import { afterEach, describe, expect, it } from 'vitest'
import {
  SqliteCaptureWriter,
  SqliteConversationDirectory,
  SqliteConversationPurge,
} from '../../../src/infrastructure/persistence/sqlite/index.js'
import { TempDatabase } from '../../support/persistence-backends.js'
import { conversation, message, participant } from '../domain/factories.js'

const temp: TempDatabase[] = []
const labels = { unnamedGroup: 'Unnamed group' }
function setup() {
  const t = new TempDatabase()
  temp.push(t)
  const db = t.open()
  const writer = new SqliteCaptureWriter(db, () => 1_000)
  return { db, writer, directory: new SqliteConversationDirectory(db, labels) }
}
afterEach(() => {
  for (const t of temp.splice(0)) t.dispose()
})

describe('SqliteConversationDirectory', () => {
  it('lists newest first with the name the digest uses, the count, the last time and the unread state', () => {
    const { writer, directory } = setup()
    writer.upsertParticipant(participant({ id: 'p1', savedName: 'Ana Test', publicName: 'Anita' }))
    writer.upsertConversation(conversation({ id: 'c1', participantId: 'p1', address: '+9911963367943' }))
    writer.upsertParticipant(participant({ id: 'p2', savedName: null, publicName: 'Beto' }))
    writer.upsertConversation(conversation({ id: 'c2', participantId: 'p2', address: '+9912465397241' }))
    writer.upsertConversation(
      conversation({ id: 'g1@g.us', isGroup: true, participantId: null, name: null, address: 'g1' }),
    )
    writer.insertMessage(message({ id: 'a', conversationId: 'c1', timestamp: 100 }))
    writer.insertMessage(message({ id: 'b', conversationId: 'c1', timestamp: 300 }))
    writer.insertMessage(message({ id: 'c', conversationId: 'c2', timestamp: 200 }))
    writer.setUnread('c1', { kind: 'count', count: 2 })
    writer.setUnread('c2', { kind: 'markedUnread' })
    const page = directory.list()
    expect(page.total).toBe(3)
    expect(page.items.map((i) => i.id)).toEqual(['c1', 'c2', 'g1@g.us'])
    expect(page.items[0]).toEqual({
      id: 'c1',
      isGroup: false,
      name: 'Ana Test',
      address: '+9911963367943',
      lastMessageAt: 300,
      messages: 2,
      unread: { kind: 'count', count: 2 },
    })
    // an unsaved contact is "alias ( address )"; a group with no name and no messages comes last, with the digest's label
    expect(page.items[1]).toMatchObject({
      name: 'Beto ( +9912465397241 )',
      unread: { kind: 'markedUnread' },
      messages: 1,
    })
    expect(page.items[2]).toMatchObject({ name: 'Unnamed group', isGroup: true, lastMessageAt: null, messages: 0 })
  })

  it('searches the name and the address, case-insensitively and beyond ASCII', () => {
    const { writer, directory } = setup()
    for (const [id, saved, address] of [
      ['c1', 'Álvaro Peña', '+9911963367943'],
      ['c2', 'Lavadero Express', '+9912465397241'],
    ] as const) {
      writer.upsertParticipant(participant({ id: `p-${id}`, savedName: saved }))
      writer.upsertConversation(conversation({ id, participantId: `p-${id}`, address }))
      writer.insertMessage(message({ id: 'm', conversationId: id }))
    }
    writer.upsertConversation(
      conversation({ id: 'g', isGroup: true, participantId: null, name: 'Taller de CERÁMICA', address: 'g' }),
    )
    expect(directory.list({ q: 'álvaro' }).items.map((i) => i.id)).toEqual(['c1'])
    expect(directory.list({ q: 'ÁLVARO' }).items.map((i) => i.id)).toEqual(['c1'])
    expect(directory.list({ q: 'cerámica' }).items.map((i) => i.id)).toEqual(['g'])
    expect(directory.list({ q: '7241' }).items.map((i) => i.id)).toEqual(['c2'])
    expect(directory.list({ q: '  express ' }).total).toBe(1)
    expect(directory.list({ q: 'nobody' })).toEqual({ total: 0, items: [] })
  })

  it('treats % _ and the backslash in the search as plain characters', () => {
    const { writer, directory } = setup()
    for (const [id, name] of [
      ['c1', '100% real'],
      ['c2', 'a_b'],
      ['c3', 'axb'],
      ['c4', 'back\\slash'],
    ] as const) {
      writer.upsertConversation(conversation({ id, participantId: null, isGroup: true, name, address: id }))
    }
    expect(directory.list({ q: '%' }).items.map((i) => i.id)).toEqual(['c1'])
    expect(directory.list({ q: '_' }).items.map((i) => i.id)).toEqual(['c2'])
    expect(directory.list({ q: 'a_b' }).items.map((i) => i.id)).toEqual(['c2'])
    expect(directory.list({ q: '\\' }).items.map((i) => i.id)).toEqual(['c4'])
    expect(directory.list({ q: '%%' }).total).toBe(0)
  })

  it('pages with limit and offset, caps the limit at 200 and gives the total', () => {
    const { writer, directory } = setup()
    for (let i = 0; i < 7; i++) {
      writer.upsertConversation(
        conversation({ id: `c${i}`, participantId: null, isGroup: true, name: `n${i}`, address: `c${i}` }),
      )
      writer.insertMessage(message({ id: 'm', conversationId: `c${i}`, timestamp: 1_000 + i }))
    }
    const first = directory.list({ limit: 3 })
    const second = directory.list({ limit: 3, offset: 3 })
    const third = directory.list({ limit: 3, offset: 6 })
    expect(first.total).toBe(7)
    expect([...first.items, ...second.items, ...third.items].map((i) => i.id)).toEqual([
      'c6',
      'c5',
      'c4',
      'c3',
      'c2',
      'c1',
      'c0',
    ])
    expect(directory.list({ offset: 50 })).toEqual({ total: 7, items: [] })
    expect(directory.list({ limit: 100_000 }).items).toHaveLength(7)
    expect(directory.list({ limit: 0 }).items).toHaveLength(1)
    expect(directory.list({ limit: Number.NaN }).items).toHaveLength(7)
  })

  it('find returns one conversation by its exact id, and existing says which ids are stored', () => {
    const { writer, directory } = setup()
    writer.upsertConversation(
      conversation({ id: 'c1', participantId: null, isGroup: true, name: 'Gym', address: 'c1' }),
    )
    expect(directory.find('c1')).toMatchObject({ id: 'c1', name: 'Gym' })
    expect(directory.find('C1')).toBeNull()
    expect(directory.find('x')).toBeNull()
    expect([...directory.existing(['c1', 'zz'])]).toEqual(['c1'])
  })

  it('stays fast and index-driven with thousands of conversations (RNF-11)', () => {
    const { db, directory } = setup()
    const conversations = 3_000
    db.exec('BEGIN')
    const addChat = db.prepare('INSERT INTO conversations (id, is_group, name, address) VALUES (?, 1, ?, ?)')
    const addMessage = db.prepare(
      "INSERT INTO messages (conversation_id, id, from_me, timestamp, kind, text) VALUES (?, ?, 0, ?, 'text', 'x')",
    )
    for (let c = 0; c < conversations; c++) {
      addChat.run(`c${c}`, `Chat ${c}`, `addr${c}`)
      for (let m = 0; m < 8; m++) addMessage.run(`c${c}`, `m${m}`, c * 10 + m)
    }
    db.exec('COMMIT')
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT c.id, (SELECT MAX(m.timestamp) FROM messages m WHERE m.conversation_id = c.id) AS last_at
           FROM conversations c LEFT JOIN participants p ON p.id = c.participant_id ORDER BY last_at DESC LIMIT 50`,
        )
        .all() as { detail: string }[]
    )
      .map((row) => row.detail)
      .join('\n')
    // the newest message of each chat is a lookup in the index, never a scan of messages
    expect(plan).toMatch(/SEARCH m USING (COVERING )?INDEX messages_by_conversation_time/)
    expect(plan).not.toMatch(/SCAN m/)

    const begun = performance.now()
    const page = directory.list({ limit: 50 })
    const search = directory.list({ q: 'chat 29', limit: 50 })
    const deep = directory.list({ limit: 50, offset: 2_900 })
    const elapsed = performance.now() - begun
    expect(page.total).toBe(conversations)
    expect(page.items[0]).toMatchObject({ id: 'c2999', messages: 8, lastMessageAt: 2999 * 10 + 7 })
    expect(search.total).toBe(111)
    expect(deep.items).toHaveLength(50)
    expect(elapsed).toBeLessThan(1_500)
  })
})

describe('SqliteConversationPurge', () => {
  it('deletes the messages and the row of one conversation and nothing else', () => {
    const { db, writer } = setup()
    writer.upsertParticipant(participant({ id: 'p1', savedName: 'Ana' }))
    writer.upsertConversation(conversation({ id: 'c1' }))
    writer.upsertConversation(conversation({ id: 'c2' }))
    writer.insertMessage(message({ id: 'a', conversationId: 'c1' }))
    writer.insertMessage(message({ id: 'b', conversationId: 'c1' }))
    writer.insertMessage(message({ id: 'a', conversationId: 'c2' }))
    db.prepare('INSERT INTO digest_pointer (id, pointer) VALUES (1, 5)').run()
    const purge = new SqliteConversationPurge(db)
    expect(purge.messageCount('c1')).toBe(2)
    expect(purge.purge('c1')).toBe(2)
    expect(purge.messageCount('c1')).toBe(0)
    expect(db.prepare('SELECT id FROM conversations').all()).toEqual([{ id: 'c2' }])
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM participants').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT pointer FROM digest_pointer').get()).toEqual({ pointer: 5 })
    expect(purge.purge('nope')).toBe(0)
  })
})
