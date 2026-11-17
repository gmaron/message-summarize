import type { Conversation, Message, Participant, UnreadState } from '../../../domain/model.js'
import { MESSAGE_KINDS } from '../../../domain/model.js'
import { unmaskedName } from '../../../domain/names.js'
import type { Database } from './database.js'
import { inTransaction } from './transaction.js'

/** What the caller knows about a chat the database has no row for yet (only the adapter knows its id format). */
export interface ConversationHint {
  readonly isGroup?: boolean
}

/**
 * CAPTURE-SIDE WRITER. Not a port: the application layer does not know it. The digest only reads (DigestSource) and
 * moves its pointer (DigestStore). This class is what the capture code (commit 8) and the tests use to put data in.
 * When capture gets its own port in `application/`, this becomes its adapter.
 *
 * Semantics chosen for capture. All writes are idempotent, because the platform replays history and events:
 * - Names are cleaned here with `unmaskedName`, and a null name never erases a known one: a masked name ("+54∙∙15")
 *   can never overwrite a real one.
 * - A message that already exists is updated in place and keeps its `seq` (its place among equal timestamps).
 *   `text` and `transcript` only change when the new value is not null, and a replay never undoes an edit (RF-11).
 *   `read` only goes from unread to read. A message never moves to another conversation.
 * - An edit applies only when it is newer than the stored one, so out-of-order edits cannot go back.
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

  /** Inserts a message, or updates the existing one with the same (conversation, id). */
  insertMessage(message: Message, hint: ConversationHint = {}): void {
    if (!(MESSAGE_KINDS as readonly string[]).includes(message.kind)) {
      throw new Error(`Unknown message kind: ${String(message.kind)}`)
    }
    inTransaction(this.db, () => {
      this.ensureConversation(message.conversationId, hint)
      this.db
        .prepare(
          `INSERT INTO messages
             (conversation_id, id, sender_id, sender_name, sender_address, from_me, timestamp, kind, text, transcript, read)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (conversation_id, id) DO UPDATE SET
             sender_name = COALESCE(excluded.sender_name, messages.sender_name),
             text = CASE WHEN messages.edited_at IS NOT NULL THEN messages.text
                         ELSE COALESCE(excluded.text, messages.text) END,
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
        )
    })
  }

  /**
   * RF-11: an edit replaces the text of the original and records when. Returns false for an unknown message or an
   * edit that is not newer than the one already applied.
   */
  editMessage(conversationId: string, id: string, text: string | null, editedAt: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE messages SET text = ?, edited_at = ?
         WHERE conversation_id = ? AND id = ? AND (edited_at IS NULL OR edited_at < ?)`,
      )
      .run(text, editedAt, conversationId, id, editedAt)
    return Number(result.changes) === 1
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
