import type {
  CaptureRepository,
  ConversationHint,
  EditOutcome,
  InsertResult,
  UnreadEffect,
} from '../../../application/ports/capture-repository.js'
import type { Conversation, Message, Participant, UnreadState } from '../../../domain/model.js'
import type { SqliteCaptureWriter } from './capture-writer.js'

/**
 * SQLite adapter of the CaptureRepository port. The writer is synchronous (node:sqlite), the port is async like the
 * other ports, so this class only wraps it; every semantic is documented in the port and implemented in the writer.
 */
export class SqliteCaptureRepository implements CaptureRepository {
  constructor(private readonly writer: SqliteCaptureWriter) {}

  async findConversation(id: string): Promise<Conversation | null> {
    return this.writer.findConversation(id)
  }
  async findParticipant(id: string): Promise<Participant | null> {
    return this.writer.findParticipant(id)
  }
  async countOtherConversationsWithOwnText(conversationId: string, text: string): Promise<number> {
    return this.writer.countOtherConversationsWithOwnText(conversationId, text)
  }
  async upsertConversation(conversation: Conversation): Promise<void> {
    this.writer.upsertConversation(conversation)
  }
  async upsertParticipant(participant: Participant): Promise<void> {
    this.writer.upsertParticipant(participant)
  }
  async insertMessage(message: Message, hint?: ConversationHint, effectIfNew?: UnreadEffect): Promise<InsertResult> {
    return this.writer.insertMessage(message, hint, effectIfNew)
  }
  async recordEdit(message: Message, editedAt: number, hint?: ConversationHint): Promise<EditOutcome> {
    return this.writer.recordEdit(message, editedAt, hint)
  }
  async setTranscript(conversationId: string, messageId: string, transcript: string): Promise<boolean> {
    return this.writer.setTranscript(conversationId, messageId, transcript)
  }
  async markReadThrough(conversationId: string, messageIds: readonly string[]): Promise<void> {
    this.writer.markReadThrough(conversationId, messageIds)
  }
  async markAllIncomingRead(conversationId: string): Promise<void> {
    this.writer.markAllIncomingRead(conversationId)
  }
  async setUnread(conversationId: string, state: UnreadState, hint?: ConversationHint): Promise<void> {
    this.writer.setUnread(conversationId, state, hint)
  }
  async setUnreadFromSnapshot(
    conversationId: string,
    state: UnreadState,
    snapshotStartedAt: number,
    hint?: ConversationHint,
  ): Promise<void> {
    this.writer.setUnreadFromSnapshot(conversationId, state, snapshotStartedAt, hint)
  }
}
