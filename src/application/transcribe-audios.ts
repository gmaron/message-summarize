import type { StartDeadline } from './ports/deadline.js'
import type { Transcriber } from './ports/transcriber.js'
import type {
  ClaimOrder,
  PendingAudio,
  TimeRange,
  TranscriptionClaims,
  TranscriptionStore,
} from './ports/transcription-store.js'
import { createTranscriptionSlot, type TranscriptionSlot } from './transcription-slot.js'
import { createWorkerPool } from './worker-pool.js'

/** What happened to one audio. `error` is a failure of the store (for example a closed database), not of the audio. */
export type TranscriptionOutcome = 'transcribed' | 'failed' | 'timeout' | 'unavailable' | 'error'

export interface TranscribeAudiosDeps {
  readonly store: TranscriptionStore & TranscriptionClaims
  /** Null: transcription is off (RF-21). Nothing is queued, waited for or run, and audios stay untranscribed. */
  readonly transcriber: Transcriber | null
  /** `auto`, or an ISO code (RF-23). */
  readonly language: string
  /** Absolute path of the file behind a media reference. */
  readonly mediaPath: (mediaRef: string) => string
  readonly startDeadline: StartDeadline
  /** Told about every audio that was handled, for logs and tests. */
  readonly onOutcome?: (outcome: TranscriptionOutcome) => void
  /** How many transcriptions run at once (`transcription.concurrency`). Default 1. */
  readonly concurrency?: number
  /**
   * Where the work runs. Share ONE slot between every account of the process, so no more than its limit run at a time
   * whatever the number of accounts (RNF-09). Default: a slot of its own, with the limit `concurrency`.
   */
  readonly slot?: TranscriptionSlot
  /**
   * Deletes the file of an audio once its transcript is stored or it failed for good: what is kept is the text (RF-15).
   * Not called while the audio may be tried again. A failure to delete is ignored.
   */
  readonly deleteMedia?: (mediaRef: string) => Promise<void>
  /**
   * Asked before an IMAGE is read: false means this image must not be read now (its conversation is local-only: reading
   * needs a model that is not on this machine). It fails for good as `not-allowed` and its file is deleted. Never asked
   * for an audio, which never leaves the machine. Absent: every image is read.
   */
  readonly mayRead?: (item: PendingAudio) => Promise<boolean>
  /** How often `observeOnly` looks at the queue. Default 1 second. */
  readonly observePollMs?: number
  /**
   * Asked before each step of `prepareWindow` when it transcribes by itself: true when another process (the daemon) owns
   * the transcription now. From then on this call only waits for it, with the time that is left (RNF-09).
   */
  readonly mustObserve?: () => Promise<boolean>
}

export interface PrepareOptions {
  /**
   * Do not transcribe: only wait (at most `maxWaitMs`) for someone else to do it, looking at the queue now and then. For
   * a process that is not the daemon while a daemon runs: the daemon owns the transcription.
   */
  readonly observeOnly?: boolean
}

export interface PrepareReport {
  /** How many audios this call handled: transcribed, or failed for good. */
  readonly handled: number
  /** How many audios of the range are still pending. */
  readonly remaining: number
}

/**
 * Transcription of the audios that capture downloaded (RF-15, RF-20, RF-21).
 *
 * At most `concurrency` audios at a time (RNF-09, default 1): a whisper run is the heaviest thing the program does, so
 * every step goes through the slot, whoever asks. The queue is the database: a worker CLAIMS the next pending audio
 * (marked in progress in one step, so no audio is handed to two workers) and gives it back if the transcription did not
 * happen. Claims are reset when the process starts (`releaseAllClaims`), so a restart resumes where it was. Two callers:
 * - `kick`: the background queue. A pool of `concurrency` workers works through every pending audio, NEWEST first (what
 *   just arrived is read first), and stops when none is left. The daemon kicks it when an audio arrives and now and then.
 * - `prepareWindow`: right before a digest. It works only on the audios of the digest window, oldest first, and gives up
 *   waiting after `maxWaitMs`. What is not done stays pending, and the background queue goes on with it.
 *
 * When the transcriber says it is unavailable (a program or the model is missing) a run stops at once and the audio stays
 * pending: the digest then shows it as not transcribed and everything else works (RF-21).
 */
export interface TranscribeAudios {
  /** False when there is no transcriber. */
  readonly enabled: boolean
  /**
   * Run once when the process starts, before the first `kick`: an audio that was in progress when the previous process
   * died is pending again. Returns how many were. Do not call it from a process that is not the owner of the queue.
   */
  recover(): Promise<number>
  /** Starts the background queue unless it is running. Returns at once. */
  kick(): void
  /** Resolves when the background queue is not running. */
  idle(): Promise<void>
  /** Transcribes the pending audios of `range`, oldest first, waiting at most `maxWaitMs`. */
  prepareWindow(range: TimeRange, maxWaitMs: number, options?: PrepareOptions): Promise<PrepareReport>
  /** Refuses new work, kills what is running (the audio stays pending) and waits for the queue to settle. */
  stop(): Promise<void>
}

export function createTranscribeAudios(deps: TranscribeAudiosDeps): TranscribeAudios {
  const { store, transcriber } = deps
  const report = (outcome: TranscriptionOutcome): void => deps.onOutcome?.(outcome)

  let stopped = false
  const concurrency = Math.max(1, Math.floor(deps.concurrency ?? 1))
  // Every step goes through the slot, which runs at most its limit at a time: this is what bounds the concurrency. A step is tracked
  // from the moment it RUNS (not while it waits its turn in a slot shared with other accounts), so `stop` waits for the
  // work of this account that is really going on and never for the work of another one.
  const slot = deps.slot ?? createTranscriptionSlot(concurrency)
  const inFlight = new Set<Promise<unknown>>()
  const exclusive = <T>(work: () => Promise<T>): Promise<T> =>
    slot.run(async () => {
      const running = work()
      const tracked = running.catch(() => undefined)
      inFlight.add(tracked)
      try {
        return await running
      } finally {
        inFlight.delete(tracked)
      }
    })
  const dropMedia = async (mediaRef: string): Promise<void> => {
    try {
      await deps.deleteMedia?.(mediaRef)
    } catch {
      // a file that cannot be deleted is not a failure of the transcription
    }
  }

  /** Handles ONE audio. 'done': one was handled, go on. 'stop': nothing left, or it cannot go on now. */
  async function step(range: TimeRange | undefined, order: ClaimOrder): Promise<'done' | 'stop'> {
    if (transcriber === null || stopped) return 'stop'
    let claimed: { conversationId: string; messageId: string } | null = null
    /** The audio goes back to the queue: the transcription did not happen. */
    const giveBack = async (): Promise<void> => {
      if (claimed === null) return
      const { conversationId, messageId } = claimed
      claimed = null
      try {
        await store.releaseClaim(conversationId, messageId)
      } catch {
        // a store that fails here is closed; the claim is reset at the next start
      }
    }
    try {
      const next = await store.claimPending(range, order)
      if (next === null) return 'stop'
      claimed = next
      if (next.kind === 'image' && deps.mayRead !== undefined && !(await deps.mayRead(next))) {
        // Not an error and not a failure of the image: the owner keeps this conversation on this machine.
        await store.fail(next.conversationId, next.messageId, 'not-allowed')
        report('failed')
        await dropMedia(next.mediaRef)
        return 'done'
      }
      const result = await transcriber.transcribe({
        audioPath: deps.mediaPath(next.mediaRef),
        language: deps.language,
        ...(next.kind === 'image' ? { kind: 'image' as const, caption: next.caption } : {}),
      })
      // Stopped meanwhile: the process was killed, so the result says nothing about the audio. It stays pending.
      if (stopped) {
        await giveBack()
        return 'stop'
      }
      if (result.ok) {
        // Only the one that stored the transcript deletes the file: if another process finished it first, it is theirs.
        const stored = await store.complete(next.conversationId, next.messageId, result.value)
        report('transcribed')
        if (stored) await dropMedia(next.mediaRef)
        return 'done'
      }
      const failure = result.error
      if (failure.kind === 'unavailable') {
        await giveBack()
        report('unavailable')
        return 'stop'
      }
      await store.fail(next.conversationId, next.messageId, failure.kind === 'timeout' ? 'timeout' : failure.reason)
      report(failure.kind === 'timeout' ? 'timeout' : 'failed')
      await dropMedia(next.mediaRef) // failed for good: the file is of no use any more
      return 'done'
    } catch {
      await giveBack()
      report('error')
      return 'stop'
    }
  }

  const background = createWorkerPool({
    size: concurrency,
    isStopped: () => stopped,
    step: () => exclusive(() => step(undefined, 'newest')),
  })

  return {
    enabled: transcriber !== null,

    kick() {
      if (transcriber === null) return
      background.kick()
    },

    idle: () => background.idle(),

    recover: () => store.releaseAllClaims(),

    async prepareWindow(range, maxWaitMs, options) {
      if (transcriber === null || stopped) return { handled: 0, remaining: 0 }
      const deadline = deps.startDeadline(maxWaitMs)
      let over = false
      void deadline.expired.then(() => {
        over = true
      })
      /** The daemon owns the transcription: look at the queue until its work on this window is done, or the time is up. */
      const observe = async (): Promise<void> => {
        try {
          while (!over && !stopped && (await store.countPending(range)) > 0) {
            const tick = deps.startDeadline(deps.observePollMs ?? 1_000)
            await Promise.race([tick.expired, deadline.expired])
            tick.cancel()
          }
        } catch {
          report('error')
        }
      }
      if (options?.observeOnly === true) {
        await observe()
        deadline.cancel()
        let left = 0
        try {
          left = await store.countPending(range)
        } catch {
          report('error')
        }
        return { handled: 0, remaining: left }
      }
      let waiting = true
      let switched = false
      let handled = 0
      /** Asked before EVERY step: a daemon that started meanwhile owns the transcription from then on. */
      const daemonAppeared = async (): Promise<boolean> => {
        if (deps.mustObserve === undefined) return false
        try {
          return await deps.mustObserve()
        } catch {
          return false
        }
      }
      // The same number of workers as the background queue; they claim the OLDEST audio of the window first.
      const worker = async (): Promise<void> => {
        // `waiting` is read again when the step's turn comes, so no new audio starts after the deadline.
        while (
          waiting &&
          (await exclusive(async () => {
            if (!waiting) return 'stop' as const
            if (await daemonAppeared()) {
              switched = true
              return 'stop' as const
            }
            return step(range, 'oldest')
          })) === 'done'
        ) {
          handled++
        }
      }
      const work = Promise.all(Array.from({ length: concurrency }, worker))
      await Promise.race([work.catch(() => undefined), deadline.expired])
      waiting = false
      // Switched to observing: wait for the daemon with what is left of the same time.
      if (switched && !over) await observe()
      deadline.cancel()
      let remaining = 0
      try {
        remaining = await store.countPending(range)
      } catch {
        report('error')
      }
      return { handled, remaining }
    },

    async stop() {
      stopped = true
      await transcriber?.close?.().catch(() => undefined)
      // Only what is running now. A loop still waiting for its turn in a shared slot ends by itself when it gets there:
      // `step` sees `stopped` and does not touch the store or the transcriber.
      await Promise.all([...inFlight])
    },
  }
}
