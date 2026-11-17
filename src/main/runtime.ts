import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type CaptureMessages, createCaptureMessages } from '../application/capture-messages.js'
import { createGenerateDigest, type GenerateDigest } from '../application/generate-digest.js'
import type { AccountIdentity } from '../application/ports/account-identity.js'
import type { CaptureRepository } from '../application/ports/capture-repository.js'
import type { Clock } from '../application/ports/clock.js'
import type { StartDeadline } from '../application/ports/deadline.js'
import type { DownloadQueue } from '../application/ports/download-queue.js'
import type { OutboxRepository } from '../application/ports/outbox.js'
import type { Renderers } from '../application/ports/rendering.js'
import type { Summarizer } from '../application/ports/summarizer.js'
import type { Transcriber } from '../application/ports/transcriber.js'
import {
  createTranscribeAudios,
  type TranscribeAudios,
  type TranscriptionOutcome,
} from '../application/transcribe-audios.js'
import { createTranscriptionSlot, type TranscriptionSlot } from '../application/transcription-slot.js'
import type { SummaryWindow } from '../domain/window.js'
import {
  type Database,
  openDatabase,
  SqliteAccountIdentity,
  SqliteCaptureRepository,
  SqliteCaptureWriter,
  SqliteDigestSource,
  SqliteDigestStore,
  SqliteOutboxRepository,
  SqliteTranscriptionStore,
} from '../infrastructure/persistence/sqlite/index.js'
import { createRenderers } from '../infrastructure/rendering/index.js'
import { resolveModelPath, WhisperCppTranscriber } from '../infrastructure/transcription/index.js'
import { OwnConversationIds } from '../infrastructure/whatsapp/own-ids.js'
import type { AppConfig } from './config.js'
import type { AccountLayout } from './paths.js'
import { buildSummarizer } from './providers.js'

export const systemClock: Clock = { now: () => Date.now() }

/** A time limit on the real clock. */
export const systemDeadline: StartDeadline = (ms) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  return { expired, cancel: () => clearTimeout(timer) }
}

/** How long a digest waits for the audios of its window that are still pending (RF-15). What is left stays pending. */
export const DIGEST_TRANSCRIPTION_WAIT_MS = 2 * 60_000

/**
 * THE transcription slot of this process (RNF-09): every runtime uses it unless a test gives its own, so a daemon with N
 * accounts runs one whisper at a time, not N.
 */
export const processTranscriptionSlot: TranscriptionSlot = createTranscriptionSlot()

export interface RuntimeOptions {
  /** The paths of the account this runtime works on. */
  readonly layout: AccountLayout
  readonly config: AppConfig
  readonly env: NodeJS.ProcessEnv
  /** The ONE clock of the process: the capture use case, the stores and the digest all read it. */
  readonly clock?: Clock
  /** Replaces the configured providers. For tests. */
  readonly summarizer?: Summarizer | null
  /** Replaces the transcriber built from the configuration (null: none). For tests. */
  readonly transcriber?: Transcriber | null
  /** Replaces the real timers of the transcription wait. For tests. */
  readonly startDeadline?: StartDeadline
  /** How long a digest waits for pending audios. Default `DIGEST_TRANSCRIPTION_WAIT_MS`. */
  readonly transcriptionWaitMs?: number
  /** How often an observing process looks at the queue (see `transcriptionMode`). Default 1 second. */
  readonly transcriptionPollMs?: number
  /** Told about every audio the transcription handled (the daemon logs it). */
  readonly onTranscription?: (outcome: TranscriptionOutcome) => void
  /** Replaces the slot of the process (see `processTranscriptionSlot`). For tests. */
  readonly transcriptionSlot?: TranscriptionSlot
  /**
   * `own` (default): this process transcribes. `observe`: it does not; right before a digest it only waits for another
   * process (the daemon, which holds the lock of the installation) to transcribe the audios of the window. `msum digest`
   * uses it while a daemon runs, so two processes never run whisper on the same account.
   */
  readonly transcriptionMode?: 'own' | 'observe'
  /**
   * In `own` mode: asked before each transcription step, true when a daemon started meanwhile. This process then stops
   * transcribing and only waits for the daemon, with the time that is left (one whisper per installation, RNF-09).
   */
  readonly daemonRunning?: () => Promise<boolean>
}

/**
 * Everything that works on the account's database, wired once: the stores, the capture and digest use cases, the
 * renderers. It does NOT open a WhatsApp connection (the daemon and `link` add one on top of it), so `digest`, `status`
 * and `unlink` can use the database while the daemon owns the session.
 */
export interface Runtime {
  readonly layout: AccountLayout
  readonly config: AppConfig
  readonly clock: Clock
  readonly renderers: Renderers
  readonly db: Database
  readonly store: SqliteDigestStore
  readonly outbox: OutboxRepository
  readonly identity: AccountIdentity
  readonly repository: CaptureRepository
  readonly capture: CaptureMessages
  /** The ids of the owner's own chat: filled by the connection, and seeded from the bound account. */
  readonly ownIds: OwnConversationIds
  /** The transcription queue of the account (RF-15). `enabled` is false when transcription is off or has no transcriber. */
  readonly transcription: TranscribeAudios
  /** The durable queue of audio downloads (RF-15, RNF-08): the connection's download worker works through it. */
  readonly downloadQueue: DownloadQueue
  /** Null when no provider was chosen. */
  readonly generateDigest: GenerateDigest | null
  close(): void
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const { layout, config, env } = options
  const clock = options.clock ?? systemClock
  const now = (): number => clock.now()

  const db = openDatabase(layout.dbFile)
  try {
    const store = new SqliteDigestStore(db, now)
    const identity = new SqliteAccountIdentity(db, now)
    const repository = new SqliteCaptureRepository(new SqliteCaptureWriter(db, now))
    const renderers = createRenderers(config.language, config.timezone)

    const ownIds = new OwnConversationIds()
    const bound = identity.get()
    if (bound !== null) ownIds.set([bound])

    const { transcription: settings } = config
    const transcriber =
      options.transcriber !== undefined
        ? options.transcriber
        : settings.enabled
          ? new WhisperCppTranscriber({
              whisperCommand: settings.whisperCommand,
              ffmpegCommand: settings.ffmpegCommand,
              modelPath:
                settings.model === null
                  ? null
                  : resolveModelPath(layout.modelsDir, dirname(layout.modelsDir), settings.model),
              timeoutMs: settings.timeoutMs,
              env,
            })
          : null
    const queues = new SqliteTranscriptionStore(db)
    const transcription = createTranscribeAudios({
      store: queues,
      transcriber,
      language: settings.language,
      mediaPath: (mediaRef) => join(layout.mediaDir, mediaRef),
      startDeadline: options.startDeadline ?? systemDeadline,
      slot: options.transcriptionSlot ?? processTranscriptionSlot,
      ...(options.daemonRunning === undefined || options.transcriptionMode === 'observe'
        ? {}
        : { mustObserve: options.daemonRunning }),
      ...(options.transcriptionPollMs === undefined ? {} : { observePollMs: options.transcriptionPollMs }),
      // What is kept is the text: the audio file goes once it is transcribed, or failed for good.
      deleteMedia: (mediaRef) => rm(join(layout.mediaDir, mediaRef), { force: true }),
      ...(options.onTranscription === undefined ? {} : { onOutcome: options.onTranscription }),
    })

    const capture = createCaptureMessages({
      repository,
      clock,
      excludePatterns: () => config.digest.excludePatterns,
      ownConversationIds: () => ownIds.get(),
      // History audios of the last N days are downloaded too (RF-15), when transcription is on (the adapter only
      // downloads then). Older ones stay untranscribed.
      audioHistoryDays: settings.historyAudioDays,
    })

    const summarizer = options.summarizer === undefined ? buildSummarizer(config, env) : options.summarizer
    const generateDigest =
      summarizer === null
        ? null
        : createGenerateDigest({
            source: new SqliteDigestSource(db),
            summarizer,
            store,
            clock,
            renderers,
            ownConversationIds: () => ownIds.get(),
            // The audios of the window are transcribed first, with a bounded wait (RF-15). Off: nothing to wait for.
            ...(transcription.enabled
              ? {
                  beforeWindow: async (window: SummaryWindow) => {
                    // A transcript is captured data (like a message), not a result of the digest: it is stored whether
                    // the digest is a preview or not, and it never touches the pointer or the history (RF-64).
                    await transcription.prepareWindow(
                      { from: window.since, until: window.until },
                      options.transcriptionWaitMs ?? DIGEST_TRANSCRIPTION_WAIT_MS,
                      { observeOnly: options.transcriptionMode === 'observe' },
                    )
                  },
                }
              : {}),
          })

    return {
      layout,
      config,
      clock,
      renderers,
      db,
      store,
      outbox: new SqliteOutboxRepository(store),
      identity,
      repository,
      capture,
      ownIds,
      transcription,
      downloadQueue: queues,
      generateDigest,
      close: () => {
        // Kills a transcription that is running (its audio stays pending) before the database goes away.
        void transcription.stop()
        db.close()
      },
    }
  } catch (error) {
    db.close()
    throw error
  }
}
