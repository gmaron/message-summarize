import type { Conversation, Participant, UnreadState } from '../../../domain/model.js'
import { resolveConversationName } from '../../../domain/names.js'
import type { Database } from './database.js'
import { inTransaction } from './transaction.js'

/** One conversation as the directory lists it. */
export interface DirectoryEntry {
  readonly id: string
  readonly isGroup: boolean
  /** As the digest names it (saved name, public name or address, RF-13). */
  readonly name: string
  readonly address: string
  /** Epoch ms of the newest message, or null when it has none. */
  readonly lastMessageAt: number | null
  readonly messages: number
  readonly unread: UnreadState
}

export interface DirectoryQuery {
  /** Text to look for (case-insensitive) in the name and in the address. Blank means no filter. */
  readonly q?: string
  /** Default 50, at most 200. */
  readonly limit?: number
  readonly offset?: number
}

export interface DirectoryPage {
  /** How many conversations match, whatever `limit` and `offset` are. */
  readonly total: number
  readonly items: readonly DirectoryEntry[]
}

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

/**
 * Case folding done by SQLite is ASCII-only ("ÁLVARO" would not match "álvaro"); the same JavaScript function folds the
 * stored text and the query, so both agree.
 */
const FOLD = 'msum_fold'
const fold = (text: unknown): string => (typeof text === 'string' ? text.toLowerCase() : '')

/** Escapes `%`, `_` and the escape character itself: the text is searched for literally, never as a pattern. */
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`)

const toInt = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.trunc(value)

interface Row {
  id: string
  is_group: number
  name: string | null
  participant_id: string | null
  address: string
  unread_kind: string
  unread_count: number | null
  saved_name: string | null
  public_name: string | null
  last_at: number | null
}

/**
 * The conversations of an account for a person to browse (RF-72): listed and searched, newest message first. Read only,
 * and used by `main/` only (like `SqliteScheduleRepository`: no use case needs it, so there is no port).
 *
 * Cost (RNF-11): the page is found over the conversations table alone (its size is the number of chats, not of messages).
 * The newest message of each chat is a lookup in `messages_by_conversation_time`, and the message count, which has to
 * walk that same index for the chat, is computed ONLY for the rows of the page. Nothing scans the messages table.
 *
 * It never logs: what it returns is private chat metadata.
 */
export class SqliteConversationDirectory {
  constructor(
    private readonly db: Database,
    private readonly labels: { readonly unnamedGroup: string },
  ) {
    db.function(FOLD, { deterministic: true, directOnly: false }, fold)
  }

  list(query: DirectoryQuery = {}): DirectoryPage {
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, toInt(query.limit, DEFAULT_PAGE_SIZE)))
    const offset = Math.max(0, toInt(query.offset, 0))
    const text = (query.q ?? '').trim()
    const where =
      text === ''
        ? ''
        : `WHERE ${[`${FOLD}(c.name)`, `${FOLD}(c.address)`, `${FOLD}(p.saved_name)`, `${FOLD}(p.public_name)`]
            .map((column) => `${column} LIKE ? ESCAPE '\\'`)
            .join(' OR ')}`
    const args = text === '' ? [] : Array<string>(4).fill(`%${escapeLike(fold(text))}%`)
    const from = 'FROM conversations c LEFT JOIN participants p ON p.id = c.participant_id'
    const total = (this.db.prepare(`SELECT COUNT(*) AS n ${from} ${where}`).get(...args) as { n: number }).n
    const rows = this.db
      .prepare(
        `SELECT c.id, c.is_group, c.name, c.participant_id, c.address, c.unread_kind, c.unread_count,
                p.saved_name, p.public_name,
                (SELECT MAX(m.timestamp) FROM messages m WHERE m.conversation_id = c.id) AS last_at
         ${from} ${where}
         ORDER BY last_at IS NULL, last_at DESC, c.id
         LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as unknown as Row[]
    return { total: Number(total), items: rows.map((row) => this.toEntry(row)) }
  }

  /** One conversation by its exact id, or null when this account does not have it. */
  find(id: string): DirectoryEntry | null {
    const row = this.db
      .prepare(
        `SELECT c.id, c.is_group, c.name, c.participant_id, c.address, c.unread_kind, c.unread_count,
                p.saved_name, p.public_name,
                (SELECT MAX(m.timestamp) FROM messages m WHERE m.conversation_id = c.id) AS last_at
         FROM conversations c LEFT JOIN participants p ON p.id = c.participant_id
         WHERE c.id = ?`,
      )
      .get(id) as unknown as Row | undefined
    return row === undefined ? null : this.toEntry(row)
  }

  /** Which of these ids this account has stored as a conversation (exact ids). */
  existing(ids: readonly string[]): Set<string> {
    const statement = this.db.prepare('SELECT 1 AS found FROM conversations WHERE id = ?')
    return new Set(ids.filter((id) => statement.get(id) !== undefined))
  }

  private toEntry(row: Row): DirectoryEntry {
    const conversation: Conversation = {
      id: row.id,
      isGroup: row.is_group !== 0,
      name: row.name,
      participantId: row.participant_id,
      address: row.address,
    }
    const participant: Participant | null =
      row.participant_id === null
        ? null
        : { id: row.participant_id, savedName: row.saved_name, publicName: row.public_name }
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(row.id) as {
      n: number
    }
    return {
      id: row.id,
      isGroup: conversation.isGroup,
      name: resolveConversationName(conversation, participant, this.labels).name,
      address: row.address,
      lastMessageAt: row.last_at === null ? null : Number(row.last_at),
      messages: Number(count.n),
      unread:
        row.unread_kind === 'markedUnread'
          ? { kind: 'markedUnread' }
          : row.unread_kind === 'count' && row.unread_count !== null
            ? { kind: 'count', count: row.unread_count }
            : { kind: 'unknown' },
    }
  }
}

/**
 * Removes what was stored of a conversation (RF-14: an excluded chat is not kept). Its messages and its row go in ONE
 * transaction. Participants stay (other chats share them); the pointer, the digests and the outbox are not touched.
 */
export class SqliteConversationPurge {
  constructor(private readonly db: Database) {}

  /** How many messages are stored for the conversation. */
  messageCount(id: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(id) as {
      n: number
    }
    return Number(row.n)
  }

  /** Deletes the messages and the row of the conversation. Returns how many messages went. */
  purge(id: string): number {
    return inTransaction(this.db, () => {
      // Reactions and poll votes belong to the conversation (the details of a message go with it, by cascade).
      this.db.prepare('DELETE FROM reactions WHERE conversation_id = ?').run(id)
      this.db.prepare('DELETE FROM poll_votes WHERE conversation_id = ?').run(id)
      const messages = this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
      return Number(messages.changes)
    })
  }
}
