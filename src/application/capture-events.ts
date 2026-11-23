import type {
  Conversation,
  Message,
  MessageExtras,
  Participant,
  PollVote,
  Reaction,
  UnreadState,
} from '../domain/model.js'
import type { DownloadDescriptor } from './ports/capture-repository.js'

/**
 * Domain events of the capture (RF-10..RF-15). An adapter translates what its platform tells it into these and calls
 * the `CaptureMessages` use case. Platform concepts (LID, the phone's counter, read-self) stop in the adapter:
 * - ids and addresses come already translated, names already cleaned;
 * - the text of every message is the adapter's: it renders each kind in the account language (RF-10);
 * - `isGroup` is the hint of the adapter about a conversation the application may not know yet.
 *
 * Content events (a message, an edit, a read mark, an unread state, a transcript) are subject to exclusion (RF-14)
 * and to the own-chat filter. Metadata events (conversation, participant) are always stored: names are not content,
 * and exclusion by name needs them.
 */

/** Where a message came from: a live event, or the replay of history on link or reconnect. */
export type MessageOrigin = 'live' | 'history'

/** What the adapter knows about the author of a content event, besides the message itself. */
interface EventContext {
  readonly isGroup: boolean
  /**
   * The name of the conversation as the adapter knows it right now, cleaned. Optional: it lets exclusion by name
   * (RF-14) work for a chat whose name is not stored yet.
   */
  readonly conversationName?: string | null
  /**
   * The author of the message, with the public (push) name the event carries. Stored before the exclusion check, so
   * an individual chat can be excluded by the name of the contact on its very first message.
   */
  readonly sender?: Participant
}

export interface MessageReceived extends EventContext {
  readonly message: Message
  readonly origin: MessageOrigin
  /** What the adapter understood besides the text (reply, media, location, raw content...). Stored with the message. */
  readonly extras?: MessageExtras
}

/** An emoji reaction (not a message: it is stored apart and never shown in a digest). Subject to exclusion like content. */
export interface ReactionReceived extends EventContext {
  readonly reaction: Reaction
}

/** A vote on a poll, as received. Subject to exclusion like content. */
export interface PollVoteReceived extends EventContext {
  readonly vote: PollVote
}

/**
 * An edit. `message` is the edited message under the id of the ORIGINAL, complete (sender, timestamp, kind) so that
 * it can be stored when the original never arrives. Its `text` is rendered by the adapter and must include the
 * "edited" marker from the text catalogs (`capture.editedPrefix`, legacy "(editado) "), so the digest shows that the
 * message was edited.
 */
export interface MessageEdited extends EventContext {
  readonly message: Message
  /** Epoch ms of the edit. */
  readonly editedAt: number
}

/** Messages read from any device (a read receipt of the owner). */
export interface MessagesRead {
  readonly conversationId: string
  readonly isGroup: boolean
  readonly conversationName?: string | null
  readonly messageIds: readonly string[]
}

/** The unread state changed while connected (the owner read the chat, or marked it unread). */
export interface UnreadChanged {
  readonly conversationId: string
  readonly isGroup: boolean
  readonly conversationName?: string | null
  readonly state: UnreadState
}

/** The unread state as it was when the session started (initial sync). It arrives in batches, later. */
export interface UnreadSnapshot {
  readonly conversationId: string
  readonly isGroup: boolean
  readonly conversationName?: string | null
  readonly state: UnreadState
  /** Epoch ms when the snapshot started, not when this batch arrived. */
  readonly snapshotStartedAt: number
}

export interface ConversationMetadata {
  /** Name, isGroup and address as the platform knows them now. A null name does not erase a known one. */
  readonly conversation: Conversation
}

export interface ParticipantInfo {
  readonly participant: Participant
}

/**
 * RF-15: the adapter hands over how to download an audio the capture asked for (`ReceiveOutcome.downloadAudio`). The
 * capture stores it with the message, in the durable download queue; the adapter's download worker does the rest. The
 * descriptor holds the decryption key of the file: it is stored, never logged.
 */
export interface MediaQueued {
  readonly conversationId: string
  readonly isGroup: boolean
  readonly conversationName?: string | null
  readonly messageId: string
  readonly descriptor: DownloadDescriptor
}

/**
 * RF-15: an audio that can never be downloaded (an unsafe path, a format that is not audio...). `reason` is a fixed code
 * ("invalid-media-path", "unsupported-format"...), never a message. Recorded on the message.
 */
export interface MediaFailed {
  readonly conversationId: string
  readonly isGroup: boolean
  readonly conversationName?: string | null
  readonly messageId: string
  readonly reason: string
}

export interface TranscriptReady {
  readonly conversationId: string
  readonly isGroup: boolean
  readonly conversationName?: string | null
  readonly messageId: string
  readonly transcript: string
}

/** What `receiveMessage` tells the adapter. */
export interface ReceiveOutcome {
  /** False: the conversation is excluded (RF-14) or is the owner's own chat, and nothing was stored. */
  readonly stored: boolean
  /** True when the message was not there before. */
  readonly isNew: boolean
  /**
   * RF-15: the adapter should download this audio for transcription (if transcription is on): an audio that is
   * stored with no transcript yet (new, or replayed before it was transcribed), whose file was not stored before and
   * whose download did not fail before, and that arrived live or from history within the configured number of days.
   * The adapter answers with `queueMedia` (the descriptor, to download later) or `mediaFailed`.
   */
  readonly downloadAudio: boolean
}
