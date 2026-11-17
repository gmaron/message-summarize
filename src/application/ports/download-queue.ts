import type { Result } from '../../domain/result.js'
import type { DownloadDescriptor } from './capture-repository.js'

/** An audio waiting to be downloaded, with what it takes to do it. */
export interface PendingDownload {
  readonly conversationId: string
  readonly messageId: string
  /** Epoch ms. */
  readonly timestamp: number
  /** Contains the decryption key of the file: never log it, never print it. */
  readonly descriptor: DownloadDescriptor
}

/** What became of one attempt to retry a download. */
export type RetryOutcome = 'retry' | 'failed'

/**
 * The DURABLE queue of audio downloads (RF-15, RNF-08). Capture puts an audio in (`CaptureRepository.queueDownload`); the
 * download worker takes it out, one at a time, oldest first. Because the queue is the database, a restart, a dropped
 * connection or a stop loses nothing, and memory holds at most the one row being worked on.
 */
export interface DownloadQueue {
  /**
   * The OLDEST audio waiting to be downloaded that is DUE at `now` (epoch ms), or null: one that failed for a moment waits
   * out its backoff and does not hold up the ones behind it. Ties go in the order the messages were stored.
   */
  nextDownload(now: number): Promise<PendingDownload | null>
  countDownloads(): Promise<number>
  /**
   * The file is stored: the audio joins the transcription queue and its descriptor (the key) is cleared. False when it
   * was not waiting any more (another process did it, or the message is gone).
   */
  completeDownload(conversationId: string, messageId: string, mediaRef: string): Promise<boolean>
  /** The download failed for good: recorded with its code, descriptor cleared, never tried again. */
  failDownload(conversationId: string, messageId: string, reason: string): Promise<void>
  /**
   * A transient failure: the audio stays in the queue and its attempts go up by one; it is not due again before
   * `nextAttemptAt(attempts)` (epoch ms, `attempts` counted with this one). When they reach `maxAttempts` it fails for
   * good as `download-failed` (descriptor cleared). Returns what happened.
   */
  retryDownload(
    conversationId: string,
    messageId: string,
    maxAttempts: number,
    nextAttemptAt: (attempts: number) => number,
  ): Promise<RetryOutcome>
  /**
   * Housekeeping, so no row stays stuck and no key stays for nothing. Of the audios waiting: one with no path or no key
   * fails as `invalid-media`; one whose message is older than `maxAgeMs` fails as `expired` (WhatsApp media expires long
   * before: a key kept for it is worth nothing). Descriptors are cleared. Returns how many of each.
   */
  sweepDownloads(now: number, maxAgeMs: number): Promise<{ readonly invalid: number; readonly expired: number }>
}

/**
 * Why one download did not give a file.
 * - permanent: it never will (too big, a format that is not audio, media expired on the server, the folder is full...).
 * - transient: it may work next time (the network, a timeout, the disk). Counted: after `maxAttempts` it is permanent.
 * - unavailable: nothing can be tried now (no connection, or it was stopped): not the fault of the audio, not counted.
 */
export type DownloadFailure = {
  readonly kind: 'permanent' | 'transient' | 'unavailable'
  /** A fixed code ("too-large", "timeout"...). Never a message, never anything of the descriptor. */
  readonly reason: string
}

/** Downloads one audio into the media store and says where the file is (the media reference). */
export interface AudioDownloader {
  download(item: PendingDownload): Promise<Result<string, DownloadFailure>>
  /** Aborts the download in progress, if any: its answer is `unavailable`. */
  abort(): void
}
