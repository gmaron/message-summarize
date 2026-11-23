import type {
  ConversationHint,
  DownloadDescriptor,
  EditOutcome,
  InsertResult,
  UnreadEffect,
} from '../../../application/ports/capture-repository.js'
import type {
  Conversation,
  Message,
  MessageExtras,
  Participant,
  PollVote,
  Reaction,
  UnreadState,
} from '../../../domain/model.js'
import { MESSAGE_KINDS, QUOTED_TEXT_MAX } from '../../../domain/model.js'
import { unmaskedName } from '../../../domain/names.js'
import type { Database } from './database.js'
import { inTransaction } from './transaction.js'

/**
 * Clears the download descriptor of a row: the decryption key of the file is not kept a moment longer than the download
 * needs it (it is cleared when the file is stored or the download failed for good).
 */
export const CLEAR_DESCRIPTOR =
  'dl_direct_path = NULL, dl_media_key = NULL, dl_mimetype = NULL, dl_file_length = NULL, dl_attempts = 0, dl_next_attempt_at = NULL, ' +
  'dl_remote_jid = NULL, dl_from_me = NULL, dl_participant = NULL, dl_reupload_attempts = 0, dl_needs_reupload = 0'

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
  insertMessage(
    message: Message,
    hint: ConversationHint = {},
    effectIfNew: UnreadEffect = 'none',
    extras?: MessageExtras,
  ): InsertResult {
    return inTransaction(this.db, () => {
      const isNew = this.upsertMessageRow(message, hint, null, extras)
      if (isNew) this.applyEffect(message.conversationId, effectIfNew, hint)
      const row = this.db
        .prepare(
          `SELECT seq, transcript IS NOT NULL AS has, transcribe_status IS NOT NULL AS handled
           FROM messages WHERE conversation_id = ? AND id = ?`,
        )
        .get(message.conversationId, message.id) as { seq: number; has: number; handled: number }
      if (extras !== undefined) this.writeDetails(Number(row.seq), extras)
      return { isNew, hasTranscript: row.has === 1, mediaHandled: row.handled === 1 }
    })
  }

  /**
   * The typed details of a message (media, location, contacts, poll, order, product), replaced as a whole: a replay of
   * the same message rewrites the same rows. Only called when the message came with extras.
   */
  private writeDetails(seq: number, extras: MessageExtras): void {
    for (const table of ['media', 'locations', 'shared_contacts', 'polls', 'orders', 'products']) {
      this.db.prepare(`DELETE FROM ${table} WHERE message_seq = ?`).run(seq)
    }
    const { media, location, poll, order, product } = extras
    if (media != null) {
      this.db
        .prepare(
          `INSERT INTO media (message_seq, kind, mimetype, seconds, file_length, file_name, page_count, width, height, caption)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          seq,
          media.kind,
          media.mimetype,
          media.seconds,
          media.fileLength,
          media.fileName,
          media.pageCount,
          media.width,
          media.height,
          media.caption,
        )
    }
    if (location != null) {
      this.db
        .prepare('INSERT INTO locations (message_seq, lat, lng, name, address, live) VALUES (?, ?, ?, ?, ?, ?)')
        .run(seq, location.lat, location.lng, location.name, location.address, location.live ? 1 : 0)
    }
    for (const contact of extras.contacts ?? []) {
      this.db
        .prepare('INSERT INTO shared_contacts (message_seq, display_name, phone, phones) VALUES (?, ?, ?, ?)')
        .run(seq, contact.displayName, contact.phones[0] ?? null, JSON.stringify(contact.phones))
    }
    if (poll != null) {
      this.db
        .prepare('INSERT INTO polls (message_seq, question, options, selectable_count) VALUES (?, ?, ?, ?)')
        .run(seq, poll.question, JSON.stringify(poll.options), poll.selectableCount)
    }
    if (order != null) {
      this.db
        .prepare(
          `INSERT INTO orders (message_seq, order_id, item_count, total_amount, currency, title, message)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(seq, order.orderId, order.itemCount, order.totalAmount, order.currency, order.title, order.message)
    }
    if (product != null) {
      this.db
        .prepare(
          'INSERT INTO products (message_seq, product_id, title, price, currency, retailer_id) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(seq, product.productId, product.title, product.price, product.currency, product.retailerId)
    }
  }

  /**
   * One reaction per (target message, sender): a newer one replaces it, an older one is ignored, an empty emoji removes
   * it. The target does not need to be stored (reactions to messages older than the history are kept anyway).
   */
  recordReaction(reaction: Reaction, hint: ConversationHint = {}): void {
    inTransaction(this.db, () => {
      this.ensureConversation(reaction.conversationId, hint)
      const sender = reaction.fromMe ? '' : (reaction.senderId ?? '')
      const key = [reaction.conversationId, reaction.targetId, reaction.fromMe ? 1 : 0, sender] as const
      const stored = this.db
        .prepare(
          'SELECT timestamp FROM reactions WHERE conversation_id = ? AND target_id = ? AND from_me = ? AND sender_id = ?',
        )
        .get(...key) as { timestamp: number } | undefined
      if (stored !== undefined && stored.timestamp > reaction.timestamp) return
      if (reaction.emoji === '') {
        this.db
          .prepare(
            'DELETE FROM reactions WHERE conversation_id = ? AND target_id = ? AND from_me = ? AND sender_id = ?',
          )
          .run(...key)
        return
      }
      this.db
        .prepare(
          `INSERT INTO reactions (conversation_id, target_id, from_me, sender_id, emoji, timestamp)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (conversation_id, target_id, from_me, sender_id) DO UPDATE SET
             emoji = excluded.emoji, timestamp = excluded.timestamp`,
        )
        .run(...key, reaction.emoji, reaction.timestamp)
    })
  }

  /** A vote on a poll, as received (see the TODO of the `poll_votes` table). A replay of the same vote adds nothing. */
  recordPollVote(vote: PollVote, hint: ConversationHint = {}): void {
    inTransaction(this.db, () => {
      this.ensureConversation(vote.conversationId, hint)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO poll_votes (conversation_id, poll_id, sender_id, from_me, timestamp, raw)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          vote.conversationId,
          vote.pollId,
          vote.fromMe ? '' : (vote.senderId ?? ''),
          vote.fromMe ? 1 : 0,
          vote.timestamp,
          vote.raw,
        )
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
  private upsertMessageRow(
    message: Message,
    hint: ConversationHint,
    editedAt: number | null,
    extras?: MessageExtras,
  ): boolean {
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
           (conversation_id, id, sender_id, sender_name, sender_address, from_me, timestamp, kind, text, transcript, read,
            edited_at, raw, quoted_id, quoted_kind, quoted_text, quoted_from_status, forwarded, is_view_once)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           read = MAX(messages.read, excluded.read),
           raw = CASE WHEN ${FORGED} THEN excluded.raw ELSE COALESCE(messages.raw, excluded.raw) END,
           quoted_id = CASE WHEN ${FORGED} THEN excluded.quoted_id ELSE COALESCE(messages.quoted_id, excluded.quoted_id) END,
           quoted_kind = CASE WHEN ${FORGED} THEN excluded.quoted_kind
                              ELSE COALESCE(messages.quoted_kind, excluded.quoted_kind) END,
           quoted_text = CASE WHEN ${FORGED} THEN excluded.quoted_text
                              ELSE COALESCE(messages.quoted_text, excluded.quoted_text) END,
           quoted_from_status = CASE WHEN ${FORGED} THEN excluded.quoted_from_status
                                     ELSE MAX(messages.quoted_from_status, excluded.quoted_from_status) END,
           forwarded = CASE WHEN ${FORGED} THEN excluded.forwarded ELSE MAX(messages.forwarded, excluded.forwarded) END,
           is_view_once = CASE WHEN ${FORGED} THEN excluded.is_view_once
                               ELSE MAX(messages.is_view_once, excluded.is_view_once) END`,
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
        extras?.raw ?? null,
        extras?.quoted?.id ?? null,
        extras?.quoted?.kind ?? null,
        extras?.quoted?.text == null ? null : extras.quoted.text.slice(0, QUOTED_TEXT_MAX),
        extras?.quoted?.fromStatus ? 1 : 0,
        extras?.forwarded ? 1 : 0,
        extras?.viewOnce ? 1 : 0,
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
    // A message that was waiting in the transcription queue leaves it (status 'done'); one that was not stays out.
    const result = this.db
      .prepare(
        `UPDATE messages SET transcript = ?,
           transcribe_status = CASE WHEN transcribe_status IS NULL THEN NULL ELSE 'done' END,
           transcribe_error = NULL
         WHERE conversation_id = ? AND id = ?`,
      )
      .run(transcript, conversationId, id)
    return Number(result.changes) === 1
  }

  /** The file of an audio was stored: it joins the queue, unless it has a transcript (then it is just recorded). */
  setMedia(conversationId: string, id: string, mediaRef: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE messages SET media_ref = ?,
           transcribe_status = CASE WHEN transcript IS NULL THEN 'pending' ELSE 'done' END,
           transcribe_error = NULL, ${CLEAR_DESCRIPTOR}
         WHERE conversation_id = ? AND id = ? AND kind = 'audio'`,
      )
      .run(mediaRef, conversationId, id)
    return Number(result.changes) === 1
  }

  /**
   * How to download the audio is stored with it and it joins the DURABLE download queue (RNF-08). Only a new request:
   * an audio with no transcript and no status yet. `mediaKey` is a secret and stays in this database only.
   */
  queueDownload(conversationId: string, id: string, descriptor: DownloadDescriptor): boolean {
    const result = this.db
      .prepare(
        `UPDATE messages SET transcribe_status = 'download_pending', transcribe_error = NULL, dl_attempts = 0,
           dl_reupload_attempts = 0, dl_needs_reupload = 0,
           dl_direct_path = ?, dl_media_key = ?, dl_mimetype = ?, dl_file_length = ?,
           dl_remote_jid = ?, dl_from_me = ?, dl_participant = ?
         WHERE conversation_id = ? AND id = ? AND kind = 'audio' AND transcript IS NULL AND transcribe_status IS NULL`,
      )
      .run(
        descriptor.directPath,
        descriptor.mediaKey,
        descriptor.mimetype,
        descriptor.fileLength,
        descriptor.reuploadKey?.remoteJid ?? null,
        descriptor.reuploadKey === undefined ? null : descriptor.reuploadKey.fromMe ? 1 : 0,
        descriptor.reuploadKey?.participant ?? null,
        conversationId,
        id,
      )
    return Number(result.changes) === 1
  }

  /** The download failed for good: recorded, descriptor cleared, not asked for again. A message with a transcript is left alone. */
  setMediaFailure(conversationId: string, id: string, reason: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE messages SET transcribe_status = 'failed', transcribe_error = ?, ${CLEAR_DESCRIPTOR}
         WHERE conversation_id = ? AND id = ? AND kind = 'audio' AND transcript IS NULL`,
      )
      .run(reason, conversationId, id)
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
