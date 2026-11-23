import type { Clock } from './ports/clock.js'
import type { AudioDownloader, DownloadQueue, PendingDownload } from './ports/download-queue.js'
import { createWorkerPool, type StepResult } from './worker-pool.js'

/** What happened to one audio. `error` is a failure of the store (for example a closed database), not of the audio. */
export type DownloadOutcome =
  | 'downloaded'
  | 'failed'
  | 'retry'
  | 'unavailable'
  | 'error'
  /** The server no longer has the media: the phone is asked to upload it again. */
  | 'reupload-requested'
  /** The phone uploaded it again: the download goes on with the new place. */
  | 'reuploaded'
  /** The phone did not answer: asked again later. */
  | 'reupload-retry'

export const DEFAULT_MAX_DOWNLOAD_ATTEMPTS = 5

/** How long a claimed audio is left alone: a download has 60 s, a re-upload request 45 s. A worker that died loses nothing. */
export const CLAIM_LEASE_MS = 2 * 60_000

/** Requests to the phone to upload an old media again: at most one STARTS per this many ms. */
export const REUPLOAD_MIN_INTERVAL_MS = 2_000
/** How many times the phone is asked for ONE media before it fails for good as `expired`. */
export const MAX_REUPLOAD_ATTEMPTS = 4
/** Requests to the phone that may wait for an answer at once (they still START at most one per interval). */
export const REUPLOAD_CONCURRENCY = 4

/** Wait before the next try of an audio that failed for a moment: 30 s, 1 min, 2 min, 4 min... (`attempts` counts this one). */
export function downloadBackoffMs(attempts: number): number {
  return 30_000 * 2 ** Math.max(0, attempts - 1)
}

/** Wait before asking the phone again for a media it did not answer: 1 min, 4 min, 16 min (`attempts` counts this one). */
export function reuploadBackoffMs(attempts: number): number {
  return 60_000 * 4 ** Math.max(0, attempts - 1)
}

export interface DownloadAudiosDeps {
  readonly queue: DownloadQueue
  readonly downloader: AudioDownloader
  readonly clock: Clock
  /** Transient failures of one audio before it fails for good. Default 5. */
  readonly maxAttempts?: number
  /** Downloads that run at once (`transcription.downloadConcurrency`). Default 1. */
  readonly concurrency?: number
  /** Called after a file was stored, so the transcription queue can start. */
  readonly onDownloaded?: () => void
  /** Told about every attempt, for logs and tests. */
  readonly onOutcome?: (outcome: DownloadOutcome) => void
  /** Minimum time between the starts of two re-upload requests. Default `REUPLOAD_MIN_INTERVAL_MS`. */
  readonly reuploadIntervalMs?: number
  /** Re-upload requests per audio before it fails as `expired`. Default `MAX_REUPLOAD_ATTEMPTS`. */
  readonly maxReuploadAttempts?: number
  /** Waits `ms` (spaces the requests to the phone). A real timer in the program; a test gives its own. */
  readonly wait: (ms: number) => Promise<void>
}

/**
 * The download workers of an account (RF-15, RNF-08): a pool of `concurrency` workers goes through the durable download
 * queue, oldest first, CLAIMING each audio (a lease in the database, so no two workers get the same one). Each worker
 * holds one row, so memory is bounded whatever the length of the queue (a full history brings thousands).
 *
 * - Success: the file is stored and the audio moves to the transcription queue.
 * - A permanent failure (too big, not audio...): recorded, never tried again.
 * - The server no longer has the media (404 or 410, `expired`): when the platform can do it and the key of the message was
 *   kept, the audio waits for the PHONE to upload it again. A second small pool asks for that: at most one request starts
 *   per `reuploadIntervalMs`, each waits for the phone's answer, and an audio is asked for at most `maxReuploadAttempts`
 *   times (with a backoff when the phone does not answer). When the phone answers, the download goes on with the new
 *   place; when it says the file is gone, or the attempts are over, the audio fails as `expired`. Waiting for the phone
 *   never holds a download worker.
 * - A transient failure (network, timeout, disk): the audio stays in the queue with one more attempt and a BACKOFF (30 s,
 *   1 min, 2 min, 4 min): it is not due before that, so a burst of kicks cannot use up its attempts and the audios behind
 *   it go on. After `maxAttempts` it fails for good.
 * - Unavailable (no connection) or stopped: nothing is recorded and nothing is counted: the claim is released and the
 *   audio is asked for again when the connection is back, after a restart, on the next sweep.
 *
 * `kick` tops the pools up; a kick during a run makes them look once more. `stop` aborts what is in progress and resolves
 * when the workers are idle, so nothing of the account is left open and nothing writes to a database that is about to be
 * closed.
 */
export interface DownloadAudios {
  /** Starts the workers unless they run. Returns at once. */
  kick(): void
  /** Resolves when no worker runs. */
  idle(): Promise<void>
  /** Refuses new work, aborts what is in progress (its audio stays queued) and waits for the workers to settle. */
  stop(): Promise<void>
}

export function createDownloadAudios(deps: DownloadAudiosDeps): DownloadAudios {
  const { queue, downloader } = deps
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_DOWNLOAD_ATTEMPTS
  const maxReuploadAttempts = deps.maxReuploadAttempts ?? MAX_REUPLOAD_ATTEMPTS
  const reuploadIntervalMs = deps.reuploadIntervalMs ?? REUPLOAD_MIN_INTERVAL_MS
  const { wait } = deps
  const report = (outcome: DownloadOutcome): void => deps.onOutcome?.(outcome)
  const reupload = downloader.requestReupload?.bind(downloader)

  let stopped = false
  // The start of the next re-upload request, reserved in one synchronous step: spacing holds however many workers ask.
  let nextReuploadStart = 0

  async function giveBack(item: PendingDownload): Promise<void> {
    try {
      await queue.releaseDownload(item.conversationId, item.messageId)
    } catch {
      // a store that fails here is closed: the lease runs out by itself
    }
  }

  /** ONE audio. 'done': go on with the next. 'stop': nothing left, or this run must end. */
  async function downloadStep(): Promise<StepResult> {
    if (stopped) return 'stop'
    let item: PendingDownload | null = null
    try {
      item = await queue.claimDownload(deps.clock.now(), CLAIM_LEASE_MS)
      if (item === null) return 'stop'
      const next = item
      const result = await downloader.download(next)
      if (result.ok) {
        // A file that was stored is ALWAYS recorded, even when stopping: the database is still open here (the owner waits
        // for `stop`), and a file with no record would be lost.
        await queue.completeDownload(next.conversationId, next.messageId, result.value)
        report('downloaded')
        deps.onDownloaded?.()
        return 'done'
      }
      const failure = result.error
      // Stopped meanwhile: the abort says nothing about the audio.
      if (stopped || failure.kind === 'unavailable') {
        await giveBack(next)
        report('unavailable')
        return 'stop'
      }
      if (failure.kind === 'permanent') {
        // The server forgot the media: the phone may still have it.
        if (
          failure.reason === 'expired' &&
          reupload !== undefined &&
          downloader.canRequestReupload?.() !== false &&
          next.descriptor.reuploadKey !== undefined &&
          next.reuploadAttempts < maxReuploadAttempts &&
          (await queue.markNeedsReupload(next.conversationId, next.messageId))
        ) {
          report('reupload-requested')
          reuploads.kick()
          return 'done'
        }
        await queue.failDownload(next.conversationId, next.messageId, failure.reason)
        report('failed')
        return 'done'
      }
      const failedAt = deps.clock.now()
      const outcome = await queue.retryDownload(
        next.conversationId,
        next.messageId,
        maxAttempts,
        (attempts) => failedAt + downloadBackoffMs(attempts),
      )
      report(outcome === 'failed' ? 'failed' : 'retry')
      // Not due again for a while, so the next one of the queue can go.
      return 'done'
    } catch {
      if (item !== null) await giveBack(item)
      report('error')
      return 'stop'
    }
  }

  /** ONE request to the phone. */
  async function reuploadStep(): Promise<StepResult> {
    if (stopped || reupload === undefined) return 'stop'
    let item: PendingDownload | null = null
    try {
      item = await queue.claimReupload(deps.clock.now(), CLAIM_LEASE_MS)
      if (item === null) return 'stop'
      const next = item
      // The start is reserved now, the wait happens after: two workers never get the same slot.
      const start = Math.max(deps.clock.now(), nextReuploadStart)
      nextReuploadStart = start + reuploadIntervalMs
      if (start > deps.clock.now()) await wait(start - deps.clock.now())
      if (stopped) {
        await giveBack(next)
        return 'stop'
      }
      const result = await reupload(next)
      if (result.ok) {
        await queue.completeReupload(next.conversationId, next.messageId, result.value)
        report('reuploaded')
        downloads.kick()
        return 'done'
      }
      const failure = result.error
      if (stopped || failure.kind === 'unavailable') {
        await giveBack(next)
        report('unavailable')
        return 'stop'
      }
      if (failure.kind === 'permanent') {
        // The phone no longer has the file either.
        await queue.failDownload(next.conversationId, next.messageId, 'expired')
        report('failed')
        return 'done'
      }
      const failedAt = deps.clock.now()
      const outcome = await queue.retryReupload(
        next.conversationId,
        next.messageId,
        maxReuploadAttempts,
        (attempts) => failedAt + reuploadBackoffMs(attempts),
      )
      report(outcome === 'failed' ? 'failed' : 'reupload-retry')
      return 'done'
    } catch {
      if (item !== null) await giveBack(item)
      report('error')
      return 'stop'
    }
  }

  const downloads = createWorkerPool({
    size: Math.max(1, Math.floor(deps.concurrency ?? 1)),
    isStopped: () => stopped,
    step: downloadStep,
  })
  const reuploads = createWorkerPool({
    size: REUPLOAD_CONCURRENCY,
    isStopped: () => stopped,
    step: reuploadStep,
  })

  return {
    kick() {
      if (stopped) return
      downloads.kick()
      // Also looks for audios that were waiting for the phone before a restart.
      if (reupload !== undefined) reuploads.kick()
    },

    idle: async () => {
      // A re-upload that is answered starts downloads again, and a download that finds a gone media starts requests.
      while (downloads.busy || reuploads.busy) await Promise.all([downloads.idle(), reuploads.idle()])
    },

    async stop() {
      stopped = true
      downloader.abort()
      while (downloads.busy || reuploads.busy) await Promise.all([downloads.idle(), reuploads.idle()])
    },
  }
}
