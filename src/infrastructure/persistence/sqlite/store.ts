import type {
  CommitConflict,
  DigestCommit,
  DigestRecord,
  DigestStore,
} from '../../../application/ports/digest-store.js'
import { err, ok, type Result } from '../../../domain/result.js'
import type { Database } from './database.js'
import { closeCommittedRun } from './runs.js'
import { inTransaction } from './transaction.js'

/** A part waiting for delivery, or delivered (RF-52). */
export interface OutboxEntry {
  readonly id: number
  /** The digest this part belongs to. Null when it was enqueued with no digest. */
  readonly digestId: number | null
  readonly text: string
  readonly createdAt: number
  readonly sentAt: number | null
}

/**
 * SQLite implementation of the DigestStore port, plus the reads and the delivery marks that the outbox needs.
 * The outbox methods (`pendingOutbox`, `markOutboxSent`) are for the delivery side (RF-52); the use case never
 * calls them.
 */
export class SqliteDigestStore implements DigestStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async getPointer(): Promise<number | null> {
    const row = this.db.prepare('SELECT pointer FROM digest_pointer WHERE id = 1').get() as
      | { pointer: number }
      | undefined
    return row?.pointer ?? null
  }

  /**
   * One transaction taking the write lock first (BEGIN IMMEDIATE), so the check and the writes cannot interleave
   * with another connection. Compare and set on the pointer comes first; on a mismatch the transaction is rolled
   * back and nothing was written. If any later step throws, the rollback undoes the pointer move too.
   */
  async commit(commit: DigestCommit): Promise<Result<void, CommitConflict>> {
    return inTransaction(this.db, () => {
      if (!this.compareAndSetPointer(commit.previousPointer, commit.pointer)) {
        // Nothing was written yet. inTransaction commits an empty transaction, which changes nothing.
        return err('pointerChanged')
      }
      const createdAt = commit.digest?.createdAt ?? this.now()
      let digestId: number | null = null
      if (commit.digest !== null) {
        const { since, until, text, summarized, failed } = commit.digest
        const inserted = this.db
          .prepare('INSERT INTO digests (since, until, created_at, text, summarized, failed) VALUES (?, ?, ?, ?, ?, ?)')
          .run(since, until, commit.digest.createdAt, text, summarized, failed)
        digestId = Number(inserted.lastInsertRowid)
      }
      const enqueue = this.db.prepare('INSERT INTO outbox (digest_id, text, created_at) VALUES (?, ?, ?)')
      for (const part of commit.parts) enqueue.run(digestId, part, createdAt)
      // Same transaction: a committed digest always has its run, and a rolled-back commit leaves the run open.
      if (commit.run !== undefined) closeCommittedRun(this.db, commit.run, digestId)
      return ok(undefined)
    })
  }

  private compareAndSetPointer(previous: number | null, next: number): boolean {
    if (previous === null) {
      // Succeeds only when there is no row.
      const result = this.db
        .prepare('INSERT INTO digest_pointer (id, pointer) VALUES (1, ?) ON CONFLICT (id) DO NOTHING')
        .run(next)
      return Number(result.changes) === 1
    }
    const result = this.db
      .prepare('UPDATE digest_pointer SET pointer = ? WHERE id = 1 AND pointer = ?')
      .run(next, previous)
    return Number(result.changes) === 1
  }

  /** Every digest kept, oldest first. */
  history(): DigestRecord[] {
    const rows = this.db
      .prepare('SELECT since, until, created_at, text, summarized, failed FROM digests ORDER BY id')
      .all() as unknown as {
      since: number
      until: number
      created_at: number
      text: string
      summarized: number
      failed: number
    }[]
    return rows.map((r) => ({
      since: r.since,
      until: r.until,
      createdAt: r.created_at,
      text: r.text,
      summarized: r.summarized,
      failed: r.failed,
    }))
  }

  /** Parts not yet delivered, in delivery order. */
  pendingOutbox(): OutboxEntry[] {
    return this.outboxRows('WHERE sent_at IS NULL')
  }

  /** Every part, delivered or not, in order. */
  outbox(): OutboxEntry[] {
    return this.outboxRows('')
  }

  /** Marks a part delivered. Returns false when the id does not exist or was already marked. */
  markOutboxSent(id: number, sentAt: number = this.now()): boolean {
    const result = this.db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ? AND sent_at IS NULL').run(sentAt, id)
    return Number(result.changes) === 1
  }

  /** Deletes every part not delivered yet (unlinking). Returns how many. Delivered parts stay. */
  discardPendingOutbox(): number {
    return Number(this.db.prepare('DELETE FROM outbox WHERE sent_at IS NULL').run().changes)
  }

  private outboxRows(where: string): OutboxEntry[] {
    const rows = this.db
      .prepare(`SELECT id, digest_id, text, created_at, sent_at FROM outbox ${where} ORDER BY id`)
      .all() as unknown as {
      id: number
      digest_id: number | null
      text: string
      created_at: number
      sent_at: number | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      digestId: r.digest_id,
      text: r.text,
      createdAt: r.created_at,
      sentAt: r.sent_at,
    }))
  }
}
