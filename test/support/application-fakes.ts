import type { Clock } from '../../src/application/ports/clock.js'
import type { DigestSource } from '../../src/application/ports/digest-source.js'
import type { CommitConflict, DigestCommit, DigestStore } from '../../src/application/ports/digest-store.js'
import type { SummarizeRequest, Summarizer } from '../../src/application/ports/summarizer.js'
import type { OwnMessageText } from '../../src/domain/mass.js'
import type { Conversation, Message, Participant, UnreadState } from '../../src/domain/model.js'
import { err, ok, type Result } from '../../src/domain/result.js'
import type { IncomingMessage } from '../../src/domain/unread.js'
import { isInWindow, type SummaryWindow } from '../../src/domain/window.js'

/**
 * In-memory ports for the use case tests and the golden harness. They follow the contract of each port, so a test
 * cannot pass because a fake is more lenient than a real adapter.
 */

export class FixedClock implements Clock {
  constructor(public time: number) {}
  now(): number {
    return this.time
  }
}

/**
 * What an adapter returns for a chat it has messages for but no metadata: a group with no name, or a bare id.
 * Whether an id is a group is platform knowledge, so the test declares it with `markGroup`.
 */
function unknownConversation(id: string, isGroup: boolean): Conversation {
  return { id, isGroup, name: null, participantId: isGroup ? null : id, address: id }
}

export class InMemorySource implements DigestSource {
  readonly conversations = new Map<string, Conversation>()
  readonly people = new Map<string, Participant>()
  readonly unread = new Map<string, UnreadState>()
  private readonly groupIds = new Set<string>()
  private messages: Message[] = []

  addConversation(conversation: Conversation): this {
    this.conversations.set(conversation.id, conversation)
    return this
  }

  /** Declares a conversation id as a group, for chats added without metadata. */
  markGroup(id: string): this {
    this.groupIds.add(id)
    return this
  }

  addMessages(...messages: Message[]): this {
    this.messages.push(...messages)
    return this
  }

  /** Every message, in the order the source stored them. */
  allMessages(): readonly Message[] {
    return this.messages
  }

  /** For the capture fake: replaces the stored messages (it keeps the order it is given). */
  replaceMessages(messages: Message[]): this {
    this.messages = messages
    return this
  }

  addParticipant(participant: Participant): this {
    this.people.set(participant.id, participant)
    return this
  }

  setUnread(conversationId: string, state: UnreadState): this {
    this.unread.set(conversationId, state)
    return this
  }

  private of(conversationId: string): Message[] {
    return this.messages.filter((m) => m.conversationId === conversationId).sort((a, b) => a.timestamp - b.timestamp)
  }

  async conversationsWithMessages(window: SummaryWindow): Promise<readonly Conversation[]> {
    const firstInWindow = (id: string): number | undefined =>
      this.of(id).find((m) => isInWindow(window, m.timestamp))?.timestamp
    // Every chat with messages in the window is a Conversation, even with no stored metadata.
    const ids = new Set([...this.conversations.keys(), ...this.messages.map((m) => m.conversationId)])
    return [...ids]
      .map((id) => this.conversations.get(id) ?? unknownConversation(id, this.groupIds.has(id)))
      .map((conversation) => ({ conversation, first: firstInWindow(conversation.id) }))
      .filter((x): x is { conversation: Conversation; first: number } => x.first !== undefined)
      .sort(
        (a, b) =>
          a.first - b.first ||
          (a.conversation.id < b.conversation.id ? -1 : a.conversation.id > b.conversation.id ? 1 : 0),
      )
      .map((x) => x.conversation)
  }

  async messagesInWindow(conversationId: string, window: SummaryWindow): Promise<readonly Message[]> {
    return this.of(conversationId).filter((m) => isInWindow(window, m.timestamp))
  }

  async participants(ids: readonly string[]): Promise<ReadonlyMap<string, Participant>> {
    const found = new Map<string, Participant>()
    for (const id of ids) {
      const person = this.people.get(id)
      if (person !== undefined) found.set(id, person)
    }
    return found
  }

  async unreadState(conversationId: string): Promise<UnreadState> {
    return this.unread.get(conversationId) ?? { kind: 'unknown' }
  }

  async lastIncoming(conversationId: string, limit: number): Promise<readonly IncomingMessage[]> {
    return this.of(conversationId)
      .filter((m) => !m.fromMe)
      .reverse()
      .slice(0, limit)
      .map((m) => ({ id: m.id, read: m.read }))
  }

  async messagesBefore(conversationId: string, timestamp: number, limit: number): Promise<readonly Message[]> {
    if (limit <= 0) return [] // slice(-0) would return everything
    return this.of(conversationId)
      .filter((m) => m.timestamp < timestamp)
      .slice(-limit)
  }

  async ownMessageTexts(): Promise<Iterable<OwnMessageText>> {
    return this.messages.filter((m) => m.fromMe).map((m) => ({ conversationId: m.conversationId, text: m.text }))
  }
}

export class InMemoryStore implements DigestStore {
  pointer: number | null
  readonly commits: DigestCommit[] = []

  constructor(pointer: number | null = null) {
    this.pointer = pointer
  }

  async getPointer(): Promise<number | null> {
    return this.pointer
  }

  async commit(commit: DigestCommit): Promise<Result<void, CommitConflict>> {
    // Compare and set, as a real adapter does inside one transaction.
    if (this.pointer !== commit.previousPointer) return err('pointerChanged')
    this.commits.push(commit)
    this.pointer = commit.pointer
    return ok(undefined)
  }

  /** Every part enqueued so far. */
  get outbox(): string[] {
    return this.commits.flatMap((c) => [...c.parts])
  }

  /** Every digest kept in the history. */
  get history(): NonNullable<DigestCommit['digest']>[] {
    return this.commits.flatMap((c) => (c.digest === null ? [] : [c.digest]))
  }
}

export const VALID_RESPONSE = {
  resumen: 'Talked about lunch.',
  pendientes: [],
  necesita_respuesta: false,
  prioridad: 'media',
}

export type SummarizerHandler = (
  request: SummarizeRequest,
  call: number,
) => Promise<Result<unknown, string>> | Result<unknown, string>

/** Records every call and the highest number of calls in flight at once. */
export class FakeSummarizer implements Summarizer {
  readonly calls: SummarizeRequest[] = []
  inFlight = 0
  maxInFlight = 0

  constructor(private handler: SummarizerHandler = () => ok(VALID_RESPONSE)) {}

  async summarize(request: SummarizeRequest): Promise<Result<unknown, string>> {
    const call = this.calls.push(request) - 1
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      return await this.handler(request, call)
    } finally {
      this.inFlight--
    }
  }
}

/** A promise settled from outside, to control the order in which summaries complete. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
