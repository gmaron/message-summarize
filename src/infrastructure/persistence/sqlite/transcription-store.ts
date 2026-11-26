import type { DownloadQueue, PendingDownload, RetryOutcome } from '../../../application/ports/download-queue.js'
import type {
  AudioQueueStats,
  AudioQueueStatsSource,
  ClaimOrder,
  PendingAudio,
  TimeRange,
  TranscriptionClaims,
  TranscriptionStore,
} from '../../../application/ports/transcription-store.js'
import { CLEAR_DESCRIPTOR } from './capture-writer.js'
import type { Database } from './database.js'
import { inTransaction } from './transaction.js'

interface PendingRow {
  conversation_id: string
  id: string
  media_ref: string
  timestamp: number
  kind: string
  text: string | null
}

interface DownloadRow {
  conversation_id: string
  id: string
  timestamp: number
  dl_direct_path: string
  dl_media_key: Uint8Array
  dl_mimetype: string
  dl_file_length: number | null
  dl_remote_jid: string | null
  dl_from_me: number | null
  dl_participant: string | null
  dl_reupload_attempts: number
}

const DOWNLOAD_COLUMNS =
  'conversation_id, id, timestamp, dl_direct_path, dl_media_key, dl_mimetype, dl_file_length, dl_remote_jid, dl_from_me, dl_participant, dl_reupload_attempts'

function toPendingDownload(row: DownloadRow): PendingDownload {
  return {
    conversationId: row.conversation_id,
    messageId: row.id,
    timestamp: row.timestamp,
    reuploadAttempts: row.dl_reupload_attempts,
    descriptor: {
      directPath: row.dl_direct_path,
      mediaKey: row.dl_media_key,
      mimetype: row.dl_mimetype,
      fileLength: row.dl_file_length,
      ...(row.dl_remote_jid === null
        ? {}
        : {
            reuploadKey: {
              remoteJid: row.dl_remote_jid,
              fromMe: row.dl_from_me === 1,
              participant: row.dl_participant,
            },
          }),
    },
  }
}

function toPendingAudio(row: PendingRow): PendingAudio {
  const image = row.kind === 'image'
  return {
    conversationId: row.conversation_id,
    messageId: row.id,
    mediaRef: row.media_ref,
    timestamp: row.timestamp,
    kind: image ? 'image' : 'audio',
    caption: image ? row.text : null,
  }
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
export class SqliteTranscriptionStore
  implements TranscriptionStore, TranscriptionClaims, DownloadQueue, AudioQueueStatsSource
{
  constructor(private readonly db: Database) {}

  // ---- downloads ----------------------------------------------------------------------------------------------

  async nextDownload(now: number): Promise<PendingDownload | null> {
    const row = this.db
      .prepare(
        `SELECT ${DOWNLOAD_COLUMNS} FROM messages
         WHERE transcribe_status = 'download_pending' AND dl_direct_path IS NOT NULL AND dl_media_key IS NOT NULL
           AND dl_needs_reupload = 0 AND (dl_next_attempt_at IS NULL OR dl_next_attempt_at <= ?)
         ORDER BY timestamp, seq LIMIT 1`,
      )
      .get(now) as DownloadRow | undefined
    return row === undefined ? null : toPendingDownload(row)
  }

  /** One statement: picks the row and puts the lease on it, so two workers (or processes) never get the same one. */
  async claimDownload(now: number, leaseMs: number): Promise<PendingDownload | null> {
    return this.claimWhere(0, now, leaseMs)
  }

  async claimReupload(now: number, leaseMs: number): Promise<PendingDownload | null> {
    return this.claimWhere(1, now, leaseMs)
  }

  private claimWhere(needsReupload: 0 | 1, now: number, leaseMs: number): PendingDownload | null {
    const row = this.db
      .prepare(
        `UPDATE messages SET dl_next_attempt_at = ?
         WHERE seq = (
           SELECT seq FROM messages
           WHERE transcribe_status = 'download_pending' AND dl_direct_path IS NOT NULL AND dl_media_key IS NOT NULL
             AND dl_needs_reupload = ? AND (dl_next_attempt_at IS NULL OR dl_next_attempt_at <= ?)
           ORDER BY timestamp, seq LIMIT 1
         )
         RETURNING ${DOWNLOAD_COLUMNS}`,
      )
      .get(now + leaseMs, needsReupload, now) as DownloadRow | undefined
    return row === undefined ? null : toPendingDownload(row)
  }

  async releaseDownload(conversationId: string, messageId: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE messages SET dl_next_attempt_at = NULL
         WHERE conversation_id = ? AND id = ? AND transcribe_status = 'download_pending'`,
      )
      .run(conversationId, messageId)
  }

  async markNeedsReupload(conversationId: string, messageId: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE messages SET dl_needs_reupload = 1, dl_next_attempt_at = NULL
         WHERE conversation_id = ? AND id = ? AND transcribe_status = 'download_pending' AND dl_remote_jid IS NOT NULL`,
      )
      .run(conversationId, messageId)
    return Number(result.changes) === 1
  }

  async completeReupload(conversationId: string, messageId: string, directPath: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE messages SET dl_direct_path = ?, dl_needs_reupload = 0, dl_next_attempt_at = NULL,
           dl_reupload_attempts = dl_reupload_attempts + 1
         WHERE conversation_id = ? AND id = ? AND transcribe_status = 'download_pending'`,
      )
      .run(directPath, conversationId, messageId)
  }

  async retryReupload(
    conversationId: string,
    messageId: string,
    maxAttempts: number,
    nextAttemptAt: (attempts: number) => number,
  ): Promise<RetryOutcome> {
    return inTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE messages SET dl_reupload_attempts = dl_reupload_attempts + 1
           WHERE conversation_id = ? AND id = ? AND transcribe_status = 'download_pending'`,
        )
        .run(conversationId, messageId)
      const row = this.db
        .prepare(
          `SELECT dl_reupload_attempts AS attempts FROM messages
           WHERE conversation_id = ? AND id = ? AND transcribe_status = 'download_pending'`,
        )
        .get(conversationId, messageId) as { attempts: number } | undefined
      if (row === undefined) return 'retry'
      if (row.attempts >= maxAttempts) {
        this.markDownloadFailed(conversationId, messageId, 'expired')
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

  async sweepDownloads(now: number, maxAgeMs: number | null): Promise<{ invalid: number; expired: number }> {
    return inTransaction(this.db, () => {
      const invalid = this.db
        .prepare(
          `UPDATE messages SET transcribe_status = 'failed', transcribe_error = 'invalid-media', ${CLEAR_DESCRIPTOR}
           WHERE transcribe_status = 'download_pending' AND (dl_direct_path IS NULL OR dl_media_key IS NULL)`,
        )
        .run()
      const expired =
        maxAgeMs === null
          ? null
          : this.db
              .prepare(
                `UPDATE messages SET transcribe_status = 'failed', transcribe_error = 'expired', ${CLEAR_DESCRIPTOR}
                 WHERE transcribe_status = 'download_pending' AND timestamp < ?`,
              )
              .run(now - maxAgeMs)
      return { invalid: Number(invalid.changes), expired: Number(expired?.changes ?? 0) }
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
        `SELECT conversation_id, id, media_ref, timestamp, kind, text FROM messages
         WHERE transcribe_status = 'pending' AND media_ref IS NOT NULL${sql}
         ORDER BY timestamp, seq LIMIT 1`,
      )
      .get(...params) as PendingRow | undefined
    return row === undefined ? null : toPendingAudio(row)
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
        `UPDATE messages SET transcript = ?, transcribe_status = 'done', transcribe_error = NULL,
           transcribe_claimed_at = NULL
         WHERE conversation_id = ? AND id = ? AND transcribe_status = 'pending'`,
      )
      .run(transcript, conversationId, messageId)
    return Number(result.changes) === 1
  }

  async fail(conversationId: string, messageId: string, reason: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE messages SET transcribe_status = 'failed', transcribe_error = ?, transcribe_claimed_at = NULL
         WHERE conversation_id = ? AND id = ? AND transcribe_status = 'pending'`,
      )
      .run(reason.slice(0, 500), conversationId, messageId)
  }

  // ---- claims of the transcription pool -----------------------------------------------------------------------

  /**
   * One statement: picks the next pending audio nobody works on and marks it in progress, so two workers (or two
   * processes on the same database) never get the same one.
   */
  async claimPending(range?: TimeRange, order: ClaimOrder = 'newest'): Promise<PendingAudio | null> {
    const { sql, params } = rangeClause(range)
    const direction = order === 'newest' ? 'DESC' : 'ASC'
    const row = this.db
      .prepare(
        `UPDATE messages SET transcribe_claimed_at = ?
         WHERE seq = (
           SELECT seq FROM messages
           WHERE transcribe_status = 'pending' AND media_ref IS NOT NULL AND transcribe_claimed_at IS NULL${sql}
           ORDER BY timestamp ${direction}, seq ${direction} LIMIT 1
         )
         RETURNING conversation_id, id, media_ref, timestamp, kind, text`,
      )
      .get(Date.now(), ...params) as PendingRow | undefined
    return row === undefined ? null : toPendingAudio(row)
  }

  async releaseClaim(conversationId: string, messageId: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE messages SET transcribe_claimed_at = NULL
         WHERE conversation_id = ? AND id = ? AND transcribe_status = 'pending'`,
      )
      .run(conversationId, messageId)
  }

  async releaseAllClaims(): Promise<number> {
    const result = this.db
      .prepare('UPDATE messages SET transcribe_claimed_at = NULL WHERE transcribe_claimed_at IS NOT NULL')
      .run()
    return Number(result.changes)
  }

  // ---- progress -----------------------------------------------------------------------------------------------

  async audioQueueStats(): Promise<AudioQueueStats> {
    const rows = this.db
      .prepare(
        `SELECT transcribe_status AS status, COUNT(*) AS n,
           SUM(transcribe_claimed_at IS NOT NULL) AS claimed, SUM(dl_needs_reupload) AS reupload
         FROM messages WHERE transcribe_status IS NOT NULL GROUP BY transcribe_status`,
      )
      .all() as { status: string; n: number; claimed: number | null; reupload: number | null }[]
    const of = (status: string) => rows.find((r) => r.status === status)
    const pending = of('pending')
    const waiting = of('download_pending')
    return {
      downloading: (waiting?.n ?? 0) - Number(waiting?.reupload ?? 0),
      pending: (pending?.n ?? 0) - Number(pending?.claimed ?? 0),
      running: Number(pending?.claimed ?? 0),
      done: of('done')?.n ?? 0,
      failed: of('failed')?.n ?? 0,
      reuploadRequested: Number(waiting?.reupload ?? 0),
    }
  }
}
