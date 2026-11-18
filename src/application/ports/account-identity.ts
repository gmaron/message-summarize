/**
 * The account an installation's database belongs to, persisted: the identifier of the account's own chat ("message
 * yourself") as the platform gives it. It is what the digest of private conversations may be delivered to (RF-51),
 * and it outlives the live connection: unlinking and linking another phone does not change it.
 */
export interface AccountIdentity {
  /** The bound account, or null when none was bound yet. */
  get(): string | null
  /**
   * Binds the account if none is bound. Returns true when `id` is the bound account afterwards (newly bound, or it
   * was already), false when a DIFFERENT account is bound; the bound one never changes.
   */
  bind(id: string): boolean
  /**
   * Forgets the bound account, so that another one can be bound (unlinking). Does nothing when none is bound. The
   * caller is responsible for discarding what was queued for the old account (`OutboxRepository.discardPending`).
   */
  reset(): void
}
