import type {
  ConversationHint,
  EditOutcome,
  InsertResult,
  UnreadEffect,
} from '../../../application/ports/capture-repository.js'
import type { Conversation, Message, Participant, UnreadState } from '../../../domain/model.js'
import { MESSAGE_KINDS } from '../../../domain/model.js'
import { unmaskedName } from '../../../domain/names.js'
import type { Database } from './database.js'
import { inTransaction } from './transaction.js'

/**
 * SQL condition inside the upsert of a message: the stored row is a provisional message created by an edit
 * (edited_at set) and the incoming message has a different author. The real original wins entirely over it.
 * `IS NOT` compares NULL senders (own messages) correctly.
 */
const FORGED =
  '(messages.edited_at IS NOT NULL AND (messages.sender_id IS NOT excluded.sender_id OR messages.from_me != excluded.from_me))'

/**
 * CAPTURE-SIDE WRITER over SQLite, synchronous (node:sqlite is). `SqliteCaptureRepository` wraps it as the async
 * CaptureRepository port that the capture use cases use; the tests also use it directly to seed data.
 *
 * Semantics chosen for capture. All writes are idempotent, because the platform replays history and events:
 * - Names are cleaned here with `unmaskedName`, and a null name never erases a known one: a masked name ("+54∙∙15")
 *   can never overwrite a real one.
 * - A message that already exists is updated in place and keeps its `seq` (its place among equal timestamps).
 *   `text` and `transcript` only change when the new value is not null, and a replay never undoes an edit (RF-11).
 *   `read` only goes from unread to read. A message never moves to another conversation.
 * - An edit applies only when it is newer than the stored one, so out-of-order edits cannot go back, and only when
 *   its editor is the author of the original (same sender_id and from_me). A message stored by an edit is provisional:
 *   an original from a different author replaces it entirely.
 * - Any write that needs a conversation creates a stub row when there is none (no name, address = id), because a
 *   message cannot exist without its conversation (foreign key). The caller says through `hint` whether it is a
 *   group: a stub group has no participant, a stub individual chat has itself as participant.
 * - The unread state is stamped with the time it was set (RF-12): live updates win over the initial snapshot.
 *
 * It never logs and never sees the network.
 */
export class SqliteCaptureWriter {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  upsertConversation(conversation: Conversation): void {
    this.db
      .prepare(
        `INSERT INTO conversations (id, is_group, name, participant_id, address) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           is_group = excluded.is_group,
           name = COALESCE(excluded.name, conversations.name),
           participant_id = excluded.participant_id,
           address = excluded.address`,
      )
      .run(
        conversation.id,
        conversation.isGroup ? 1 : 0,
        unmaskedName(conversation.name),
        conversation.participantId,
        conversation.address,
      )
  }

  upsertParticipant(participant: Participant): void {
    this.db
      .prepare(
        `INSERT INTO participants (id, saved_name, public_name) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           saved_name = COALESCE(excluded.saved_name, participants.saved_name),
           public_name = COALESCE(excluded.public_name, participants.public_name)`,
      )
      .run(participant.id, unmaskedName(participant.savedName), unmaskedName(participant.publicName))
  }

  /**
   * Inserts a message, or updates the existing one with the same (conversation, id). When the message is new, the
   * unread effect is applied in the same transaction, so a crash cannot leave a counted message uncounted or the
   * reverse (RNF-08). A replay never has an effect.
   *
   * A message stored by `recordEdit` (its original never arrived, or arrives later) keeps the edited text and takes
   * the earliest of the two timestamps: the original is older than its edit.
   */
  insertMessage(message: Message, hint: ConversationHint = {}, effectIfNew: UnreadEffect = 'none'): InsertResult {
    return inTransaction(this.db, () => {
      const isNew = this.upsertMessageRow(message, hint, null)
      if (isNew) this.applyEffect(message.conversationId, effectIfNew, hint)
      const row = this.db
        .prepare('SELECT transcript IS NOT NULL AS has FROM messages WHERE conversation_id = ? AND id = ?')
        .get(message.conversationId, message.id) as { has: number }
      return { isNew, hasTranscript: row.has === 1 }
    })
  }

  private applyEffect(conversationId: string, effect: UnreadEffect, hint: ConversationHint): void {
    if (effect === 'increment') this.incrementUnread(conversationId, hint)
    else if (effect === 'markRead') {
      this.markAllIncomingRead(conversationId)
      this.setUnread(conversationId, { kind: 'count', count: 0 }, hint)
    }
  }

  /** Writes the row and returns true when it is new. `editedAt` is set for a message that is stored by an edit. */
  private upsertMessageRow(message: Message, hint: ConversationHint, editedAt: number | null): boolean {
    if (!(MESSAGE_KINDS as readonly string[]).includes(message.kind)) {
      throw new Error(`Unknown message kind: ${String(message.kind)}`)
    }
    this.ensureConversation(message.conversationId, hint)
    const isNew =
      this.db
        .prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND id = ?')
        .get(message.conversationId, message.id) === undefined
    this.db
      .prepare(
        `INSERT INTO messages
           (conversation_id, id, sender_id, sender_name, sender_address, from_me, timestamp, kind, text, transcript, read, edited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id, id) DO UPDATE SET
           sender_id = CASE WHEN ${FORGED} THEN excluded.sender_id ELSE messages.sender_id END,
           sender_address = CASE WHEN ${FORGED} THEN excluded.sender_address ELSE messages.sender_address END,
           from_me = CASE WHEN ${FORGED} THEN excluded.from_me ELSE messages.from_me END,
           kind = CASE WHEN ${FORGED} THEN excluded.kind ELSE messages.kind END,
           sender_name = CASE WHEN ${FORGED} THEN excluded.sender_name
                              ELSE COALESCE(excluded.sender_name, messages.sender_name) END,
           timestamp = CASE WHEN ${FORGED} THEN excluded.timestamp
                            WHEN messages.edited_at IS NOT NULL THEN MIN(messages.timestamp, excluded.timestamp)
                            ELSE messages.timestamp END,
           text = CASE WHEN ${FORGED} THEN excluded.text
                       WHEN messages.edited_at IS NOT NULL THEN messages.text
                       ELSE COALESCE(excluded.text, messages.text) END,
           edited_at = CASE WHEN ${FORGED} THEN NULL ELSE messages.edited_at END,
           transcript = COALESCE(excluded.transcript, messages.transcript),
           read = MAX(messages.read, excluded.read)`,
      )
      .run(
        message.conversationId,
        message.id,
        message.senderId,
        unmaskedName(message.senderName),
        message.senderAddress,
        message.fromMe ? 1 : 0,
        message.timestamp,
        message.kind,
        message.text,
        message.transcript,
        message.read ? 1 : 0,
        editedAt,
      )
    return isNew
  }

  /**
   * RF-11: an edit replaces the text of the original and records when. Returns false for an unknown message or an
   * edit that is not newer than the one already applied.
   */
  editMessage(conversationId: string, id: string, text: string | null, editedAt: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE messages SET text = COALESCE(?, text), edited_at = ?
         WHERE conversation_id = ? AND id = ? AND (edited_at IS NULL OR edited_at < ?)`,
      )
      .run(text, editedAt, conversationId, id, editedAt)
    return Number(result.changes) === 1
  }

  /**
   * RF-11 for a platform that may deliver an edit before its original (or never): `message` is the edited message
   * under the id of the original. If the original is stored the edit replaces its text (when newer than the edit
   * already applied); otherwise the edited message is stored as the message itself, marked as edited. An edit never
   * touches the unread state. An edit with a null text never erases the text already stored.
   */
  recordEdit(message: Message, editedAt: number, hint: ConversationHint = {}): EditOutcome {
    return inTransaction(this.db, () => {
      const stored = this.db
        .prepare('SELECT sender_id, from_me FROM messages WHERE conversation_id = ? AND id = ?')
        .get(message.conversationId, message.id) as { sender_id: string | null; from_me: number } | undefined
      if (stored === undefined) {
        this.upsertMessageRow(message, hint, editedAt)
        return 'inserted'
      }
      // Only the author edits a message: same sender and same side (own messages: from_me on both, no sender).
      if (stored.sender_id !== message.senderId || (stored.from_me === 1) !== message.fromMe) return 'ignored'
      return this.editMessage(message.conversationId, message.id, message.text, editedAt) ? 'applied' : 'ignored'
    })
  }

  setTranscript(conversationId: string, id: string, transcript: string): boolean {
    const result = this.db
      .prepare('UPDATE messages SET transcript = ? WHERE conversation_id = ? AND id = ?')
      .run(transcript, conversationId, id)
    return Number(result.changes) === 1
  }

  /** Marks incoming messages as read (read on another device). Unknown ids are ignored. */
  markRead(conversationId: string, ids: readonly string[]): void {
    const statement = this.db.prepare('UPDATE messages SET read = 1 WHERE conversation_id = ? AND id = ?')
    inTransaction(this.db, () => {
      for (const id of ids) statement.run(conversationId, id)
    })
  }

  /**
   * Read on another device: the incoming messages with these ids and every earlier incoming message of the same
   * conversation. Own messages and unknown ids are not touched.
   */
  markReadThrough(conversationId: string, ids: readonly string[]): void {
    const statement = this.db.prepare(
      `UPDATE messages SET read = 1
       WHERE conversation_id = ? AND from_me = 0 AND timestamp <=
         (SELECT timestamp FROM messages WHERE conversation_id = ? AND id = ? AND from_me = 0)`,
    )
    inTransaction(this.db, () => {
      for (const id of ids) statement.run(conversationId, conversationId, id)
    })
  }

  markAllIncomingRead(conversationId: string): void {
    this.db.prepare('UPDATE messages SET read = 1 WHERE conversation_id = ? AND from_me = 0').run(conversationId)
  }

  /** One more unread incoming message: from unknown or markedUnread the count becomes 1. Stamped with now. */
  incrementUnread(conversationId: string, hint: ConversationHint = {}): void {
    inTransaction(this.db, () => {
      this.ensureConversation(conversationId, hint)
      this.db
        .prepare(
          `UPDATE conversations SET
             unread_count = CASE WHEN unread_kind = 'count' THEN unread_count ELSE 0 END + 1,
             unread_kind = 'count',
             unread_updated_at = ?
           WHERE id = ?`,
        )
        .run(this.now(), conversationId)
    })
  }

  findConversation(id: string): Conversation | null {
    const row = this.db
      .prepare('SELECT id, is_group, name, participant_id, address FROM conversations WHERE id = ?')
      .get(id) as
      | { id: string; is_group: number; name: string | null; participant_id: string | null; address: string }
      | undefined
    if (row === undefined) return null
    return {
      id: row.id,
      isGroup: row.is_group !== 0,
      name: row.name,
      participantId: row.participant_id,
      address: row.address,
    }
  }

  findParticipant(id: string): Participant | null {
    const row = this.db.prepare('SELECT id, saved_name, public_name FROM participants WHERE id = ?').get(id) as
      | { id: string; saved_name: string | null; public_name: string | null }
      | undefined
    return row === undefined ? null : { id: row.id, savedName: row.saved_name, publicName: row.public_name }
  }

  countOtherConversationsWithOwnText(conversationId: string, text: string): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(DISTINCT conversation_id) AS n FROM messages WHERE from_me = 1 AND text = ? AND conversation_id != ?',
      )
      .get(text, conversationId) as { n: number }
    return row.n
  }

  /** A live update (RF-12): sets the unread state and stamps it with the current time. */
  setUnread(conversationId: string, state: UnreadState, hint: ConversationHint = {}): void {
    this.writeUnread(conversationId, state, this.now(), hint, false)
  }

  /**
   * The initial snapshot (RF-12). It arrives in batches, long after `snapshotStartedAt`, and must not overwrite what
   * live events set since: it writes only when the stored state has no stamp or a stamp older than the snapshot's
   * start, and it stamps with `snapshotStartedAt`. A snapshot of a later reconnect therefore replaces a state left by
   * a previous session.
   */
  setUnreadFromSnapshot(
    conversationId: string,
    state: UnreadState,
    snapshotStartedAt: number,
    hint: ConversationHint = {},
  ): void {
    this.writeUnread(conversationId, state, snapshotStartedAt, hint, true)
  }

  private writeUnread(
    conversationId: string,
    state: UnreadState,
    stamp: number,
    hint: ConversationHint,
    onlyIfOlder: boolean,
  ): void {
    inTransaction(this.db, () => {
      this.ensureConversation(conversationId, hint)
      this.db
        .prepare(
          `UPDATE conversations SET unread_kind = ?, unread_count = ?, unread_updated_at = ?
           WHERE id = ? ${onlyIfOlder ? 'AND (unread_updated_at IS NULL OR unread_updated_at < ?)' : ''}`,
        )
        .run(
          ...([state.kind, state.kind === 'count' ? state.count : null, stamp, conversationId] as const),
          ...(onlyIfOlder ? [stamp] : []),
        )
    })
  }

  private ensureConversation(id: string, hint: ConversationHint): void {
    const isGroup = hint.isGroup === true
    this.db
      .prepare(
        `INSERT INTO conversations (id, is_group, name, participant_id, address) VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(id, isGroup ? 1 : 0, isGroup ? null : id, id)
  }
}
