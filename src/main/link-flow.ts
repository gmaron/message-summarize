import type { LinkErrorCode } from '../infrastructure/i18n/index.js'
import { reconcileAccount } from '../infrastructure/whatsapp/account-binding.js'
import type { WhatsAppStatus } from '../infrastructure/whatsapp/connection.js'
import type { LinkTiming } from './context.js'
import type { CountingCapture } from './counting-capture.js'
import type { DaemonConnection } from './daemon.js'
import type { Runtime } from './runtime.js'

export type { LinkErrorCode }

/** `waitingQr`: connecting, no QR yet. `qr`: scan it. `syncing`: linked, the history is coming in. */
export type LinkPhase = 'waitingQr' | 'qr' | 'syncing' | 'done' | 'failed'

export interface SyncProgress {
  /** Conversations seen so far. */
  readonly chats: number
  /** Messages stored so far. */
  readonly messages: number
  readonly done: boolean
}

/**
 * Where a link made by the daemon is. The `qr` is the raw string of a pairing credential: it lives in memory and goes
 * to the web, never to disk or a log, and it is there only while the phase is `qr`.
 */
export interface LinkSnapshot {
  readonly state: LinkPhase
  readonly qr?: string
  readonly sync?: SyncProgress
  readonly error?: LinkErrorCode
}

export type LinkFlowResult =
  | { readonly ok: true }
  /** `bound`: the account of the socket was bound (the session is a real one) before it failed. */
  | { readonly ok: false; readonly error: LinkErrorCode; readonly bound: boolean }

export interface LinkFlowOptions {
  readonly runtime: Runtime
  readonly connection: Pick<DaemonConnection, 'start' | 'onStatus' | 'selfChat' | 'status'>
  readonly activity: CountingCapture
  readonly timing: LinkTiming
  /** Every change of the snapshot (a new QR included). */
  readonly onSnapshot: (snapshot: LinkSnapshot) => void
  /** Progress of the sync, at most every `syncPublishMs`, and a last one with `done`. */
  readonly onSync: (progress: SyncProgress) => void
  /** The account was bound and the session is real: the block it had no longer applies. */
  readonly onBound: () => Promise<void>
}

type Outcome =
  | { readonly kind: 'connected' }
  | { readonly kind: 'failed'; readonly error: LinkErrorCode }
  | { readonly kind: 'timeout' }

const FAILURE_REASONS: Readonly<Record<string, LinkErrorCode>> = {
  socketFailed: 'socketFailed',
  forbidden: 'forbidden',
  replaced: 'replaced',
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * What `msum link` does, as a state the web can read (RF-01, RF-02): connect, wait for the QR to be scanned (a new one
 * replaces the old every time WhatsApp renews it), check the account that was scanned against the bound one (RF-51),
 * and wait until the initial history stops arriving. It uses the same quiet heuristic as the command, with the same
 * timing: at least `minAfterConnectMs`, then until nothing was captured for `quietMs`, never more than
 * `maxAfterConnectMs`.
 *
 * It does not stop the connection: when it succeeds the daemon goes on using it. The caller cleans up after a failure.
 */
export class LinkFlow {
  private current: LinkSnapshot = { state: 'waitingQr' }
  private terminal: LinkErrorCode | null = null
  private fail: (outcome: Outcome) => void = () => {}
  private syncing = false
  /** The account of the socket was bound: a cancel from here on only stops waiting for the history. */
  private bound = false
  private stopWaiting = false
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private lastSync = 0

  constructor(private readonly options: LinkFlowOptions) {}

  get snapshot(): LinkSnapshot {
    return this.current
  }

  /**
   * Stops the link. Before the account is bound it fails with `cancelled` (the caller stops the socket). Once it is
   * bound the link has worked: cancelling only stops waiting for the history, and the flow ends well so the daemon
   * keeps the open socket.
   */
  cancel(): void {
    if (this.bound) {
      this.stopWaiting = true
      return
    }
    this.terminate('cancelled')
  }

  private terminate(error: LinkErrorCode): void {
    this.terminal ??= error
    this.fail({ kind: 'failed', error })
  }

  private set(snapshot: LinkSnapshot): void {
    this.current = snapshot
    this.options.onSnapshot(snapshot)
  }

  private progress(done: boolean): SyncProgress {
    const { activity } = this.options
    return { chats: activity.chats(), messages: activity.messages(), done }
  }

  private publishSync(done: boolean): void {
    this.lastSync = Date.now()
    const sync = this.progress(done)
    this.current = { ...this.current, sync }
    this.options.onSync(sync)
  }

  private queueSync(): void {
    if (!this.syncing || this.syncTimer !== null) return
    const every = this.options.timing.syncPublishMs ?? 500
    this.syncTimer = setTimeout(
      () => {
        this.syncTimer = null
        if (this.syncing) this.publishSync(false)
      },
      Math.max(0, this.lastSync + every - Date.now()),
    )
  }

  async run(): Promise<LinkFlowResult> {
    const { connection, timing, runtime, activity } = this.options
    let settle: (outcome: Outcome) => void = () => {}
    const outcome = new Promise<Outcome>((resolve) => {
      settle = resolve
    })
    this.fail = settle
    if (this.terminal !== null) settle({ kind: 'failed', error: this.terminal })
    let connected = false
    const unsubscribe = connection.onStatus((status: WhatsAppStatus) => {
      if (status.state === 'qr' && !connected) this.set({ state: 'qr', qr: status.qr })
      else if (status.state === 'connected') {
        connected = true
        settle({ kind: 'connected' })
      } else if (status.state === 'loggedOut') this.terminate('loggedOut')
      else if (status.state === 'error') this.terminate(FAILURE_REASONS[status.reason] ?? 'failed')
    })
    activity.onActivity = () => this.queueSync()
    let timer: ReturnType<typeof setTimeout> | undefined
    let bound = false
    const failed = (error: LinkErrorCode): LinkFlowResult => {
      this.set({ state: 'failed', error })
      return { ok: false, error, bound }
    }
    try {
      try {
        // A link cancelled before it began never opens the socket.
        if (this.terminal === null) await connection.start()
      } catch {
        this.terminate('failed')
      }
      const result = await Promise.race([
        outcome,
        new Promise<Outcome>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'timeout' }), timing.connectTimeoutMs)
        }),
      ])
      clearTimeout(timer)
      if (result.kind === 'timeout') return failed('timeout')
      if (result.kind === 'failed') return failed(result.error)

      const check = reconcileAccount(runtime.identity, connection.selfChat()?.user)
      if (check === 'mismatch' || check === 'noAccount') return failed(check)
      bound = true
      this.bound = true
      // A cancel that came while the account was being checked arrived too late to undo the binding.
      if (this.terminal === 'cancelled') {
        this.terminal = null
        this.stopWaiting = true
      }
      await this.options.onBound()
      this.syncing = true
      this.lastSync = 0
      this.set({ state: 'syncing', sync: this.progress(false) })
      const connectedAt = Date.now()
      while (this.terminal === null && !this.stopWaiting) {
        await sleep(timing.pollMs)
        const now = Date.now()
        const elapsed = now - connectedAt
        if (elapsed >= timing.maxAfterConnectMs) break
        if (elapsed >= timing.minAfterConnectMs && now - activity.lastActivity() >= timing.quietMs) break
      }
      if (this.terminal !== null) return failed(this.terminal)
      this.syncing = false
      this.publishSync(true)
      this.set({ state: 'done', sync: this.progress(true) })
      return { ok: true }
    } finally {
      clearTimeout(timer)
      this.syncing = false
      if (this.syncTimer !== null) clearTimeout(this.syncTimer)
      this.syncTimer = null
      activity.onActivity = () => {}
      unsubscribe()
    }
  }
}
