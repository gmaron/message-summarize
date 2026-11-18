import type { Result } from '../../domain/result.js'

/** A digest as kept in the history: the complete version, even when the delivered one hides the rest (RF-36). */
export interface DigestRecord {
  readonly since: number
  readonly until: number
  /** Epoch ms when it was generated. */
  readonly createdAt: number
  readonly text: string
  readonly summarized: number
  readonly failed: number
}

/** Why a conversation was not summarized, as a code that is safe to keep (never the provider's text). */
export type FailureCode = 'localOnlyUnavailable' | 'timeout' | 'invalidSummary' | 'failed'

export interface RunFailedConversation {
  readonly id: string
  readonly name: string
  readonly reason: FailureCode
}

/**
 * How a run that ends in a commit went (RF-74). The row was opened by the caller before the run (`runId`), so a crash
 * leaves it open; the commit closes it in the same transaction that saves the digest.
 */
export interface RunCompletion {
  readonly runId: number
  readonly finishedAt: number
  /** The window the run covered. */
  readonly since: number
  readonly until: number
  readonly summarized: number
  readonly failed: number
  /** Conversations summarized by each provider, by the name the adapter gave it (`unknown` when it gave none). */
  readonly providers: Readonly<Record<string, number>>
  readonly failedConversations: readonly RunFailedConversation[]
}

export interface DigestCommit {
  /** The pointer the use case read when it started. The commit is refused if the stored one is different. */
  readonly previousPointer: number | null
  /** The new pointer: end of the digest window, never behind the previous one. */
  readonly pointer: number
  /** Null for an empty window: nothing to keep. */
  readonly digest: DigestRecord | null
  /** Parts to deliver, in order. Empty when there is no digest. */
  readonly parts: readonly string[]
  /** The run being closed, when the caller records runs. Saved with the digest, or alone for an empty window. */
  readonly run?: RunCompletion
}

/** The stored pointer is not `previousPointer`: another run finished first. Nothing was saved. */
export type CommitConflict = 'pointerChanged'

/** State the use case writes. A preview never calls `commit`. */
export interface DigestStore {
  /** End of the previous digest, or null when there is none. */
  getPointer(): Promise<number | null>

  /**
   * Compare and set. If the stored pointer equals `previousPointer`, saves the digest in the history, enqueues its
   * parts for delivery (outbox) and moves the pointer, all in one transaction, and returns ok. Otherwise it saves
   * nothing and returns `pointerChanged`. Together this means two overlapping runs cannot both commit the same
   * window: the second one fails and its digest is discarded. The summaries it paid for are lost, which is the
   * price of never sending a window twice.
   */
  commit(commit: DigestCommit): Promise<Result<void, CommitConflict>>
}
