import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { CaptureMessages } from '../../application/capture-messages.js'
import { createDownloadAudios, type DownloadAudios, type DownloadOutcome } from '../../application/download-audios.js'
import type { Clock } from '../../application/ports/clock.js'
import type { AudioDownloader, DownloadQueue } from '../../application/ports/download-queue.js'
import { err } from '../../domain/result.js'
import { getCatalog, type Language } from '../i18n/index.js'
import { type AudioDescriptor, type AudioFetcher, classifyFailure, createAudioFetcher } from './media.js'
import type { OwnConversationIds } from './own-ids.js'
import { createTranslator } from './translate.js'
import type { WaChat, WaContact, WaGroup, WaHistorySet, WaMessagesUpsert, WaMessageUpdate } from './wa-types.js'

/**
 * RF-04: the state of an account's link with WhatsApp.
 * - stopped: not started, or stopped on purpose.
 * - connecting: opening the connection.
 * - qr: waiting for the QR to be scanned. `qr` is a short-lived pairing credential: show it, never log it. A new one
 *   replaces it every time WhatsApp renews it (RF-01).
 * - connected.
 * - reconnecting: the connection dropped; the adapter retries after `delayMs` (RF-05). `reason` is a fixed word.
 * - loggedOut: the session was closed from the phone. The adapter does not retry, and `start()` keeps this state until
 *   `clearSession()` is called: the account must be linked again.
 * - error: the connection could not be started or must not be retried. `reason` is a fixed word, never an error
 *   message: 'socketFailed', 'forbidden' (403: do not insist) or 'replaced' (440: another session took over).
 */
export type WhatsAppStatus =
  | { readonly state: 'stopped' }
  | { readonly state: 'connecting' }
  | { readonly state: 'qr'; readonly qr: string }
  | { readonly state: 'connected' }
  | { readonly state: 'reconnecting'; readonly attempt: number; readonly delayMs: number; readonly reason: string }
  | { readonly state: 'loggedOut' }
  | { readonly state: 'error'; readonly reason: string }

export type WhatsAppStatusListener = (status: WhatsAppStatus) => void

/**
 * The only things the adapter uses of a socket. Deliberately narrow: no way to touch presence or to send read
 * receipts, and the one way to send (`sendTextToSelf`) can only reach the account's own chat. A new capability is a
 * new, equally narrow method here, never the raw socket.
 */
export interface WhatsAppSocket {
  readonly ev: {
    on(event: string, listener: (data: never) => void): unknown
    off(event: string, listener: (data: never) => void): unknown
  }
  /** The linked account, once there is one. `id` is the phone-number JID (with device), `lid` the LID. */
  readonly user?: { readonly id: string; readonly lid?: string | undefined } | undefined
  /** Closes the connection. */
  end(error: Error | undefined): void
  /**
   * The ONLY way to send. Sends a plain text message to the "message yourself" chat of the authenticated account. The
   * destination is computed inside from `user` (its phone-number JID, never the LID); there is no recipient
   * parameter. Rejects, sending nothing, when there is no authenticated phone-number user (RF-51).
   */
  sendTextToSelf(text: string): Promise<void>
  /** Read-only query of the subject of a group. */
  groupMetadata(jid: string): Promise<{ readonly subject?: string | undefined }>
  /**
   * Read-only: opens an audio, from its download descriptor, as a stream of its decrypted bytes (RF-15). It only
   * downloads, from WhatsApp's own media host. It never asks the sender to upload an expired media again, because that
   * would be a message out (RNF-17): such an audio is an error.
   */
  openAudio(descriptor: AudioDescriptor): Promise<Readable>
  readonly signalRepository?: {
    readonly lidMapping?: { getPNForLID(lid: string): Promise<string | null | undefined> } | undefined
  }
}

export interface SocketSession {
  readonly socket: WhatsAppSocket
  /** Persists the credentials. Called on every `creds.update`. */
  saveCreds(): Promise<void>
  /** Resolves when every write of the session (credentials and keys) that is in flight has finished. */
  settle(): Promise<void>
  /** The account stored in the session, known before the connection opens when it was linked already. */
  me(): { readonly id?: string | undefined; readonly lid?: string | undefined } | undefined
}

/** Creates a socket (and its authentication state) for one connection attempt. Baileys lives behind it. */
export type SocketFactory = (options: { readonly authDir: string }) => Promise<SocketSession>

export interface BackoffPolicy {
  readonly baseMs: number
  readonly maxMs: number
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1_000, maxMs: 60_000 }

export interface WhatsAppConnectionOptions {
  readonly authDir: string
  readonly language: Language
  readonly capture: CaptureMessages
  readonly clock: Clock
  readonly ownIds: OwnConversationIds
  readonly socketFactory: SocketFactory
  /** The stored name of a conversation (from the capture repository), so a group is asked about only if unnamed. */
  readonly storedConversationName?: (conversationId: string) => Promise<string | null | undefined>
  readonly backoff?: BackoffPolicy
  /** A fixed code for something that went wrong inside the adapter. Never chat content, never a secret. */
  readonly onWarning?: (code: string) => void
  /**
   * RF-15: download the audios the capture asks for (live ones, and those of the history within the configured days)
   * into `mediaDir`, from the DURABLE download queue `queue` (the database), one at a time. Without it no audio is
   * downloaded (the transcription is off).
   */
  readonly media?: {
    readonly mediaDir: string
    readonly queue: DownloadQueue
    /**
     * False: this connection only CAPTURES and queues the audios (the rows stay `download_pending`) and never downloads
     * one: `msum link` is short and must not compete with the daemon's worker (one whisper per installation, RNF-09).
     * Default true.
     */
    readonly worker?: boolean
    readonly maxBytes?: number
    readonly timeoutMs?: number
    /** The most the media directory may hold: past it, new downloads are refused (`media-cap`). */
    readonly maxDirBytes?: number
    /** Transient failures of one audio before it fails for good. Default 5. */
    readonly maxAttempts?: number
    /** Called after a file was stored: the transcription queue can start. */
    readonly onDownloaded?: () => void
    /** Told about every download attempt (a fixed word), for logs. */
    readonly onOutcome?: (outcome: DownloadOutcome) => void
  }
}

/** Baileys' `DisconnectReason`, for the ones that change what we do or what we say. */
const LOGGED_OUT = 401
const FORBIDDEN = 403
const REPLACED = 440
const REASONS: Readonly<Record<number, string>> = {
  408: 'connectionLost',
  411: 'multideviceMismatch',
  428: 'connectionClosed',
  500: 'badSession',
  503: 'unavailableService',
  515: 'restartRequired',
}

const statusCodeOf = (error: unknown): number | undefined => {
  const code = (error as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode
  return typeof code === 'number' ? code : undefined
}

/** Backoff before attempt `attempt` (1, 2, 3, ...): base, 2x, 4x, ... up to the maximum. */
export const backoffDelay = (policy: BackoffPolicy, attempt: number): number =>
  Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1))

/**
 * One account's link with WhatsApp (RF-01, RF-04, RF-05). It keeps the socket private and turns what the socket says
 * into (a) status events and (b) calls to the capture use case, through the pure translation.
 *
 * It is read only (RNF-17) except for one thing: the digest sent to the account's own chat, through `selfChat()`,
 * which `WhatsAppSelfChatDelivery` uses. It never sends anything else, never touches presence, never sends read
 * receipts, and the socket is created with `markOnlineOnConnect: false` (see `baileys-socket.ts`).
 *
 * Audios (RF-15): with `media` set it downloads the audios that arrive while connected, one at a time and in the
 * background. The download never asks the sender to upload an expired media again (that would be a message out): such
 * an audio is recorded as failed and shows as not transcribed.
 *
 * Events of a socket are processed one at a time in the order they arrived, so a history sync stays in order.
 */
export class WhatsAppConnection {
  private current: WhatsAppStatus = { state: 'stopped' }
  private readonly listeners = new Set<WhatsAppStatusListener>()
  private readonly translator
  private fetcher: AudioFetcher | null = null
  private worker: DownloadAudios | null = null
  private activeDownload: AbortController | null = null
  private session: SocketSession | null = null
  private detach: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private attempt = 0
  private running = false
  private loggedOut = false
  private readonly settling: Promise<void>[] = []
  private queue: Promise<void> = Promise.resolve()
  private readonly backoff: BackoffPolicy

  constructor(private readonly options: WhatsAppConnectionOptions) {
    this.backoff = options.backoff ?? DEFAULT_BACKOFF
    const media = options.media
    if (media !== undefined && media.worker !== false) {
      this.fetcher = createAudioFetcher({
        mediaDir: media.mediaDir,
        openAudio: async (descriptor) => {
          const session = this.session
          if (session === null) throw new Error('not connected')
          return session.socket.openAudio(descriptor)
        },
        ...(media.maxBytes === undefined ? {} : { maxBytes: media.maxBytes }),
        ...(media.timeoutMs === undefined ? {} : { timeoutMs: media.timeoutMs }),
        ...(media.maxDirBytes === undefined ? {} : { maxDirBytes: media.maxDirBytes }),
        // Nothing is stored for a connection that is closed or has dropped.
        isLive: () => this.session !== null,
      })
      this.worker = this.makeWorker(media)
    }
    this.translator = createTranslator({
      // Present when audios are downloaded: the translator hands the capture the descriptor and wakes the worker.
      ...(media === undefined ? {} : { audio: { kick: () => this.kickDownloads() } }),
      capture: options.capture,
      catalog: getCatalog(options.language),
      clock: options.clock,
      ownIds: options.ownIds,
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
      resolvePhoneNumber: async (lid) => this.session?.socket.signalRepository?.lidMapping?.getPNForLID(lid),
      fetchGroupSubject: async (jid) => {
        const session = this.session
        if (session === null) return undefined
        return (await session.socket.groupMetadata(jid)).subject ?? null
      },
      ...(options.storedConversationName === undefined
        ? {}
        : { storedConversationName: options.storedConversationName }),
    })
  }

  get status(): WhatsAppStatus {
    return this.current
  }

  /** Listens to status changes. Returns the function that stops listening. */
  onStatus(listener: WhatsAppStatusListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * What the delivery adapter may use of the live socket: the account and the one send method. Null unless the
   * connection is open, so nothing is sent while connecting, reconnecting or stopped (RF-52).
   */
  selfChat(): Pick<WhatsAppSocket, 'user' | 'sendTextToSelf'> | null {
    const socket = this.session?.socket
    if (socket === undefined || this.current.state !== 'connected') return null
    return {
      get user() {
        return socket.user
      },
      sendTextToSelf: (text) => socket.sendTextToSelf(text),
    }
  }

  /** Starts connecting. Does nothing when it is running already. */
  async start(): Promise<void> {
    if (this.running) return
    if (this.loggedOut) {
      this.setStatus({ state: 'loggedOut' })
      return
    }
    this.running = true
    this.attempt = 0
    await this.connect()
  }

  /** Stops for good: no reconnection, no listeners on the socket, the connection closed, pending events done. */
  async stop(): Promise<void> {
    this.running = false
    this.generation++
    this.clearTimer()
    this.release()
    this.setStatus({ state: 'stopped' })
    await this.queue
    // The download in progress is aborted (stream destroyed, partial file removed) and its audio stays in the durable
    // queue, to be downloaded after the next start. When this returns nothing of the account is open and nothing will
    // write to its database (it is closed next). A fresh worker is ready if the connection is started again.
    const worker = this.worker
    if (worker !== null && this.options.media !== undefined && this.options.media.worker !== false) {
      await worker.stop()
      this.worker = this.makeWorker(this.options.media)
    }
    await Promise.all(this.settling.splice(0))
  }

  /**
   * Wakes the download worker (RF-15): it takes the audios of the durable queue, oldest first, one at a time, while the
   * connection is open. Called when an audio is queued, when the connection opens and on the sweep of the daemon. Does
   * nothing when audios are not downloaded.
   */
  kickDownloads(): void {
    this.worker?.kick()
  }

  /** The download worker over the durable queue, one audio at a time (see `createDownloadAudios`). */
  private makeWorker(media: NonNullable<WhatsAppConnectionOptions['media']>): DownloadAudios {
    const fetcher = this.fetcher
    if (fetcher === null) throw new Error('no fetcher')
    const downloader: AudioDownloader = {
      download: async (item) => {
        // Without a connection nothing can be downloaded: not the fault of the audio, so it is not counted.
        if (this.session === null) return err({ kind: 'unavailable', reason: 'not-connected' })
        const controller = new AbortController()
        this.activeDownload = controller
        try {
          const result = await fetcher.fetch(
            item.descriptor,
            { conversationId: item.conversationId, messageId: item.messageId },
            controller.signal,
          )
          return result.ok ? result : err({ kind: classifyFailure(result.error), reason: result.error })
        } finally {
          if (this.activeDownload === controller) this.activeDownload = null
        }
      },
      abort: () => this.activeDownload?.abort(),
    }
    return createDownloadAudios({
      queue: media.queue,
      downloader,
      clock: this.options.clock,
      ...(media.maxAttempts === undefined ? {} : { maxAttempts: media.maxAttempts }),
      ...(media.onDownloaded === undefined ? {} : { onDownloaded: media.onDownloaded }),
      ...(media.onOutcome === undefined ? {} : { onOutcome: media.onOutcome }),
    })
  }

  /**
   * Stops and deletes the stored session (the files of the auth directory), so the account can be linked again with a
   * new QR. The way out of `loggedOut`.
   */
  async clearSession(): Promise<void> {
    await this.stop()
    for (const entry of await readdir(this.options.authDir).catch(() => [] as string[])) {
      await rm(join(this.options.authDir, entry), { recursive: true, force: true })
    }
    this.options.ownIds.set([])
    this.loggedOut = false
  }

  private setStatus(status: WhatsAppStatus): void {
    this.current = status
    for (const listener of [...this.listeners]) {
      try {
        listener(status)
      } catch {
        this.options.onWarning?.('status-listener-failed')
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** Detaches from the current socket and closes it. Safe to call on a socket that is closed already. */
  private release(): void {
    const session = this.session
    this.detach?.()
    this.detach = null
    this.session = null
    // A download in progress belongs to the connection that is going away: it is aborted (stream destroyed, partial file
    // removed) and its audio stays in the durable queue.
    this.activeDownload?.abort()
    if (session === null) return
    this.settling.push(session.settle().catch(() => this.options.onWarning?.('settle-failed')))
    try {
      session.socket.end(undefined)
    } catch {
      // already closed
    }
  }

  private async connect(): Promise<void> {
    if (!this.running) return
    const generation = ++this.generation
    this.setStatus({ state: 'connecting' })
    let session: SocketSession
    try {
      session = await this.options.socketFactory({ authDir: this.options.authDir })
    } catch {
      if (generation !== this.generation) return
      this.running = false
      this.setStatus({ state: 'error', reason: 'socketFailed' })
      return
    }
    if (generation !== this.generation) {
      // stop() (or another connect) happened while the socket was being created.
      try {
        session.socket.end(undefined)
      } catch {
        // nothing to close
      }
      return
    }
    this.session = session
    this.options.ownIds.set([...this.options.ownIds.get(), session.me()?.id, session.me()?.lid])
    this.detach = this.attach(session, generation)
  }

  /** Subscribes to the events of one socket. Returns the function that removes every subscription. */
  private attach(session: SocketSession, generation: number): () => void {
    const { ev } = session.socket
    const subscriptions: [string, (data: never) => void][] = []
    const on = <T>(event: string, handler: (data: T) => void | Promise<void>): void => {
      const listener = (data: T): void => {
        if (generation !== this.generation) return
        this.enqueue(() => handler(data))
      }
      subscriptions.push([event, listener as (data: never) => void])
      ev.on(event, listener as (data: never) => void)
    }
    const translator = this.translator

    // creds.update and connection.update are not content: they bypass nothing, but they must not wait for a long
    // history sync either, so they run outside the queue.
    const direct = <T>(event: string, handler: (data: T) => void): void => {
      const listener = (data: T): void => {
        if (generation === this.generation) handler(data)
      }
      subscriptions.push([event, listener as (data: never) => void])
      ev.on(event, listener as (data: never) => void)
    }

    direct<{ connection?: string; lastDisconnect?: { error?: unknown }; qr?: string }>('connection.update', (update) =>
      this.onConnectionUpdate(session, generation, update),
    )
    direct<unknown>('creds.update', () => {
      session.saveCreds().catch(() => this.options.onWarning?.('creds-save-failed'))
    })

    on<WaMessagesUpsert>('messages.upsert', (data) => translator.messagesUpsert(data))
    on<WaHistorySet>('messaging-history.set', (data) => translator.historySet(data))
    on<readonly WaMessageUpdate[]>('messages.update', (data) => translator.messagesUpdate(data))
    on<readonly WaChat[]>('chats.upsert', (data) => translator.chatsUpsert(data))
    on<readonly WaChat[]>('chats.update', (data) => translator.chatsUpdate(data))
    on<readonly WaContact[]>('contacts.upsert', (data) => translator.contacts(data))
    on<readonly WaContact[]>('contacts.update', (data) => translator.contacts(data))
    on<readonly WaGroup[]>('groups.upsert', (data) => translator.groups(data))
    on<readonly WaGroup[]>('groups.update', (data) => translator.groups(data))
    on<{ lid: string; pn: string }>('lid-mapping.update', (data) => translator.learnLidMapping(data))

    return () => {
      for (const [event, listener] of subscriptions) ev.off(event, listener)
    }
  }

  private enqueue(work: () => void | Promise<void>): void {
    this.queue = this.queue.then(work).catch(() => this.options.onWarning?.('event-failed'))
  }

  private onConnectionUpdate(
    session: SocketSession,
    generation: number,
    update: { connection?: string; lastDisconnect?: { error?: unknown }; qr?: string },
  ): void {
    if (update.qr) this.setStatus({ state: 'qr', qr: update.qr })
    if (update.connection === 'open') {
      this.attempt = 0
      const user = session.socket.user
      this.options.ownIds.set([...this.options.ownIds.get(), user?.id, user?.lid])
      this.translator.beginSession(this.options.clock.now())
      this.setStatus({ state: 'connected' })
      // The audios that were waiting (history, or from before a restart or a drop) are downloaded now.
      this.kickDownloads()
    } else if (update.connection === 'close') {
      this.onClosed(generation, statusCodeOf(update.lastDisconnect?.error))
    }
  }

  private onClosed(generation: number, code: number | undefined): void {
    if (generation !== this.generation) return
    this.release()
    if (code === LOGGED_OUT) {
      this.running = false
      this.loggedOut = true
      this.generation++
      this.setStatus({ state: 'loggedOut' })
      return
    }
    if (code === FORBIDDEN || code === REPLACED) {
      this.running = false
      this.generation++
      this.setStatus({ state: 'error', reason: code === FORBIDDEN ? 'forbidden' : 'replaced' })
      return
    }
    this.attempt++
    const delayMs = backoffDelay(this.backoff, this.attempt)
    this.setStatus({
      state: 'reconnecting',
      attempt: this.attempt,
      delayMs,
      reason: (code !== undefined ? REASONS[code] : undefined) ?? 'unknown',
    })
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.connect()
    }, delayMs)
  }
}
