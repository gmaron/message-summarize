import { afterEach, describe, expect, it } from 'vitest'
import type { MessageExtras } from '../../../src/domain/model.js'
import {
  SqliteCaptureWriter,
  SqliteConversationPurge,
  SqliteDigestSource,
} from '../../../src/infrastructure/persistence/sqlite/index.js'
import { TempDatabase } from '../../support/persistence-backends.js'
import { message } from '../domain/factories.js'

const temp: TempDatabase[] = []
afterEach(() => {
  for (const t of temp.splice(0)) t.dispose()
})

function open() {
  const t = new TempDatabase()
  temp.push(t)
  const db = t.open()
  const writer = new SqliteCaptureWriter(db)
  const rows = <T>(sql: string, ...args: (string | number)[]): T[] => db.prepare(sql).all(...args) as T[]
  return { db, writer, rows, source: new SqliteDigestSource(db) }
}

const seqOf = (rows: ReturnType<typeof open>['rows'], id: string) =>
  rows<{ seq: number }>('SELECT seq FROM messages WHERE id = ?', id)[0]?.seq as number

describe('the typed details of a message', () => {
  it('stores the raw content and the typed columns of a reply', () => {
    const { writer, rows } = open()
    const extras: MessageExtras = {
      raw: '{"extendedTextMessage":{"text":"hola"}}',
      quoted: { id: 'Q1', kind: 'image', text: 'x'.repeat(300), fromStatus: true },
      forwarded: true,
      viewOnce: true,
    }
    writer.insertMessage(message({ id: 'a' }), {}, 'none', extras)
    expect(
      rows(
        'SELECT raw, quoted_id, quoted_kind, quoted_text, quoted_from_status, forwarded, is_view_once FROM messages',
      ),
    ).toEqual([
      {
        raw: '{"extendedTextMessage":{"text":"hola"}}',
        quoted_id: 'Q1',
        quoted_kind: 'image',
        quoted_text: 'x'.repeat(200),
        quoted_from_status: 1,
        forwarded: 1,
        is_view_once: 1,
      },
    ])
  })

  it('leaves everything empty for a message with no extras', () => {
    const { writer, rows } = open()
    writer.insertMessage(message({ id: 'a' }))
    expect(rows('SELECT raw, quoted_id, quoted_from_status, forwarded, is_view_once FROM messages')).toEqual([
      { raw: null, quoted_id: null, quoted_from_status: 0, forwarded: 0, is_view_once: 0 },
    ])
  })

  it('a replay fills what was missing and never erases what is stored', () => {
    const { writer, rows } = open()
    writer.insertMessage(message({ id: 'a' }), {}, 'none', { raw: '{"a":1}', forwarded: true })
    writer.insertMessage(message({ id: 'a' }), {}, 'none', {
      raw: '{"b":2}',
      quoted: { id: 'Q', kind: null, text: null, fromStatus: false },
    })
    writer.insertMessage(message({ id: 'a' }))
    expect(rows('SELECT raw, quoted_id, forwarded FROM messages')).toEqual([
      { raw: '{"a":1}', quoted_id: 'Q', forwarded: 1 },
    ])
  })

  it('stores media, a location, shared contacts, a poll, an order and a product in their own tables, once per replay', () => {
    const { writer, rows } = open()
    const extras: MessageExtras = {
      media: {
        kind: 'document',
        mimetype: 'application/pdf',
        seconds: null,
        fileLength: 10,
        fileName: 'a.pdf',
        pageCount: 2,
        width: null,
        height: null,
        caption: 'c',
      },
      location: { lat: -34.9, lng: -57.9, name: 'Plaza', address: null, live: true },
      contacts: [
        { displayName: 'Ana', phones: ['+99 1', '+99 2'] },
        { displayName: 'Beto', phones: [] },
      ],
      poll: { question: 'Q?', options: ['a', 'b'], selectableCount: 1 },
      order: { orderId: 'O', itemCount: 3, totalAmount: 12_000, currency: 'ARS', title: 't', message: 'm' },
      product: { productId: 'P', title: 'Alfajor', price: 500, currency: 'ARS', retailerId: 'R' },
    }
    writer.insertMessage(message({ id: 'a' }), {}, 'none', extras)
    writer.insertMessage(message({ id: 'a' }), {}, 'none', extras)
    const seq = seqOf(rows, 'a')
    expect(rows('SELECT * FROM media')).toEqual([
      {
        message_seq: seq,
        kind: 'document',
        mimetype: 'application/pdf',
        seconds: null,
        file_length: 10,
        file_name: 'a.pdf',
        page_count: 2,
        width: null,
        height: null,
        caption: 'c',
      },
    ])
    expect(rows('SELECT * FROM locations')).toEqual([
      { message_seq: seq, lat: -34.9, lng: -57.9, name: 'Plaza', address: null, live: 1 },
    ])
    expect(rows('SELECT display_name, phone, phones FROM shared_contacts ORDER BY id')).toEqual([
      { display_name: 'Ana', phone: '+99 1', phones: '["+99 1","+99 2"]' },
      { display_name: 'Beto', phone: null, phones: '[]' },
    ])
    expect(rows('SELECT question, options, selectable_count FROM polls')).toEqual([
      { question: 'Q?', options: '["a","b"]', selectable_count: 1 },
    ])
    expect(rows('SELECT order_id, item_count, total_amount, currency, title, message FROM orders')).toEqual([
      { order_id: 'O', item_count: 3, total_amount: 12_000, currency: 'ARS', title: 't', message: 'm' },
    ])
    expect(rows('SELECT product_id, title, price, currency, retailer_id FROM products')).toEqual([
      { product_id: 'P', title: 'Alfajor', price: 500, currency: 'ARS', retailer_id: 'R' },
    ])
  })

  it('the details go away with the message', () => {
    const { db, writer, rows } = open()
    writer.insertMessage(message({ id: 'a' }), {}, 'none', {
      media: {
        kind: 'image',
        mimetype: null,
        seconds: null,
        fileLength: null,
        fileName: null,
        pageCount: null,
        width: null,
        height: null,
        caption: null,
      },
      contacts: [{ displayName: 'Ana', phones: [] }],
    })
    db.prepare('DELETE FROM messages').run()
    expect(rows('SELECT * FROM media')).toEqual([])
    expect(rows('SELECT * FROM shared_contacts')).toEqual([])
  })

  it('shows the reply to the digest source, and nothing for a message that is not a reply', async () => {
    const { writer, source } = open()
    writer.insertMessage(message({ id: 'a', timestamp: 1 }), {}, 'none', {
      quoted: { id: 'Q', kind: 'image', text: 'mi torta', fromStatus: true },
    })
    writer.insertMessage(message({ id: 'b', timestamp: 2 }))
    const [a, b] = await source.messagesInWindow('c1', { since: 0, until: 100 })
    expect(a?.reply).toEqual({ kind: 'image', text: 'mi torta', fromStatus: true })
    expect(b).toBeDefined()
    expect(b && 'reply' in b).toBe(false)
  })
})

describe('reactions', () => {
  const reaction = (over: Partial<Parameters<SqliteCaptureWriter['recordReaction']>[0]> = {}) => ({
    conversationId: 'c1',
    targetId: 'm1',
    senderId: 'p1',
    fromMe: false,
    emoji: '👍',
    timestamp: 100,
    ...over,
  })

  it('keeps one per sender and message: a newer one replaces it, an older one is ignored, an empty one removes it', () => {
    const { writer, rows } = open()
    writer.recordReaction(reaction())
    writer.recordReaction(reaction({ emoji: '❤️', timestamp: 200 }))
    writer.recordReaction(reaction({ emoji: '😂', timestamp: 150 }))
    expect(rows('SELECT emoji, timestamp, sender_id, from_me FROM reactions')).toEqual([
      { emoji: '❤️', timestamp: 200, sender_id: 'p1', from_me: 0 },
    ])
    writer.recordReaction(reaction({ emoji: '', timestamp: 300 }))
    expect(rows('SELECT * FROM reactions')).toEqual([])
  })

  it('keeps the owner and each other sender apart, and never touches the messages', async () => {
    const { writer, rows, source } = open()
    writer.insertMessage(message({ id: 'm1' }))
    writer.recordReaction(reaction())
    writer.recordReaction(reaction({ senderId: 'p2' }))
    writer.recordReaction(reaction({ senderId: null, fromMe: true }))
    expect(rows('SELECT COUNT(*) AS n FROM reactions')).toEqual([{ n: 3 }])
    expect(await source.messagesInWindow('c1', { since: 0, until: 1_000_000 })).toHaveLength(1)
    expect(rows('SELECT COUNT(*) AS n FROM messages')).toEqual([{ n: 1 }])
  })

  it('creates the conversation it needs, and is deleted with it', () => {
    const { db, writer, rows } = open()
    writer.recordReaction(reaction({ conversationId: 'gone' }), { isGroup: false })
    writer.recordPollVote({
      conversationId: 'gone',
      pollId: 'P',
      senderId: 'p1',
      fromMe: false,
      timestamp: 1,
      raw: '{}',
    })
    expect(rows('SELECT id FROM conversations')).toEqual([{ id: 'gone' }])
    new SqliteConversationPurge(db).purge('gone')
    expect(rows('SELECT * FROM reactions')).toEqual([])
    expect(rows('SELECT * FROM poll_votes')).toEqual([])
    expect(rows('SELECT * FROM conversations')).toEqual([])
  })
})

describe('poll votes', () => {
  it('are kept as received, and a replay of the same vote adds nothing', () => {
    const { writer, rows } = open()
    const vote = { conversationId: 'c1', pollId: 'P', senderId: 'p1', fromMe: false, timestamp: 5, raw: '{"vote":1}' }
    writer.recordPollVote(vote)
    writer.recordPollVote(vote)
    writer.recordPollVote({ ...vote, timestamp: 6 })
    expect(rows('SELECT poll_id, sender_id, timestamp, raw FROM poll_votes ORDER BY timestamp')).toEqual([
      { poll_id: 'P', sender_id: 'p1', timestamp: 5, raw: '{"vote":1}' },
      { poll_id: 'P', sender_id: 'p1', timestamp: 6, raw: '{"vote":1}' },
    ])
  })
})
