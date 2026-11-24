import type { DigestSource } from '../../../application/ports/digest-source.js'
import type { OwnMessageText } from '../../../domain/mass.js'
import type {
  Conversation,
  Message,
  MessageKind,
  Participant,
  ReplyContext,
  UnreadState,
} from '../../../domain/model.js'
import type { IncomingMessage } from '../../../domain/unread.js'
import type { SummaryWindow } from '../../../domain/window.js'
import type { Database } from './database.js'

interface ConversationRow {
  id: string
  is_group: number
  name: string | null
  participant_id: string | null
  address: string
}

interface MessageRow {
  conversation_id: string
  id: string
  sender_id: string | null
  sender_name: string | null
  sender_address: string | null
  from_me: number
  timestamp: number
  kind: string
  text: string | null
  transcript: string | null
  read: number
  quoted_kind: string | null
  quoted_text: string | null
  quoted_from_status: number
  quoted_id: string | null
}

const MESSAGE_COLUMNS =
  'conversation_id, id, sender_id, sender_name, sender_address, from_me, timestamp, kind, text, transcript, read, ' +
  'quoted_kind, quoted_text, quoted_from_status, quoted_id'

const toConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  isGroup: row.is_group !== 0,
  name: row.name,
  participantId: row.participant_id,
  address: row.address,
})

const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  conversationId: row.conversation_id,
  senderId: row.sender_id,
  senderName: row.sender_name,
  senderAddress: row.sender_address,
  fromMe: row.from_me !== 0,
  timestamp: row.timestamp,
  kind: row.kind as MessageKind,
  text: row.text,
  transcript: row.transcript,
  read: row.read !== 0,
  ...replyOf(row),
})

/** The reply context of a row, or nothing for a message that is not a reply (so the Message has no `reply` key). */
function replyOf(row: MessageRow): { reply: ReplyContext } | Record<string, never> {
  if (row.quoted_id === null && row.quoted_kind === null && row.quoted_text === null && row.quoted_from_status === 0) {
    return {}
  }
  return {
    reply: {
      kind: row.quoted_kind as MessageKind | null,
      text: row.quoted_text,
      fromStatus: row.quoted_from_status !== 0,
    },
  }
}

/**
 * Read side of the SQLite database: implements the DigestSource port.
 *
 * Tie rules, so the output never depends on how SQLite happens to scan:
 * - Messages with the same timestamp keep insertion order (`seq`). An upsert of an existing message keeps its
 *   place.
 * - Conversations whose first message in the window has the same timestamp are ordered by id, ascending.
 * - Messages of kind `other` (types that are not handled, stored for their raw content) are never read for a digest or
 *   an Ask: they are not part of what is summarized, and they do not make a chat count as active.
 *
 * A message cannot exist without its conversation row (foreign key), so "a chat with messages but no metadata"
 * is covered by the stub row the capture-side writer creates (no name, individual chat, address = id).
 *
 * It never logs, and never touches the network.
 */
export class SqliteDigestSource implements DigestSource {
  constructor(private readonly db: Database) {}

  async conversationsWithMessages(window: SummaryWindow): Promise<readonly Conversation[]> {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.is_group, c.name, c.participant_id, c.address
         FROM (SELECT conversation_id, MIN(timestamp) AS first_ts
               FROM messages WHERE timestamp >= ? AND timestamp < ? AND kind <> 'other'
               GROUP BY conversation_id) AS w
         JOIN conversations c ON c.id = w.conversation_id
         ORDER BY w.first_ts, c.id`,
      )
      .all(window.since, window.until) as unknown as ConversationRow[]
    return rows.map(toConversation)
  }

  async messagesInWindow(conversationId: string, window: SummaryWindow): Promise<readonly Message[]> {
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
         WHERE conversation_id = ? AND timestamp >= ? AND timestamp < ? AND kind <> 'other'
         ORDER BY timestamp, seq`,
      )
      .all(conversationId, window.since, window.until) as unknown as MessageRow[]
    return rows.map(toMessage)
  }

  async participants(ids: readonly string[]): Promise<ReadonlyMap<string, Participant>> {
    const found = new Map<string, Participant>()
    const statement = this.db.prepare('SELECT id, saved_name, public_name FROM participants WHERE id = ?')
    for (const id of new Set(ids)) {
      const row = statement.get(id) as { id: string; saved_name: string | null; public_name: string | null } | undefined
      if (row !== undefined) found.set(id, { id: row.id, savedName: row.saved_name, publicName: row.public_name })
    }
    return found
  }

  async unreadState(conversationId: string): Promise<UnreadState> {
    const row = this.db
      .prepare('SELECT unread_kind, unread_count FROM conversations WHERE id = ?')
      .get(conversationId) as { unread_kind: string; unread_count: number | null } | undefined
    if (row === undefined) return { kind: 'unknown' }
    if (row.unread_kind === 'markedUnread') return { kind: 'markedUnread' }
    if (row.unread_kind === 'count' && row.unread_count !== null) return { kind: 'count', count: row.unread_count }
    return { kind: 'unknown' }
  }

  async lastIncoming(conversationId: string, limit: number): Promise<readonly IncomingMessage[]> {
    const rows = this.db
      .prepare(
        `SELECT id, read FROM messages WHERE conversation_id = ? AND from_me = 0
         ORDER BY timestamp DESC, seq DESC LIMIT ?`,
      )
      .all(conversationId, Math.max(0, limit)) as unknown as { id: string; read: number }[]
    return rows.map((row) => ({ id: row.id, read: row.read !== 0 }))
  }

  async messagesBefore(conversationId: string, timestamp: number, limit: number): Promise<readonly Message[]> {
    // The nearest `limit` messages before the timestamp, handed over oldest first.
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ? AND timestamp < ? AND kind <> 'other'
         ORDER BY timestamp DESC, seq DESC LIMIT ?`,
      )
      .all(conversationId, timestamp, Math.max(0, limit)) as unknown as MessageRow[]
    return rows.reverse().map(toMessage)
  }

  async lastOwn(conversationId: string, limit: number): Promise<readonly Message[]> {
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ? AND from_me = 1 AND kind <> 'other'
         ORDER BY timestamp DESC, seq DESC LIMIT ?`,
      )
      .all(conversationId, Math.max(0, limit)) as unknown as MessageRow[]
    return rows.map(toMessage)
  }

  /**
   * Lazy and re-iterable: every iteration runs its own query, reading rows as the caller goes. Consume it fully before
   * awaiting anything else, so no read stays open while other work writes.
   */
  async ownMessageTexts(): Promise<Iterable<OwnMessageText>> {
    const db = this.db
    return {
      *[Symbol.iterator](): Iterator<OwnMessageText> {
        // A statement per iteration: two iterations at once must not share one.
        const statement = db.prepare('SELECT conversation_id, text FROM messages WHERE from_me = 1')
        for (const row of statement.iterate() as IterableIterator<{ conversation_id: string; text: string | null }>) {
          yield { conversationId: row.conversation_id, text: row.text }
        }
      },
    }
  }
}
