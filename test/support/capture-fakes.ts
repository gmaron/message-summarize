import type {
  CaptureRepository,
  ConversationHint,
  DownloadDescriptor,
  EditOutcome,
  InsertResult,
  UnreadEffect,
} from '../../src/application/ports/capture-repository.js'
import type { DownloadQueue, PendingDownload, RetryOutcome } from '../../src/application/ports/download-queue.js'
import type { PendingAudio, TimeRange, TranscriptionStore } from '../../src/application/ports/transcription-store.js'
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
export class InMemoryCaptureRepository implements CaptureRepository, TranscriptionStore, DownloadQueue {
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
      // A provisional message stored by an edit loses entirely to an original from a different author.
      if (edited && (old.senderId !== clean.senderId || old.fromMe !== clean.fromMe)) {
        this.setAt(index, { ...clean, transcript: clean.transcript ?? old.transcript, read: old.read || clean.read })
        this.editedAt.delete(key)
        return false
      }
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
    if (isNew) await this.applyEffect(message.conversationId, effectIfNew, hint)
    const stored = this.messages[this.indexOf(message.conversationId, message.id)]
    return {
      isNew,
      hasTranscript: stored?.transcript != null,
      mediaHandled: this.media.has(this.key(message.conversationId, message.id)),
    }
  }

  private async applyEffect(conversationId: string, effect: UnreadEffect, hint: ConversationHint): Promise<void> {
    if (effect === 'increment') {
      const current = this.source.unread.get(conversationId)
      const count = current?.kind === 'count' ? current.count : 0
      this.writeUnread(conversationId, { kind: 'count', count: count + 1 }, this.now(), hint, false)
    } else if (effect === 'markRead') {
      await this.markAllIncomingRead(conversationId)
      this.writeUnread(conversationId, { kind: 'count', count: 0 }, this.now(), hint, false)
    }
  }

  async recordEdit(message: Message, editedAt: number, hint: ConversationHint = {}): Promise<EditOutcome> {
    const index = this.indexOf(message.conversationId, message.id)
    const old = this.messages[index]
    if (old === undefined) {
      this.upsertRow(message, hint, editedAt)
      return 'inserted'
    }
    // Only the author edits a message.
    if (old.senderId !== message.senderId || old.fromMe !== message.fromMe) return 'ignored'
    const key = this.key(message.conversationId, message.id)
    const applied = this.editedAt.get(key)
    if (applied !== undefined && applied >= editedAt) return 'ignored'
    this.setAt(index, { ...old, text: message.text ?? old.text })
    this.editedAt.set(key, editedAt)
    return 'applied'
  }

  async setTranscript(conversationId: string, messageId: string, transcript: string): Promise<boolean> {
    const index = this.indexOf(conversationId, messageId)
    const old = this.messages[index]
    if (old === undefined) return false
    this.setAt(index, { ...old, transcript })
    const media = this.media.get(this.key(conversationId, messageId))
    if (media !== undefined) {
      this.media.set(this.key(conversationId, messageId), { ...media, status: 'done', descriptor: null })
    }
    return true
  }

  /** Per audio: its file and where it is in the transcription queue, like the columns of the SQLite adapter. */
  readonly media = new Map<
    string,
    {
      ref: string | null
      status: 'download_pending' | 'pending' | 'done' | 'failed'
      error: string | null
      /** The download descriptor, only while the status is 'download_pending'. */
      descriptor: DownloadDescriptor | null
      attempts: number
      /** When a download that failed for a moment is due again (epoch ms). Absent: due now. */
      nextAttemptAt?: number
    }
  >()

  async queueDownload(conversationId: string, messageId: string, descriptor: DownloadDescriptor): Promise<boolean> {
    const old = this.messages[this.indexOf(conversationId, messageId)]
    const key = this.key(conversationId, messageId)
    if (old === undefined || old.kind !== 'audio' || old.transcript !== null || this.media.has(key)) return false
    this.media.set(key, { ref: null, status: 'download_pending', error: null, descriptor, attempts: 0 })
    return true
  }

  async setMedia(conversationId: string, messageId: string, mediaRef: string): Promise<boolean> {
    const old = this.messages[this.indexOf(conversationId, messageId)]
    if (old === undefined || old.kind !== 'audio') return false
    this.media.set(this.key(conversationId, messageId), {
      ref: mediaRef,
      status: old.transcript === null ? 'pending' : 'done',
      error: null,
      descriptor: null,
      attempts: 0,
    })
    return true
  }

  async setMediaFailure(conversationId: string, messageId: string, reason: string): Promise<boolean> {
    const old = this.messages[this.indexOf(conversationId, messageId)]
    if (old === undefined || old.kind !== 'audio' || old.transcript !== null) return false
    const known = this.media.get(this.key(conversationId, messageId))
    this.media.set(this.key(conversationId, messageId), {
      ref: known?.ref ?? null,
      status: 'failed',
      error: reason,
      descriptor: null,
      attempts: 0,
    })
    return true
  }

  // ---- DownloadQueue: the durable download queue, over the same data ---------------------------------------------

  async nextDownload(now: number): Promise<PendingDownload | null> {
    let best: { message: Message; descriptor: DownloadDescriptor } | null = null
    for (const message of this.messages) {
      const media = this.media.get(this.key(message.conversationId, message.id))
      if (media?.status !== 'download_pending' || media.descriptor === null) continue
      if (media.nextAttemptAt !== undefined && media.nextAttemptAt > now) continue
      if (best === null || message.timestamp < best.message.timestamp) best = { message, descriptor: media.descriptor }
    }
    if (best === null) return null
    return {
      conversationId: best.message.conversationId,
      messageId: best.message.id,
      timestamp: best.message.timestamp,
      descriptor: best.descriptor,
    }
  }

  async countDownloads(): Promise<number> {
    return [...this.media.values()].filter((media) => media.status === 'download_pending').length
  }

  async completeDownload(conversationId: string, messageId: string, mediaRef: string): Promise<boolean> {
    const key = this.key(conversationId, messageId)
    const media = this.media.get(key)
    if (media?.status !== 'download_pending') return false
    this.media.set(key, { ref: mediaRef, status: 'pending', error: null, descriptor: null, attempts: 0 })
    return true
  }

  async failDownload(conversationId: string, messageId: string, reason: string): Promise<void> {
    const key = this.key(conversationId, messageId)
    if (this.media.get(key)?.status === 'download_pending') {
      this.media.set(key, { ref: null, status: 'failed', error: reason, descriptor: null, attempts: 0 })
    }
  }

  async retryDownload(
    conversationId: string,
    messageId: string,
    maxAttempts: number,
    nextAttemptAt: (attempts: number) => number,
  ): Promise<RetryOutcome> {
    const key = this.key(conversationId, messageId)
    const media = this.media.get(key)
    if (media?.status !== 'download_pending') return 'retry'
    const attempts = media.attempts + 1
    if (attempts >= maxAttempts) {
      await this.failDownload(conversationId, messageId, 'download-failed')
      return 'failed'
    }
    this.media.set(key, { ...media, attempts, nextAttemptAt: nextAttemptAt(attempts) })
    return 'retry'
  }

  async sweepDownloads(now: number, maxAgeMs: number): Promise<{ invalid: number; expired: number }> {
    let invalid = 0
    let expired = 0
    for (const message of this.messages) {
      const key = this.key(message.conversationId, message.id)
      const media = this.media.get(key)
      if (media?.status !== 'download_pending') continue
      const fail = (reason: string): void => {
        this.media.set(key, { ref: null, status: 'failed', error: reason, descriptor: null, attempts: 0 })
      }
      if (media.descriptor === null || media.descriptor.directPath === '' || media.descriptor.mediaKey.length === 0) {
        fail('invalid-media')
        invalid += 1
      } else if (message.timestamp < now - maxAgeMs) {
        fail('expired')
        expired += 1
      }
    }
    return { invalid, expired }
  }

  // ---- TranscriptionStore: the queue, over the same data --------------------------------------------------------

  /** The pending audios of the range, oldest first, ties in the order they were stored. */
  private pendingIn(range?: TimeRange): { message: Message; ref: string }[] {
    const found: { message: Message; ref: string }[] = []
    for (const message of this.messages) {
      const media = this.media.get(this.key(message.conversationId, message.id))
      if (media?.status !== 'pending' || media.ref === null) continue
      if (range?.from !== undefined && message.timestamp < range.from) continue
      if (range?.until !== undefined && message.timestamp >= range.until) continue
      found.push({ message, ref: media.ref })
    }
    return found.sort((a, b) => a.message.timestamp - b.message.timestamp) // stable: ties keep insertion order
  }

  async nextPending(range?: TimeRange): Promise<PendingAudio | null> {
    const first = this.pendingIn(range)[0]
    if (first === undefined) return null
    return {
      conversationId: first.message.conversationId,
      messageId: first.message.id,
      mediaRef: first.ref,
      timestamp: first.message.timestamp,
    }
  }

  async countPending(range?: TimeRange): Promise<number> {
    return this.pendingIn(range).length
  }

  async complete(conversationId: string, messageId: string, transcript: string): Promise<boolean> {
    const key = this.key(conversationId, messageId)
    const media = this.media.get(key)
    if (media?.status !== 'pending') return false
    const index = this.indexOf(conversationId, messageId)
    const old = this.messages[index]
    if (old === undefined) return false
    this.setAt(index, { ...old, transcript })
    this.media.set(key, { ...media, status: 'done', error: null })
    return true
  }

  async fail(conversationId: string, messageId: string, reason: string): Promise<void> {
    const key = this.key(conversationId, messageId)
    const media = this.media.get(key)
    if (media?.status === 'pending') this.media.set(key, { ...media, status: 'failed', error: reason.slice(0, 500) })
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
