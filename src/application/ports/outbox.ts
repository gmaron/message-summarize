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
}
