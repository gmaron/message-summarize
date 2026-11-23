import type { CaptureMessages } from '../application/capture-messages.js'
import type { DownloadOutcome } from '../application/download-audios.js'
import type { HistoryProgressReport, SocketFactory } from '../infrastructure/whatsapp/connection.js'
import type { DaemonConnection } from './daemon.js'
import type { Runtime } from './runtime.js'

/** The connection as the commands use it: the daemon's view plus deleting the stored session. */
export interface ManagedConnection extends DaemonConnection {
  /** Stops and deletes the stored session, so the account can be linked again. */
  clearSession(): Promise<void>
}

export interface ConnectionHooks {
  /** A fixed code for something that went wrong inside the adapter. Never chat content (RNF-04). */
  onWarning(code: string, detail?: { readonly event?: string; readonly step?: string }): void
  /** Counts of what the adapter received, stored and dropped (numbers only), while connected and only when they changed. */
  readonly onStats?: (stats: Readonly<Record<string, number>>) => void
  /** Counts of a stored chunk of history (any sync type): numbers only. Logged as `history.progress`. */
  readonly onHistoryProgress?: (report: HistoryProgressReport) => void
  /** How many messages arrived undecryptable since the last report (at most one per minute). */
  readonly onUndecryptable?: (count: number) => void
  /** Told about every audio download attempt (a fixed word), for logs. Never anything of the audio. */
  readonly onDownload?: (outcome: DownloadOutcome) => void
  /** Replaces the capture use case of the runtime (`link` counts events to know when the history is in). */
  readonly capture?: CaptureMessages
  /**
   * False: the connection only captures and queues the audios, and never downloads or transcribes one (`msum link`:
   * the daemon's worker downloads them later, so there is one whisper per installation and the link stays short).
   * Default true.
   */
  readonly downloadAudios?: boolean
}

export type ConnectionFactory = (runtime: Runtime, hooks: ConnectionHooks) => Promise<ManagedConnection>

/**
 * The real WhatsApp connection of the runtime's account. The adapter (and Baileys with it) is loaded here and only
 * when a command needs a connection, so `digest`, `status` and `doctor` start fast and never touch the network.
 */
export const createWhatsAppConnectionFor: ConnectionFactory = (runtime, hooks) =>
  connectionFactoryWith(undefined)(runtime, hooks)

/**
 * The same, over another socket (a fake one, for tests): everything else, including the audio download worker and its
 * wiring to the runtime, is the real one.
 */
export const connectionFactoryWith =
  (socketFactory: SocketFactory | undefined): ConnectionFactory =>
  async (runtime, hooks) => {
    const { createWhatsAppConnection } = await import('../infrastructure/whatsapp/index.js')
    const connection = createWhatsAppConnection({
      ...(socketFactory === undefined ? {} : { socketFactory }),
      authDir: runtime.layout.authDir,
      language: runtime.config.language,
      capture: hooks.capture ?? runtime.capture,
      clock: runtime.clock,
      ownIds: runtime.ownIds,
      storedConversationName: async (id) => (await runtime.repository.findConversation(id))?.name,
      onWarning: hooks.onWarning,
      ...(hooks.onStats === undefined ? {} : { onStats: hooks.onStats }),
      ...(hooks.onHistoryProgress === undefined ? {} : { onHistoryProgress: hooks.onHistoryProgress }),
      ...(hooks.onUndecryptable === undefined ? {} : { onUndecryptable: hooks.onUndecryptable }),
      // Opt-in, owner-approved exception to RNF-17: the phone sends its whole history when the device is linked.
      ...(runtime.config.fullHistoryOnLink ? { fullHistory: true } : {}),
      // Audios are downloaded only when something will transcribe them (RF-15, RF-21). The queue is the account database.
      ...(runtime.transcription.enabled
        ? {
            media: {
              mediaDir: runtime.layout.mediaDir,
              queue: runtime.downloadQueue,
              ...(hooks.downloadAudios === false ? { worker: false } : {}),
              maxDirBytes: runtime.config.transcription.maxMediaMb * 1024 * 1024,
              concurrency: runtime.config.transcription.downloadConcurrency,
              // A file that was stored joins the transcription queue: the daemon's transcription starts at once.
              onDownloaded: () => runtime.transcription.kick(),
              // With a full history downloads outpace whisper: no new download is claimed while this many files wait
              // for a transcriber, and the pool is woken again when a transcription frees its file (see below).
              awaiting: async () => {
                const stats = await runtime.audioQueueStats()
                return stats.pending + stats.running
              },
              maxAwaiting: 4 * runtime.config.transcription.concurrency,
              ...(hooks.onDownload === undefined ? {} : { onOutcome: hooks.onDownload }),
            },
          }
        : {}),
    })
    // A transcription that frees its file (or the room the folder had run out of) wakes the download worker.
    runtime.onMediaFreed(() => connection.kickDownloads?.())
    return connection
  }
