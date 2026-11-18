import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CaptureMessages } from '../../application/capture-messages.js'
import type { Clock } from '../../application/ports/clock.js'
import { getCatalog, type Language } from '../i18n/index.js'
import type { OwnConversationIds } from './own-ids.js'
import { createTranslator } from './translate.js'
import type {
  WaChat,
  WaContact,
  WaGroup,
  WaHistorySet,
  WaHistoryStatus,
  WaMessagesUpsert,
  WaMessageUpdate,
} from './wa-types.js'

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
 * How the initial history sync goes (RF-02). A connection-level signal: counts and flags only, never content.
 * - `percent`: 0 to 100 (integer) when the server said so, null when this event does not carry it.
 * - `complete`: the initial history will not grow any more.
 * - `explicit`: (with `complete`) the server said 100. False: inferred, because no more chunks arrived.
 */
export interface HistorySyncProgress {
  readonly percent: number | null
  readonly complete: boolean
  readonly explicit?: boolean
}
export type HistorySyncListener = (progress: HistorySyncProgress) => void

/**
 * Baileys' `HistorySyncType.RECENT` (3): the history that WhatsApp sends when a device is linked (`syncFullHistory` is
 * off). It is the only type that counts for the progress: in `Socket/chats.js` Baileys emits `messaging-history.status`
 * `complete` for RECENT when progress 100 arrives (explicit) or `paused` after 120 s without chunks (inferred), and
 * its progress is the real 0..100 of that transfer. INITIAL_BOOTSTRAP (0) is also reported `complete`, but on its
 * FIRST chunk (the newest chats): taking it as the end would stop the wait while the history is still coming. FULL (2)
 * is only sent when the full history is requested, which this adapter never does; PUSH_NAME, NON_BLOCKING_DATA and
 * ON_DEMAND are names and extras, not history.
 */
export const HISTORY_SYNC_RECENT = 3

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
  readonly signalRepository?: {
    readonly lidMapping?:
      | {
          getPNForLID(lid: string): Promise<string | null | undefined>
          /** The LID that is STORED for a number: a local read, never a query to WhatsApp. */
          storedLidForPN?(pn: string): Promise<string | null | undefined>
        }
      | undefined
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
 * TODO (transcription commit, RF-15): downloading an audio must NOT pass `reuploadRequest` to Baileys: that sends a media
 * retry request to the sender, which is a message out. A media that cannot be downloaded is simply skipped.
 *
 * Events of a socket are processed one at a time in the order they arrived, so a history sync stays in order.
 */
/** Told that `a` and `b` are the same person; the capture of the event that taught it waits for it. */
export type AliasListener = (a: string, b: string) => void | Promise<void>

export class WhatsAppConnection {
  private current: WhatsAppStatus = { state: 'stopped' }
  private readonly listeners = new Set<WhatsAppStatusListener>()
  private readonly historyListeners = new Set<HistorySyncListener>()
  private readonly aliasListeners = new Set<AliasListener>()
  /** The RECENT chunk with progress 100 was stored / Baileys said the RECENT history is complete. Per socket. */
  private recentStored = false
  private recentStatusComplete = false
  private readonly translator
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
    this.translator = createTranslator({
      capture: options.capture,
      catalog: getCatalog(options.language),
      clock: options.clock,
      ownIds: options.ownIds,
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
      resolvePhoneNumber: async (lid) => this.session?.socket.signalRepository?.lidMapping?.getPNForLID(lid),
      resolveLid: async (phone) => this.session?.socket.signalRepository?.lidMapping?.storedLidForPN?.(phone),
      onAlias: async (a, b) => {
        for (const listener of [...this.aliasListeners]) {
          try {
            await listener(a, b)
          } catch {
            // a listener that fails does not stop the capture of the event that taught the pair
          }
        }
      },
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
   * Listens to two ids of the platform turning out to be the same person (a LID and a phone number). The events that
   * taught the pair wait for the listener to finish. Returns the function that stops listening.
   */
  onAlias(listener: AliasListener): () => void {
    this.aliasListeners.add(listener)
    return () => {
      this.aliasListeners.delete(listener)
    }
  }

  /** The pairs of ids learned so far (memory only). */
  knownAliases(): [string, string][] {
    return this.translator.knownAliases()
  }

  /** The other ids of the same person that are known now (empty when none): a mark has to cover all of them. */
  aliasesOf(id: string): Promise<string[]> {
    return this.translator.aliasesOf(id)
  }

  /** Listens to the progress of the initial history sync. Returns the function that stops listening. */
  onHistorySync(listener: HistorySyncListener): () => void {
    this.historyListeners.add(listener)
    return () => {
      this.historyListeners.delete(listener)
    }
  }

  private emitExplicitComplete(): void {
    if (this.recentStored && this.recentStatusComplete)
      this.emitHistory({ percent: 100, complete: true, explicit: true })
  }

  private emitHistory(progress: HistorySyncProgress): void {
    for (const listener of [...this.historyListeners]) {
      try {
        listener(progress)
      } catch {
        this.options.onWarning?.('history-listener-failed')
      }
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
    await Promise.all(this.settling.splice(0))
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
    this.recentStored = false
    this.recentStatusComplete = false
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
    // After the chunk is stored (the queue keeps the order), so a percent never runs ahead of the data it counts.
    on<WaHistorySet>('messaging-history.set', async (data) => {
      await translator.historySet(data)
      const { syncType, progress } = data
      if (syncType === HISTORY_SYNC_RECENT && typeof progress === 'number' && Number.isFinite(progress)) {
        const percent = Math.min(100, Math.max(0, Math.round(progress)))
        // Only the percent of a chunk that is stored is shown. At 100 the last chunk is in: that is half of "complete".
        this.emitHistory({ percent, complete: false })
        if (percent === 100) {
          this.recentStored = true
          this.emitExplicitComplete()
        }
      }
    })
    // Baileys emits `complete` as soon as the NOTIFICATION says 100, before that chunk is downloaded and before its
    // `messaging-history.set` (which Baileys' event buffer may also hold back). So the status alone is not completion:
    // it counts only together with the stored chunk, whichever comes second. `paused` (Baileys, 120 s after the last
    // RECENT chunk) is the inferred completion. If Baileys' buffer merges sets, the tag of the merged set is the last
    // chunk's (event-buffer.js): then the explicit completion never comes and `paused` or the quiet period ends the wait.
    on<WaHistoryStatus>('messaging-history.status', (data) => {
      if (data.syncType !== HISTORY_SYNC_RECENT) return
      if (data.status === 'paused') this.emitHistory({ percent: null, complete: true, explicit: false })
      else if (data.status === 'complete' && data.explicit === true) {
        this.recentStatusComplete = true
        this.emitExplicitComplete()
      } else if (data.status === 'complete') this.emitHistory({ percent: null, complete: true, explicit: false })
    })
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
