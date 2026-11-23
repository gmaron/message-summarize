import { exactIdOf, isExcluded } from '../domain/exclusion.js'
import { isMassAtReceipt } from '../domain/mass.js'
import type { Conversation, Message, Participant } from '../domain/model.js'
import { resolveConversationName, unmaskedName } from '../domain/names.js'
import type {
  ConversationMetadata,
  MediaFailed,
  MediaQueued,
  MessageEdited,
  MessageOrigin,
  MessageReceived,
  MessagesRead,
  ParticipantInfo,
  PollVoteReceived,
  ReactionReceived,
  ReceiveOutcome,
  TranscriptReady,
  UnreadChanged,
  UnreadSnapshot,
} from './capture-events.js'
import type { CaptureRepository, EditOutcome, UnreadEffect } from './ports/capture-repository.js'
import type { Clock } from './ports/clock.js'

const DAY_MS = 86_400_000
export const DEFAULT_AUDIO_HISTORY_DAYS = 14
/** How far ahead of our own clock an edit time may be and still be believed (phone clocks drift). */
export const EDIT_CLOCK_SKEW_MS = 5 * 60_000

export interface CaptureMessagesDeps {
  readonly repository: CaptureRepository
  /**
   * Used for the audio history window. The composition root must share ONE clock between this use case and the
   * repository (the stamps of live unread writes), so the two never disagree about "now".
   */
  readonly clock: Clock
  /** The exclusion patterns (RF-14), read on every event so a change in settings applies at once. Empty: none. */
  readonly excludePatterns: () => readonly string[]
  /**
   * The ids of the owner's own chat(s) on this platform (the digest is delivered there): provided by the adapter,
   * read on every event. Content events of these conversations are dropped.
   */
  readonly ownConversationIds: () => readonly string[]
  /** RF-15: audios from history older than this many days are not downloaded. Default 14; 0 means no limit. */
  readonly audioHistoryDays?: number
}

export interface CaptureMessages {
  /** RF-10, RF-12, RF-14, RF-33. */
  receiveMessage(event: MessageReceived): Promise<ReceiveOutcome>
  /** RF-11. Returns null when the conversation is excluded or is the owner's own chat. */
  editMessage(event: MessageEdited): Promise<EditOutcome | null>
  messagesRead(event: MessagesRead): Promise<void>
  unreadChanged(event: UnreadChanged): Promise<void>
  unreadSnapshot(event: UnreadSnapshot): Promise<void>
  /** RF-13. Always stored: a name is not content, and exclusion by name needs it. */
  conversationMetadata(event: ConversationMetadata): Promise<void>
  /** RF-13. Always stored, for the same reason. */
  participantInfo(event: ParticipantInfo): Promise<void>
  transcriptReady(event: TranscriptReady): Promise<void>
  /** RF-15. The audio joins the durable download queue, with how to download it. */
  queueMedia(event: MediaQueued): Promise<void>
  /** RF-15. Recorded on the message; the audio shows as not transcribed. */
  mediaFailed(event: MediaFailed): Promise<void>
  /** A reaction to a message: stored in its own table, never a message. */
  receiveReaction(event: ReactionReceived): Promise<void>
  /** A vote on a poll, stored as received. */
  receivePollVote(event: PollVoteReceived): Promise<void>
}

/**
 * Capture use cases: what the app does with the events of a messaging account. Platform-neutral (RNF-14).
 *
 * Exclusion (RF-14) applies to content events and uses the same matcher as the digest, on "<id> <name>". The name is
 * resolved from what is stored plus what the event brings, with an empty label for an unnamed group (the label is
 * user-facing text and lives in the renderer, so a pattern that matches only that label excludes at digest time, not
 * at capture time). Metadata is always stored so the names are there for it.
 *
 * Unread semantics mirror the previous tool's listener: a NEW live incoming message adds one unread; a NEW live own
 * message marks the conversation as read (every incoming message read, counter 0) unless it is a mass message
 * (RF-33), which is sent without opening the chat. Either effect is applied by the repository atomically with the
 * insert. History replays and edits never touch the counter, not even an edit of a message that was never seen. A live counter of 0 means "read on the phone" (same
 * effect as an own message); markedUnread is stored; a live positive count is ignored, because the counter is kept
 * by `receiveMessage`.
 */
export function createCaptureMessages(deps: CaptureMessagesDeps): CaptureMessages {
  const { repository, clock } = deps
  const audioHistoryDays = deps.audioHistoryDays ?? DEFAULT_AUDIO_HISTORY_DAYS

  /** What the exclusion needs to know of a conversation besides its id: the stored chat and person (for the names). */
  interface Facts {
    readonly base: Conversation
    readonly person: Participant | null
  }

  /** Looks the facts up, or null when there are no patterns now (nothing to compare, so nothing to look up). */
  async function factsOf(id: string, isGroup: boolean): Promise<Facts | null> {
    if (deps.excludePatterns().length === 0) return null
    const stored = await repository.findConversation(id)
    const base: Conversation = stored ?? {
      id,
      isGroup,
      name: null,
      participantId: isGroup ? null : id,
      address: id,
    }
    const person = base.participantId === null ? null : await repository.findParticipant(base.participantId)
    return { base, person }
  }

  /**
   * Whether the conversation is excluded by the patterns in force RIGHT NOW. Synchronous on purpose: it is called
   * right before a write, with nothing awaited in between, so an exclusion applied while the event was being handled
   * (the web marks a chat and deletes what was stored) can never be followed by a write of that event.
   */
  function excludedNow(facts: Facts | null, id: string, eventName?: string | null): boolean {
    const patterns = deps.excludePatterns()
    if (patterns.length === 0) return false
    // Both names count: the one the event brings and the one already stored. Neither replaces the other, so a
    // pattern that matches either excludes the chat (a rename must not let an excluded chat through).
    const base = facts?.base ?? { id, isGroup: false, name: null, participantId: null, address: id }
    const names = new Set<string | null>([base.name, unmaskedName(eventName ?? null)])
    for (const candidate of names) {
      const { name } = resolveConversationName({ ...base, name: candidate }, facts?.person ?? null, {
        unnamedGroup: '',
      })
      if (isExcluded(patterns, id, name)) return true
    }
    return false
  }

  /** Should the content events of this conversation be dropped (owner's own chat, or excluded by RF-14)? */
  async function dropped(id: string, isGroup: boolean, eventName?: string | null): Promise<boolean> {
    if (deps.ownConversationIds().includes(id)) return true
    return excludedNow(await factsOf(id, isGroup), id, eventName)
  }

  /** What a message that was not stored before does to the unread state (RF-12, RF-33). */
  async function newMessageEffect(message: Message, origin: MessageOrigin): Promise<UnreadEffect> {
    if (origin !== 'live') return 'none'
    // A type the capture keeps only for its raw content (a pin, a call log, a bot's buttons) does not show as unread on
    // the phone, and an own one is not a sign that the owner read the chat.
    if (message.kind === 'other') return 'none'
    if (!message.fromMe) return 'increment'
    const mass =
      message.text !== null &&
      isMassAtReceipt(
        message.text,
        await repository.countOtherConversationsWithOwnText(message.conversationId, message.text),
      )
    return mass ? 'none' : 'markRead'
  }

  return {
    async receiveMessage({ message, isGroup, origin, conversationName, sender, extras }) {
      const id = message.conversationId
      if (deps.ownConversationIds().includes(id)) return { stored: false, isNew: false, downloadAudio: false }
      if (sender !== undefined) await repository.upsertParticipant(sender)
      const facts = await factsOf(id, isGroup)
      if (excludedNow(facts, id, conversationName)) return { stored: false, isNew: false, downloadAudio: false }

      const effect = await newMessageEffect(message, origin)
      // Again, with nothing awaited before the write: the chat may have been excluded (and what was stored deleted)
      // while the effect was computed.
      if (excludedNow(facts, id, conversationName) || deps.ownConversationIds().includes(id)) {
        return { stored: false, isNew: false, downloadAudio: false }
      }
      const { isNew, hasTranscript, mediaHandled } = await repository.insertMessage(
        message,
        { isGroup },
        effect,
        extras,
      )

      // `audioHistoryDays` 0 means no limit: every audio of the history is wanted.
      const recent =
        origin === 'live' || audioHistoryDays === 0 || message.timestamp >= clock.now() - audioHistoryDays * DAY_MS
      return {
        stored: true,
        isNew,
        downloadAudio: message.kind === 'audio' && !hasTranscript && !mediaHandled && recent,
      }
    },

    async editMessage({ message, editedAt, isGroup, conversationName, sender }) {
      if (deps.ownConversationIds().includes(message.conversationId)) return null
      if (sender !== undefined) await repository.upsertParticipant(sender)
      const facts = await factsOf(message.conversationId, isGroup)
      if (excludedNow(facts, message.conversationId, conversationName)) return null
      // An edit never touches the unread counters, even when it is the first sight of the message (as the previous
      // tool did): it is stored, but only a message that arrives as a message counts.
      // The edit time is the sender's claim: clamped to now plus a small skew so a forged future time cannot lock out
      // later legitimate edits (the repository ignores edits that are not newer). The timestamp of a message stored
      // by the edit is clamped too, so it cannot sit in the future.
      const limit = clock.now() + EDIT_CLOCK_SKEW_MS
      return repository.recordEdit(
        message.timestamp > limit ? { ...message, timestamp: limit } : message,
        Math.min(editedAt, limit),
        { isGroup },
      )
    },

    async messagesRead({ conversationId, isGroup, conversationName, messageIds }) {
      if (await dropped(conversationId, isGroup, conversationName)) return
      await repository.markReadThrough(conversationId, messageIds)
    },

    async unreadChanged({ conversationId, isGroup, conversationName, state }) {
      if (state.kind === 'unknown' || (state.kind === 'count' && state.count !== 0)) return
      if (await dropped(conversationId, isGroup, conversationName)) return
      if (state.kind === 'count') await repository.markAllIncomingRead(conversationId)
      await repository.setUnread(conversationId, state, { isGroup })
    },

    async unreadSnapshot({ conversationId, isGroup, conversationName, state, snapshotStartedAt }) {
      if (await dropped(conversationId, isGroup, conversationName)) return
      await repository.setUnreadFromSnapshot(conversationId, state, snapshotStartedAt, { isGroup })
    },

    async conversationMetadata({ conversation }) {
      // A chat excluded by its id needs nothing stored, not even its name (the name is for patterns that match names), so
      // its row does not come back after the web deleted it. With only name patterns the metadata stays: they need it.
      const byId = deps.excludePatterns().filter((pattern) => exactIdOf(pattern) !== null)
      if (isExcluded(byId, conversation.id, null)) return
      await repository.upsertConversation(conversation)
    },

    async participantInfo({ participant }) {
      await repository.upsertParticipant(participant)
    },

    async transcriptReady({ conversationId, isGroup, conversationName, messageId, transcript }) {
      if (await dropped(conversationId, isGroup, conversationName)) return
      await repository.setTranscript(conversationId, messageId, transcript)
    },

    async queueMedia({ conversationId, isGroup, conversationName, messageId, descriptor }) {
      if (await dropped(conversationId, isGroup, conversationName)) return
      await repository.queueDownload(conversationId, messageId, descriptor)
    },

    async receiveReaction({ reaction, isGroup, conversationName, sender }) {
      if (await dropped(reaction.conversationId, isGroup, conversationName)) return
      if (sender !== undefined) await repository.upsertParticipant(sender)
      await repository.recordReaction(reaction, { isGroup })
    },

    async receivePollVote({ vote, isGroup, conversationName, sender }) {
      if (await dropped(vote.conversationId, isGroup, conversationName)) return
      if (sender !== undefined) await repository.upsertParticipant(sender)
      await repository.recordPollVote(vote, { isGroup })
    },

    async mediaFailed({ conversationId, isGroup, conversationName, messageId, reason }) {
      if (await dropped(conversationId, isGroup, conversationName)) return
      await repository.setMediaFailure(conversationId, messageId, reason)
    },
  }
}
