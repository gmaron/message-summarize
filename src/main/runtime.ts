import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type AskChats, createAskChats } from '../application/ask-chats.js'
import { type CaptureMessages, createCaptureMessages } from '../application/capture-messages.js'
import { createGenerateDigest, type GenerateDigest } from '../application/generate-digest.js'
import type { AccountIdentity } from '../application/ports/account-identity.js'
import type { Answerer } from '../application/ports/answerer.js'
import type { AskHistory } from '../application/ports/ask-history.js'
import type { CaptureRepository } from '../application/ports/capture-repository.js'
import type { Clock } from '../application/ports/clock.js'
import type { StartDeadline } from '../application/ports/deadline.js'
import type { DownloadQueue } from '../application/ports/download-queue.js'
import type { OutboxRepository, OwnChatQueue } from '../application/ports/outbox.js'
import type { Renderers } from '../application/ports/rendering.js'
import type { Summarizer } from '../application/ports/summarizer.js'
import type { Transcriber } from '../application/ports/transcriber.js'
import type { AudioQueueStats } from '../application/ports/transcription-store.js'
import {
  createTranscribeAudios,
  type TranscribeAudios,
  type TranscriptionOutcome,
} from '../application/transcribe-audios.js'
import {
  createTranscriptionSlot,
  type LimitedTranscriptionSlot,
  type TranscriptionSlot,
} from '../application/transcription-slot.js'
import type { SummaryWindow } from '../domain/window.js'
import { getCatalog } from '../infrastructure/i18n/index.js'
import {
  type Database,
  openDatabase,
  SqliteAccountIdentity,
  SqliteAskHistory,
  SqliteCaptureRepository,
  SqliteCaptureWriter,
  SqliteDigestRuns,
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
import { buildAnswerer, buildSummarizer } from './providers.js'

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
export const processTranscriptionSlot = createTranscriptionSlot()

export interface RuntimeOptions {
  /** The paths of the account this runtime works on. */
  readonly layout: AccountLayout
  readonly config: AppConfig
  readonly env: NodeJS.ProcessEnv
  /** The ONE clock of the process: the capture use case, the stores and the digest all read it. */
  readonly clock?: Clock
  /** Replaces the configured providers. For tests. */
  readonly summarizer?: Summarizer | null
  /** The free-text answerer of the Ask tab. Without it (and without a provider chosen) there is no Ask. For tests. */
  readonly answerer?: Answerer | null
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
  /** The configuration in force now: `reconfigure` swaps it. A digest in progress keeps the one it started with. */
  readonly config: AppConfig
  readonly clock: Clock
  readonly renderers: Renderers
  readonly db: Database
  readonly store: SqliteDigestStore
  /** The history of digest runs (RF-74). */
  readonly runs: SqliteDigestRuns
  readonly outbox: OutboxRepository & OwnChatQueue
  /** The persistent history of the Ask tab (the latest 50 requests). */
  readonly askHistory: AskHistory
  readonly identity: AccountIdentity
  readonly repository: CaptureRepository
  readonly capture: CaptureMessages
  /** The ids of the owner's own chat: filled by the connection, and seeded from the bound account. */
  readonly ownIds: OwnConversationIds
  /** The transcription queue of the account (RF-15). `enabled` is false when transcription is off or has no transcriber. */
  readonly transcription: TranscribeAudios
  /** The durable queue of audio downloads (RF-15, RNF-08): the connection's download worker works through it. */
  readonly downloadQueue: DownloadQueue
  /** Told when an audio file was deleted from the media folder (its transcription is over): room for more downloads. */
  onMediaFreed(listener: () => void): void
  /** Counts of the audio queues, for the progress log (counts only). */
  audioQueueStats(): Promise<AudioQueueStats>
  /** Null when no provider was chosen. */
  readonly generateDigest: GenerateDigest | null
  /** The free requests over the chats (the "Ask" tab): read only, with the same providers as the digest. Null when no provider was chosen. */
  readonly askChats: AskChats | null
  /**
   * Applies another configuration to the running account without touching the connection or the database: the
   * renderers (language, time zone), the summarizer and the digest use case are built again from it (the summarizer by
   * `buildSummarizer`, so the local-only router stays outermost), and capture reads the new exclusion patterns on its
   * next event. A digest already running keeps what it started with.
   */
  reconfigure(config: AppConfig): void
  close(): void
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const { layout, env } = options
  const clock = options.clock ?? systemClock
  const now = (): number => clock.now()
  let config = options.config

  const db = openDatabase(layout.dbFile)
  try {
    const store = new SqliteDigestStore(db, now)
    const runs = new SqliteDigestRuns(db)
    const identity = new SqliteAccountIdentity(db, now)
    const repository = new SqliteCaptureRepository(new SqliteCaptureWriter(db, now))
    const source = new SqliteDigestSource(db)

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
              threads: settings.threads,
              env,
            })
          : null
    const queues = new SqliteTranscriptionStore(db)
    const mediaFreed = new Set<() => void>()
    // The process slot allows as many transcriptions at once as the most demanding account asks for.
    const slot = options.transcriptionSlot ?? processTranscriptionSlot
    if ('setLimit' in slot && 'limit' in slot) {
      const limited = slot as LimitedTranscriptionSlot
      limited.setLimit(Math.max(limited.limit, settings.concurrency))
    }
    const transcription = createTranscribeAudios({
      store: queues,
      transcriber,
      language: settings.language,
      mediaPath: (mediaRef) => join(layout.mediaDir, mediaRef),
      startDeadline: options.startDeadline ?? systemDeadline,
      slot,
      concurrency: settings.concurrency,
      ...(options.daemonRunning === undefined || options.transcriptionMode === 'observe'
        ? {}
        : { mustObserve: options.daemonRunning }),
      ...(options.transcriptionPollMs === undefined ? {} : { observePollMs: options.transcriptionPollMs }),
      // What is kept is the text: the audio file goes once it is transcribed, or failed for good.
      deleteMedia: async (mediaRef) => {
        await rm(join(layout.mediaDir, mediaRef), { force: true })
        for (const listener of [...mediaFreed]) listener()
      },
      ...(options.onTranscription === undefined ? {} : { onOutcome: options.onTranscription }),
    })

    const capture = createCaptureMessages({
      repository,
      clock,
      // Read through `config` on every event: a reconfiguration applies to the next message.
      excludePatterns: () => config.digest.excludePatterns,
      ownConversationIds: () => ownIds.get(),
      // History audios of the last N days are downloaded too (RF-15), when transcription is on (the adapter only
      // downloads then). Older ones stay untranscribed.
      audioHistoryDays: settings.historyAudioDays,
    })

    // A summarizer given in the options (tests) is fixed: a reconfiguration does not replace it. The audio wait is not
    // part of the configuration that changes live: it is wired the same way for every rebuilt digest use case.
    const makeParts = (
      next: AppConfig,
    ): { renderers: Renderers; generateDigest: GenerateDigest | null; askChats: AskChats | null } => {
      const renderers = createRenderers(next.language, next.timezone)
      const summarizer =
        options.summarizer === undefined
          ? buildSummarizer(next, env, layout, () => config.localOnlyPatterns)
          : options.summarizer
      const catalog = getCatalog(next.language)
      const answerer = options.answerer === undefined ? buildAnswerer(next, env, layout) : options.answerer
      return {
        renderers,
        askChats:
          answerer === null
            ? null
            : createAskChats({
                source,
                answerer,
                renderers,
                texts: catalog.ask,
                ownerNameFallback: catalog.promptOwnerName,
                ownConversationIds: () => ownIds.get(),
                // Read through `config` on every request: a mark made meanwhile applies to the next one.
                localOnlyPatterns: () => config.localOnlyPatterns,
              }),
        generateDigest:
          summarizer === null
            ? null
            : createGenerateDigest({
                source,
                summarizer,
                store,
                clock,
                renderers,
                ownConversationIds: () => ownIds.get(),
                // The audios of the window are transcribed first, with a bounded wait (RF-15). Off: nothing to wait for.
                ...(transcription.enabled
                  ? {
                      beforeWindow: async (window: SummaryWindow) => {
                        // A transcript is captured data (like a message), not a result of the digest: it is stored
                        // whether the digest is a preview or not, and it never touches the pointer or the history (RF-64).
                        await transcription.prepareWindow(
                          { from: window.since, until: window.until },
                          options.transcriptionWaitMs ?? DIGEST_TRANSCRIPTION_WAIT_MS,
                          { observeOnly: options.transcriptionMode === 'observe' },
                        )
                      },
                    }
                  : {}),
              }),
      }
    }
    let parts = makeParts(config)

    return {
      layout,
      get config() {
        return config
      },
      clock,
      get renderers() {
        return parts.renderers
      },
      db,
      store,
      runs,
      outbox: new SqliteOutboxRepository(store),
      askHistory: new SqliteAskHistory(db),
      identity,
      repository,
      capture,
      ownIds,
      transcription,
      downloadQueue: queues,
      onMediaFreed: (listener) => {
        mediaFreed.add(listener)
      },
      audioQueueStats: () => queues.audioQueueStats(),
      get generateDigest() {
        return parts.generateDigest
      },
      get askChats() {
        return parts.askChats
      },
      reconfigure: (next) => {
        // Built before anything is swapped: if it throws, the runtime keeps the configuration it had.
        const rebuilt = makeParts(next)
        config = next
        parts = rebuilt
      },
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
