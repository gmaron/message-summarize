/** A part of a digest waiting to be delivered (RF-52). */
export interface OutboxItem {
  readonly id: number
  readonly text: string
}

/** The persistent queue of digest parts that `DigestStore.commit` fills. This is the delivery side of it. */
export interface OutboxRepository {
  /** Parts not delivered yet, in delivery order (oldest first). */
  pending(): Promise<readonly OutboxItem[]>
  /** Marks a part delivered. False when the id does not exist or was marked already. */
  markSent(id: number): Promise<boolean>
  /**
   * Throws away every part not delivered yet (unlinking the account: the parts hold private conversations of the old
   * account and must never go to another one). Returns how many were discarded. Delivered parts are kept.
   */
  discardPending(): Promise<number>
}

/** What the "Ask" tab needs of the outbox: to queue an answer for the account's own chat and to see if it went out. */
export interface OwnChatQueue {
  /**
   * Queues parts for the account's OWN chat, in order, after what is already queued, without a digest (an answer of the
   * "Ask" tab). All or nothing. Returns the id of the last part. There is no recipient: the channel only ever delivers to
   * the own chat (RF-51).
   */
  queueForOwnChat(parts: readonly string[]): Promise<number | null>
  /** Where a part is: still waiting, delivered, or gone (discarded when the account was unlinked, or never existed). */
  status(id: number): Promise<'queued' | 'sent' | 'gone'>
}
