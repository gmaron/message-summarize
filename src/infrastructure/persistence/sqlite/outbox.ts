import type { OutboxItem, OutboxRepository } from '../../../application/ports/outbox.js'
import type { SqliteDigestStore } from './store.js'

/** The delivery side of the outbox (RF-52) on SQLite: reads and marks the rows that `SqliteDigestStore.commit` wrote. */
export class SqliteOutboxRepository implements OutboxRepository {
  constructor(private readonly store: SqliteDigestStore) {}

  async pending(): Promise<readonly OutboxItem[]> {
    return this.store.pendingOutbox().map(({ id, text }) => ({ id, text }))
  }

  async markSent(id: number): Promise<boolean> {
    return this.store.markOutboxSent(id)
  }
}
