import type { OwnMessageText } from '../../domain/mass.js'
import type { Conversation, Message, Participant, UnreadState } from '../../domain/model.js'
import type { IncomingMessage } from '../../domain/unread.js'
import type { SummaryWindow } from '../../domain/window.js'

/**
 * Everything the GenerateDigest use case reads. Platform-neutral: the adapter translates its own concepts
 * (LID, unread counters) into these shapes. All methods are read only.
 */
export interface DigestSource {
  /**
   * Conversations that have at least one message inside the window, ordered by the timestamp of their first message
   * in the window, oldest first; conversations whose first message has the same timestamp go by id, ascending, so
   * the order is deterministic. The order matters: a repeated notice is kept in the first group (RF-34).
   * There is one Conversation for every such chat, even when the source has no metadata for it (a group with no
   * name comes with `name` null). Names arrive already cleaned: masked ones are null (`unmaskedName`).
   */
  conversationsWithMessages(window: SummaryWindow): Promise<readonly Conversation[]>

  /**
   * Messages of one conversation inside the window, oldest first. Messages with the same timestamp keep the order
   * in which the source stored them. The same rule applies to `lastIncoming` (reversed) and `messagesBefore`.
   */
  messagesInWindow(conversationId: string, window: SummaryWindow): Promise<readonly Message[]>

  /**
   * People for names, labels and the saved-contact check: the senders of messages and the `participantId` of
   * individual conversations. Ids that are unknown are absent from the map. Their names arrive already cleaned
   * (masked names are null).
   */
  participants(ids: readonly string[]): Promise<ReadonlyMap<string, Participant>>

  /** What the source says about unread messages of a conversation (RF-31). */
  unreadState(conversationId: string): Promise<UnreadState>

  /** The last `limit` incoming messages of the WHOLE conversation (not only the window), newest first. */
  lastIncoming(conversationId: string, limit: number): Promise<readonly IncomingMessage[]>

  /** Up to `limit` messages with a timestamp before `timestamp`, in the whole conversation, oldest first. */
  messagesBefore(conversationId: string, timestamp: number, limit: number): Promise<readonly Message[]>

  /** Every own message of the whole history, of any kind, for mass-message detection (RF-33). */
  ownMessageTexts(): Promise<Iterable<OwnMessageText>>
}
