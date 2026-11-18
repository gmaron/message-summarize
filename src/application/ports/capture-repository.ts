import type { Conversation, Message, Participant, UnreadState } from '../../domain/model.js'

/** What the caller knows about a chat the repository has no row for yet (only the adapter knows its id format). */
export interface ConversationHint {
  readonly isGroup?: boolean
}

/**
 * What happened to an edit (RF-11).
 * - applied: the original was stored, the editor is its author and the edit is newer than the one already applied.
 * - inserted: the original is not stored (it has not arrived, or never will). The edited message is stored as the
 *   message itself, marked as edited, with its author. If the original arrives later from the SAME author, the
 *   edited text stays; from a different author the original wins entirely (see `recordEdit`).
 * - ignored: the original is stored and either the editor is not its author (nothing changes) or the edit is not
 *   newer than the one already applied.
 */
export type EditOutcome = 'applied' | 'inserted' | 'ignored'

/**
 * What a NEW message does to the unread state of its conversation, in the same transaction as the insert (RNF-08).
 * - none: nothing (history, or an own mass message).
 * - increment: one more unread incoming message.
 * - markRead: the owner answered: every incoming message becomes read and the counter goes to 0.
 * A message that already existed never has an effect, so replays do not count twice.
 */
export type UnreadEffect = 'none' | 'increment' | 'markRead'

export interface InsertResult {
  /** True when the message was not stored before. */
  readonly isNew: boolean
  /** True when the stored message has a transcript after the insert (RF-15: no need to download its audio again). */
  readonly hasTranscript: boolean
}

/**
 * Write side of the capture (RF-10..RF-15), plus the few reads capture needs. Platform-neutral: the adapter of a
 * platform translates its events into calls to the capture use cases, which call this port.
 *
 * Identity: after the adapter normalizes ids (LID to number, for instance), the id of a participant is the id of
 * their individual conversation. The capture relies on it to find the name of an individual chat.
 *
 * Order: the adapter should process a history sync as contacts, then chats, then messages, so the names are known
 * when the messages arrive. Whatever the order, the first message of an individual chat before any name is known can
 * only be excluded (RF-14) by id, or by the sender or conversation name that the event carries.
 *
 * Every write is idempotent, because platforms replay history and events:
 * - Names arrive from the adapter and are cleaned here (masked names are null). A null name never erases a known one.
 * - A message that already exists is updated in place and keeps its position among equal timestamps. Its text and
 *   transcript only change when the new value is not null, a replay never undoes an edit, and `read` only goes from
 *   unread to read.
 * - Any write that needs a conversation creates a stub row when there is none (no name, address = id). The `hint`
 *   says whether it is a group; a hint never changes an existing conversation.
 * - Content captured before the name of its chat is known stays stored (the repository cannot know a name that has
 *   not arrived). RF-14 is enforced again at digest time with the final name, so such content never reaches a
 *   summarizer once the chat turns out to be excluded; it is simply not deleted from the database.
 * - The unread state is stamped with the time it was set: live updates win over the initial snapshot (RF-12). The
 *   stamp of live writes comes from the repository's own clock.
 */
export interface CaptureRepository {
  /** Reads. Names come back cleaned. Null when there is no row. */
  findConversation(id: string): Promise<Conversation | null>
  findParticipant(id: string): Promise<Participant | null>

  /**
   * How many conversations other than `conversationId` hold an own message with exactly this text (no trimming, no
   * case folding). Input of `isMassAtReceipt` (RF-33).
   */
  countOtherConversationsWithOwnText(conversationId: string, text: string): Promise<number>

  /** Creates or updates the conversation. Never touches its unread state. */
  upsertConversation(conversation: Conversation): Promise<void>
  upsertParticipant(participant: Participant): Promise<void>

  /**
   * Stores a message, or updates the existing one. When it is new, applies `effectIfNew` to the unread state of its
   * conversation atomically with the insert (default none).
   */
  insertMessage(message: Message, hint?: ConversationHint, effectIfNew?: UnreadEffect): Promise<InsertResult>

  /**
   * RF-11: `message` is the edited message under the id of the original, with the edited text. It replaces the text
   * of the original, or is stored as the message when the original is missing. See `EditOutcome`. A null text never
   * erases the text already stored.
   * An edit never touches the unread state, even when it is stored as the message ('inserted').
   *
   * Authorship: only the author of a message can edit it. An edit is applied only when `message.senderId` and
   * `message.fromMe` equal those of the stored original (the adapter normalizes ids before, so they compare as
   * stored; an own message has fromMe true and a null senderId on both sides). Otherwise it is 'ignored' and nothing
   * changes: in a group any member could otherwise rewrite another member's message, or the owner's, as the digest
   * sees it. A message stored by an edit ('inserted') is provisional: if the original later arrives with a different
   * author, the original replaces it entirely (author, timestamp, kind, text; the edit mark is cleared).
   * `editedAt` is a claim of the sender: the use case clamps it to the receive time before calling.
   */
  recordEdit(message: Message, editedAt: number, hint?: ConversationHint): Promise<EditOutcome>

  /** Returns false when the message is unknown. */
  setTranscript(conversationId: string, messageId: string, transcript: string): Promise<boolean>

  /**
   * Read on another device: marks the incoming messages with these ids as read, and every earlier incoming message of
   * the same conversation (reading a message means having read the ones before). Own messages and unknown ids are
   * not touched.
   */
  markReadThrough(conversationId: string, messageIds: readonly string[]): Promise<void>

  /** Marks every incoming message of the conversation as read. */
  markAllIncomingRead(conversationId: string): Promise<void>

  /** A live update of the unread state, stamped with the current time. */
  setUnread(conversationId: string, state: UnreadState, hint?: ConversationHint): Promise<void>

  /**
   * The initial snapshot: it writes only when the stored state has no stamp or one older than `snapshotStartedAt`,
   * and stamps with `snapshotStartedAt`.
   */
  setUnreadFromSnapshot(
    conversationId: string,
    state: UnreadState,
    snapshotStartedAt: number,
    hint?: ConversationHint,
  ): Promise<void>
}
