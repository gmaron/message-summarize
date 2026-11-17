import type { Clock } from './ports/clock.js'
import type { AudioDownloader, DownloadQueue } from './ports/download-queue.js'

/** What happened to one audio. `error` is a failure of the store (for example a closed database), not of the audio. */
export type DownloadOutcome = 'downloaded' | 'failed' | 'retry' | 'unavailable' | 'error'

export const DEFAULT_MAX_DOWNLOAD_ATTEMPTS = 5

/** An audio still waiting to be downloaded this long after its message fails as `expired` (WhatsApp media is long gone). */
export const DOWNLOAD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Wait before the next try of an audio that failed for a moment: 30 s, 1 min, 2 min, 4 min... (`attempts` counts this one). */
export function downloadBackoffMs(attempts: number): number {
  return 30_000 * 2 ** Math.max(0, attempts - 1)
}

export interface DownloadAudiosDeps {
  readonly queue: DownloadQueue
  readonly downloader: AudioDownloader
  readonly clock: Clock
  /** Transient failures of one audio before it fails for good. Default 5. */
  readonly maxAttempts?: number
  /** Called after a file was stored, so the transcription queue can start. */
  readonly onDownloaded?: () => void
  /** Told about every attempt, for logs and tests. */
  readonly onOutcome?: (outcome: DownloadOutcome) => void
}

/**
 * The download worker of an account (RF-15, RNF-08): works through the durable download queue, ONE audio at a time,
 * oldest first, so memory holds one row whatever the length of the queue (a first link can bring hundreds of audios).
 *
 * - Success: the file is stored and the audio moves to the transcription queue.
 * - A permanent failure (too big, not audio, expired on the server, folder full...): recorded, never tried again.
 * - A transient failure (network, timeout, disk): the audio stays in the queue with one more attempt and a BACKOFF (30 s,
 *   1 min, 2 min, 4 min): it is not due before that, so a burst of kicks cannot use up its attempts and the audios behind
 *   it go on. After `maxAttempts` it fails for good.
 * - Unavailable (no connection) or stopped: nothing is recorded and nothing is counted: the audio is asked for again
 *   when the connection is back, after a restart, on the next sweep.
 *
 * `kick` starts a run unless one is going; a kick during a run makes it look once more. `stop` aborts the download in
 * progress and resolves when the worker is idle, so nothing of the account is left open and nothing writes to a database
 * that is about to be closed.
 */
export interface DownloadAudios {
  /** Starts a run unless one is going. Returns at once. */
  kick(): void
  /** Resolves when no run is going. */
  idle(): Promise<void>
  /** Refuses new work, aborts the download in progress (its audio stays queued) and waits for the worker to settle. */
  stop(): Promise<void>
}

export function createDownloadAudios(deps: DownloadAudiosDeps): DownloadAudios {
  const { queue, downloader } = deps
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_DOWNLOAD_ATTEMPTS
  const report = (outcome: DownloadOutcome): void => deps.onOutcome?.(outcome)

  let stopped = false
  let background: Promise<void> | null = null
  let again = false

  /** ONE audio. 'done': go on with the next. 'stop': nothing left, or this run must end. */
  async function step(): Promise<'done' | 'stop'> {
    if (stopped) return 'stop'
    try {
      const next = await queue.nextDownload(deps.clock.now())
      if (next === null) return 'stop'
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
        report('unavailable')
        return 'stop'
      }
      if (failure.kind === 'permanent') {
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
      report('error')
      return 'stop'
    }
  }

  return {
    kick() {
      if (stopped) return
      if (background !== null) {
        again = true
        return
      }
      background = (async () => {
        try {
          do {
            again = false
            while ((await step()) === 'done') {
              // next audio
            }
          } while (again && !stopped)
        } finally {
          background = null
        }
      })()
    },

    idle: async () => {
      while (background !== null) await background
    },

    async stop() {
      stopped = true
      downloader.abort()
      while (background !== null) await background
    },
  }
}
