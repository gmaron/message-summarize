import type { DownloadQueue, PendingDownload, RetryOutcome } from '../../../application/ports/download-queue.js'
import type { PendingAudio, TimeRange, TranscriptionStore } from '../../../application/ports/transcription-store.js'
import { CLEAR_DESCRIPTOR } from './capture-writer.js'
import type { Database } from './database.js'
import { inTransaction } from './transaction.js'

interface PendingRow {
  conversation_id: string
  id: string
  media_ref: string
  timestamp: number
}

interface DownloadRow {
  conversation_id: string
  id: string
  timestamp: number
  dl_direct_path: string
  dl_media_key: Uint8Array
  dl_mimetype: string
  dl_file_length: number | null
}

/** The pending audios of the range, as an SQL condition and its parameters. `from` is inclusive, `until` exclusive. */
function rangeClause(range: TimeRange | undefined): { sql: string; params: number[] } {
  const params: number[] = []
  let sql = ''
  if (range?.from !== undefined) {
    sql += ' AND timestamp >= ?'
    params.push(range.from)
  }
  if (range?.until !== undefined) {
    sql += ' AND timestamp < ?'
    params.push(range.until)
  }
  return { sql, params }
}

/**
 * The two durable queues of audio on SQLite (RF-15, RNF-08), both on the messages table (migration 3):
 * - downloads: status 'download_pending', with the descriptor in the `dl_*` columns (`dl_media_key` is a secret: it is
 *   read only to download, and cleared when the file is stored or the download failed for good);
 * - transcriptions: status 'pending': file stored, no transcript yet.
 * Every change is one statement conditioned on the status, so two processes working on the same account (the daemon and
 * a `msum digest`) cannot both finish the same audio.
 */
export class SqliteTranscriptionStore implements TranscriptionStore, DownloadQueue {
  constructor(private readonly db: Database) {}

  // ---- downloads ----------------------------------------------------------------------------------------------

  async nextDownload(now: number): Promise<PendingDownload | null> {
    const row = this.db
      .prepare(
        `SELECT conversation_id, id, timestamp, dl_direct_path, dl_media_key, dl_mimetype, dl_file_length FROM messages
         WHERE transcribe_status = 'download_pending' AND dl_direct_path IS NOT NULL AND dl_media_key IS NOT NULL
           AND (dl_next_attempt_at IS NULL OR dl_next_attempt_at <= ?)
         ORDER BY timestamp, seq LIMIT 1`,
      )
      .get(now) as DownloadRow | undefined
    if (row === undefined) return null
    return {
      conversationId: row.conversation_id,
      messageId: row.id,
      timestamp: row.timestamp,
      descriptor: {
        directPath: row.dl_direct_path,
        mediaKey: row.dl_media_key,
        mimetype: row.dl_mimetype,
        fileLength: row.dl_file_length,
      },
    }
  }

  async countDownloads(): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE transcribe_status = 'download_pending'")
      .get() as { n: number }
    return row.n
  }

  async completeDownload(conversationId: string, messageId: string, mediaRef: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE messages SET media_ref = ?, transcribe_status = 'pending', transcribe_error = NULL, ${CLEAR_DESCRIPTOR}
         WHERE conversation_id = ? AND id = ? AND transcribe_status = 'download_pending'`,
      )
      .run(mediaRef, conversationId, messageId)
    return Number(result.changes) === 1
  }

  async failDownload(conversationId: string, messageId: string, reason: string): Promise<void> {
    this.markDownloadFailed(conversationId, messageId, reason)
  }

  async retryDownload(
    conversationId: string,
    messageId: string,
    maxAttempts: number,
    nextAttemptAt: (attempts: number) => number,
  ): Promise<RetryOutcome> {
    return inTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE messages SET dl_attempts = dl_attempts + 1
           WHERE conversation_id = ? AND id = ? AND transcribe_status = 'download_pending'`,
        )
        .run(conversationId, messageId)
      const row = this.db
        .prepare(
          `SELECT dl_attempts AS attempts FROM messages
           WHERE conversation_id = ? AND id = ? AND transcribe_status = 'download_pending'`,
        )
        .get(conversationId, messageId) as { attempts: number } | undefined
      if (row === undefined) return 'retry'
      if (row.attempts >= maxAttempts) {
        this.markDownloadFailed(conversationId, messageId, 'download-failed')
        return 'failed'
      }
      this.db
        .prepare(
          `UPDATE messages SET dl_next_attempt_at = ?
           WHERE conversation_id = ? AND id = ? AND transcribe_status = 'download_pending'`,
        )
        .run(nextAttemptAt(row.attempts), conversationId, messageId)
      return 'retry'
    })
  }

  async sweepDownloads(now: number, maxAgeMs: number): Promise<{ invalid: number; expired: number }> {
    return inTransaction(this.db, () => {
      const invalid = this.db
        .prepare(
          `UPDATE messages SET transcribe_status = 'failed', transcribe_error = 'invalid-media', ${CLEAR_DESCRIPTOR}
           WHERE transcribe_status = 'download_pending' AND (dl_direct_path IS NULL OR dl_media_key IS NULL)`,
        )
        .run()
      const expired = this.db
        .prepare(
          `UPDATE messages SET transcribe_status = 'failed', transcribe_error = 'expired', ${CLEAR_DESCRIPTOR}
           WHERE transcribe_status = 'download_pending' AND timestamp < ?`,
        )
        .run(now - maxAgeMs)
      return { invalid: Number(invalid.changes), expired: Number(expired.changes) }
    })
  }

  private markDownloadFailed(conversationId: string, messageId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE messages SET transcribe_status = 'failed', transcribe_error = ?, ${CLEAR_DESCRIPTOR}
         WHERE conversation_id = ? AND id = ? AND transcribe_status = 'download_pending'`,
      )
      .run(reason.slice(0, 500), conversationId, messageId)
  }

  // ---- transcriptions -----------------------------------------------------------------------------------------

  async nextPending(range?: TimeRange): Promise<PendingAudio | null> {
    const { sql, params } = rangeClause(range)
    const row = this.db
      .prepare(
        `SELECT conversation_id, id, media_ref, timestamp FROM messages
         WHERE transcribe_status = 'pending' AND media_ref IS NOT NULL${sql}
         ORDER BY timestamp, seq LIMIT 1`,
      )
      .get(...params) as PendingRow | undefined
    if (row === undefined) return null
    return {
      conversationId: row.conversation_id,
      messageId: row.id,
      mediaRef: row.media_ref,
      timestamp: row.timestamp,
    }
  }

  async countPending(range?: TimeRange): Promise<number> {
    const { sql, params } = rangeClause(range)
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE transcribe_status = 'pending'${sql}`)
      .get(...params) as { n: number }
    return row.n
  }

  async complete(conversationId: string, messageId: string, transcript: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE messages SET transcript = ?, transcribe_status = 'done', transcribe_error = NULL
         WHERE conversation_id = ? AND id = ? AND transcribe_status = 'pending'`,
      )
      .run(transcript, conversationId, messageId)
    return Number(result.changes) === 1
  }

  async fail(conversationId: string, messageId: string, reason: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE messages SET transcribe_status = 'failed', transcribe_error = ?
         WHERE conversation_id = ? AND id = ? AND transcribe_status = 'pending'`,
      )
      .run(reason.slice(0, 500), conversationId, messageId)
  }
}
