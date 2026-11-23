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
  /** How many times the phone was asked to upload this media again (bounded: see `MAX_REUPLOAD_ATTEMPTS`). */
  readonly reuploadAttempts: number
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
  /**
   * Like `nextDownload`, but for a pool of workers: the audio is CLAIMED in the same step, so no two workers get the same
   * one. A claim is a lease: the audio is not due again for `leaseMs` (then it is, so a worker that died loses nothing).
   * Whatever the worker records afterwards (done, failed, retry with a backoff, released) replaces the lease. Audios that
   * wait for the phone to upload them again are not handed out here (`claimReupload`). Null when nothing is due.
   */
  claimDownload(now: number, leaseMs: number): Promise<PendingDownload | null>
  /** Gives a claimed audio back, due at once. For work that did not happen (no connection, stopped). */
  releaseDownload(conversationId: string, messageId: string): Promise<void>
  /**
   * The server no longer has the media (it answered "gone"). If the phone can be asked to upload it again the audio waits
   * for that (`claimReupload`) instead of failing. False when it cannot be asked (the key of the message was not kept):
   * the caller then fails it as `expired`.
   */
  markNeedsReupload(conversationId: string, messageId: string): Promise<boolean>
  /** The oldest audio waiting for a re-upload that is due, claimed like `claimDownload`. Null when none. */
  claimReupload(now: number, leaseMs: number): Promise<PendingDownload | null>
  /**
   * The phone uploaded the media again: `directPath` is its new place. The audio is a normal download again, due at once,
   * and the re-upload attempts go up by one (so asking again and again is bounded).
   */
  completeReupload(conversationId: string, messageId: string, directPath: string): Promise<void>
  /**
   * The phone did not answer (or the request failed for a moment): the attempts go up by one and the audio is not due
   * again before `nextAttemptAt(attempts)`. At `maxAttempts` it fails for good as `expired`.
   */
  retryReupload(
    conversationId: string,
    messageId: string,
    maxAttempts: number,
    nextAttemptAt: (attempts: number) => number,
  ): Promise<RetryOutcome>
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
   * before: a key kept for it is worth nothing; `null`: no age limit, because an old media can be asked of the phone
   * again). Descriptors are cleared. Returns how many of each.
   */
  sweepDownloads(now: number, maxAgeMs: number | null): Promise<{ readonly invalid: number; readonly expired: number }>
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

/**
 * Downloads audios into the media store and says where each file is (the media reference). Several downloads may run at
 * once: an implementation must not share state between them.
 */
export interface AudioDownloader {
  /**
   * A media the server no longer has fails as `{ kind: 'permanent', reason: 'expired' }`: the worker then asks for a
   * re-upload when `requestReupload` exists.
   */
  download(item: PendingDownload): Promise<Result<string, DownloadFailure>>
  /**
   * Asks the owner's phone to upload the media again and answers with its new `directPath`. The request goes to the own
   * account only: nothing is sent to third parties. Absent: the platform cannot do it. Failures: `permanent` when the
   * phone says it no longer has the file, `transient` when it did not answer in time, `unavailable` without a connection.
   */
  requestReupload?(item: PendingDownload): Promise<Result<string, DownloadFailure>>
  /** False when `requestReupload` cannot work with the connection there is now (the platform has no such request). Default true. */
  canRequestReupload?(): boolean
  /** Aborts every download and request in progress: their answer is `unavailable`. */
  abort(): void
}
