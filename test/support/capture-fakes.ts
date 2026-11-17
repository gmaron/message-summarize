import type {
  CaptureRepository,
  ConversationHint,
  EditOutcome,
  InsertResult,
  UnreadEffect,
} from '../../src/application/ports/capture-repository.js'
import {
  type Conversation,
  MESSAGE_KINDS,
  type Message,
  type Participant,
  type UnreadState,
} from '../../src/domain/model.js'
import { unmaskedName } from '../../src/domain/names.js'
import { InMemorySource } from './application-fakes.js'

/**
 * In-memory CaptureRepository. `source` is the DigestSource over the same data, so a test reads back through the real
 * read port. It follows the contract of the port (test/contract/capture-repository.contract.ts), so a use case test
 * cannot pass because this fake is more lenient than the SQLite adapter.
 */
export class InMemoryCaptureRepository implements CaptureRepository {
  /** Where the data lives, and the read port over it. */
  readonly source = new InMemorySource()
  private readonly editedAt = new Map<string, number>()
  private readonly stamps = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  private get messages(): readonly Message[] {
    return this.source.allMessages()
  }

  private key = (conversationId: string, id: string): string => JSON.stringify([conversationId, id])

  private setAt(index: number, message: Message): void {
    const list = [...this.messages]
    list[index] = message
    this.source.replaceMessages(list)
  }

  private indexOf(conversationId: string, id: string): number {
    return this.messages.findIndex((m) => m.conversationId === conversationId && m.id === id)
  }

  private ensureConversation(id: string, hint: ConversationHint = {}): void {
    if (this.source.conversations.has(id)) return
    const isGroup = hint.isGroup === true
    this.source.addConversation({ id, isGroup, name: null, participantId: isGroup ? null : id, address: id })
  }

  async findConversation(id: string): Promise<Conversation | null> {
    return this.source.conversations.get(id) ?? null
  }

  async findParticipant(id: string): Promise<Participant | null> {
    return this.source.people.get(id) ?? null
  }

  async countOtherConversationsWithOwnText(conversationId: string, text: string): Promise<number> {
    const ids = new Set(
      this.messages
        .filter((m) => m.fromMe && m.text === text && m.conversationId !== conversationId)
        .map((m) => m.conversationId),
    )
    return ids.size
  }

  async upsertConversation(conversation: Conversation): Promise<void> {
    const known = this.source.conversations.get(conversation.id)
    this.source.addConversation({ ...conversation, name: unmaskedName(conversation.name) ?? known?.name ?? null })
  }

  async upsertParticipant(participant: Participant): Promise<void> {
    const known = this.source.people.get(participant.id)
    this.source.addParticipant({
      id: participant.id,
      savedName: unmaskedName(participant.savedName) ?? known?.savedName ?? null,
      publicName: unmaskedName(participant.publicName) ?? known?.publicName ?? null,
    })
  }

  /** Returns true when the row is new. `editedAt` is set for a message stored by an edit. */
  private upsertRow(message: Message, hint: ConversationHint, editedAt: number | null): boolean {
    if (!(MESSAGE_KINDS as readonly string[]).includes(message.kind)) {
      throw new Error(`Unknown message kind: ${String(message.kind)}`)
    }
    this.ensureConversation(message.conversationId, hint)
    const index = this.indexOf(message.conversationId, message.id)
    const key = this.key(message.conversationId, message.id)
    const clean = { ...message, senderName: unmaskedName(message.senderName) }
    const old = this.messages[index]
    if (old !== undefined) {
      const edited = this.editedAt.has(key)
      this.setAt(index, {
        ...old,
        senderName: clean.senderName ?? old.senderName,
        timestamp: edited ? Math.min(old.timestamp, clean.timestamp) : old.timestamp,
        text: edited ? old.text : (clean.text ?? old.text),
        transcript: clean.transcript ?? old.transcript,
        read: old.read || clean.read,
      })
      return false
    }
    this.source.addMessages(clean)
    if (editedAt !== null) this.editedAt.set(key, editedAt)
    return true
  }

  async insertMessage(
    message: Message,
    hint: ConversationHint = {},
    effectIfNew: UnreadEffect = 'none',
  ): Promise<InsertResult> {
    const isNew = this.upsertRow(message, hint, null)
    if (isNew) {
      if (effectIfNew === 'increment') {
        const current = this.source.unread.get(message.conversationId)
        const count = current?.kind === 'count' ? current.count : 0
        this.writeUnread(message.conversationId, { kind: 'count', count: count + 1 }, this.now(), hint, false)
      } else if (effectIfNew === 'markRead') {
        await this.markAllIncomingRead(message.conversationId)
        this.writeUnread(message.conversationId, { kind: 'count', count: 0 }, this.now(), hint, false)
      }
    }
    const stored = this.messages[this.indexOf(message.conversationId, message.id)]
    return { isNew, hasTranscript: stored?.transcript != null }
  }

  async recordEdit(message: Message, editedAt: number, hint: ConversationHint = {}): Promise<EditOutcome> {
    const index = this.indexOf(message.conversationId, message.id)
    const old = this.messages[index]
    if (old === undefined) {
      this.upsertRow(message, hint, editedAt)
      return 'inserted'
    }
    const key = this.key(message.conversationId, message.id)
    const applied = this.editedAt.get(key)
    if (applied !== undefined && applied >= editedAt) return 'ignored'
    this.setAt(index, { ...old, text: message.text })
    this.editedAt.set(key, editedAt)
    return 'applied'
  }

  async setTranscript(conversationId: string, messageId: string, transcript: string): Promise<boolean> {
    const index = this.indexOf(conversationId, messageId)
    const old = this.messages[index]
    if (old === undefined) return false
    this.setAt(index, { ...old, transcript })
    return true
  }

  async markReadThrough(conversationId: string, messageIds: readonly string[]): Promise<void> {
    for (const id of messageIds) {
      const target = this.messages[this.indexOf(conversationId, id)]
      if (target === undefined || target.fromMe) continue
      this.source.replaceMessages(
        this.messages.map((m) =>
          m.conversationId === conversationId && !m.fromMe && m.timestamp <= target.timestamp
            ? { ...m, read: true }
            : m,
        ),
      )
    }
  }

  async markAllIncomingRead(conversationId: string): Promise<void> {
    this.source.replaceMessages(
      this.messages.map((m) => (m.conversationId === conversationId && !m.fromMe ? { ...m, read: true } : m)),
    )
  }

  private writeUnread(
    conversationId: string,
    state: UnreadState,
    stamp: number,
    hint: ConversationHint,
    onlyIfOlder: boolean,
  ): void {
    this.ensureConversation(conversationId, hint)
    const current = this.stamps.get(conversationId)
    if (onlyIfOlder && current !== undefined && current >= stamp) return
    this.source.unread.set(conversationId, state)
    this.stamps.set(conversationId, stamp)
  }

  async setUnread(conversationId: string, state: UnreadState, hint: ConversationHint = {}): Promise<void> {
    this.writeUnread(conversationId, state, this.now(), hint, false)
  }

  async setUnreadFromSnapshot(
    conversationId: string,
    state: UnreadState,
    snapshotStartedAt: number,
    hint: ConversationHint = {},
  ): Promise<void> {
    this.writeUnread(conversationId, state, snapshotStartedAt, hint, true)
  }
}
