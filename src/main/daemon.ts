import { DeliverPending } from '../application/deliver-pending.js'
import { CronerScheduler } from '../infrastructure/scheduling/croner-scheduler.js'
import { reconcileAccount } from '../infrastructure/whatsapp/account-binding.js'
import type { WhatsAppStatus, WhatsAppStatusListener } from '../infrastructure/whatsapp/connection.js'
import { type SelfChatSource, WhatsAppSelfChatDelivery } from '../infrastructure/whatsapp/self-chat-delivery.js'
import { type BlockedReason, readBlocked, writeBlocked } from './blocked.js'
import { errorCode, type Logger } from './logger.js'
import { runDigest } from './run-digest.js'
import type { Runtime } from './runtime.js'

/** What the daemon needs of the WhatsApp connection (the adapter's `WhatsAppConnection` satisfies it). */
export interface DaemonConnection extends SelfChatSource {
  start(): Promise<void>
  stop(): Promise<void>
  readonly status: WhatsAppStatus
  onStatus(listener: WhatsAppStatusListener): () => void
}

export interface DaemonOptions {
  readonly runtime: Runtime
  readonly connection: DaemonConnection
  readonly logger: Logger
  /** How often the outbox is looked at while connected (the previous tool retried every 15 s). Default 30 s. */
  readonly sweepMs?: number
  /**
   * After a connection opens, how long to wait for the messages that arrived while offline before running a digest
   * that was due while disconnected, or one missed while the daemon was off. Default 60 s.
   */
  readonly missedRunDelayMs?: number
  /** Total time a shutdown may take (connection and a digest in progress). Default 7 s: see `DEFAULT_SHUTDOWN_GRACE_MS`. */
  readonly shutdownGraceMs?: number
  /** Called once when the daemon goes idle because the account cannot be used (for a message to the user). */
  readonly onBlocked?: (reason: BlockedReason) => void
}

export type DigestTrigger = 'schedule' | 'missed'
/** `busy`: another digest was in progress, so this one did not start (RF-66). */
export type DigestOutcome = 'ran' | 'busy' | 'failed'

export const DEFAULT_SWEEP_MS = 30_000
export const DEFAULT_MISSED_RUN_DELAY_MS = 60_000
/**
 * The whole shutdown (connection stop plus waiting for a digest in progress) is cut at this time, so the process is
 * gone well within 8 s and inside Docker's default stop timeout of 10 s. A digest cut short loses nothing: the
 * pointer only moves on commit, so the window is summarized again next time.
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 7_000

const ERROR_REASONS: Readonly<Record<string, BlockedReason>> = {
  forbidden: 'forbidden',
  replaced: 'replaced',
  socketFailed: 'socketFailed',
}

/**
 * The long-running part of the product, for ONE account (RF-03, RF-60..66):
 *
 * - Connection: on every `connected` it reconciles the account of the socket with the bound one (RF-51), then delivers
 *   whatever is queued.
 * - Terminal states: logged out from the phone, refused (403), replaced (440), a QR asked for (the account is not
 *   linked: that is `msum link`'s job), the socket of another account, or a socket with no phone number. On any of
 *   them the daemon stops the connection (so nothing more is captured), logs ONCE, writes `account/blocked.json` and
 *   stays alive and idle: no reconnecting, no digests, no delivery. Idle is deliberate: a supervisor that restarts a
 *   daemon that exits would reconnect in a loop, which can get the number banned. A daemon started while the marker
 *   exists logs its reason and stays idle without connecting. `msum link`, `msum unlink` and `msum daemon --retry`
 *   clear it.
 * - Delivery: after every committed digest, and every `sweepMs` while connected (RF-52).
 * - Schedules: croner, in the configured time zone, inside this process. A tick while a digest is running is skipped,
 *   so two digests never run at once (RF-66); the store's compare-and-set protects against another process
 *   (`msum digest`) committing the same window.
 * - Late messages: a tick that fires while disconnected, or within `missedRunDelayMs` of a connection opening, does
 *   not run: messages that arrived while offline are still being received. It is deferred to the catch-up that runs
 *   once, `missedRunDelayMs` after the connection opens.
 * - Missed run (RF-65): the same catch-up, the first time the connection opens, also runs ONE digest when the last
 *   scheduled time before now is later than the digest pointer. Never one per missed schedule. With no pointer
 *   (nothing was ever generated) it does nothing: the first scheduled run covers the default window.
 *
 * It logs only codes, counts and times (see `logger.ts`).
 */
export class Daemon {
  private readonly runtime: Runtime
  private readonly connection: DaemonConnection
  private readonly logger: Logger
  private readonly deliverPending: DeliverPending
  private readonly scheduler: CronerScheduler
  private readonly sweepMs: number
  private readonly missedRunDelayMs: number
  private readonly shutdownGraceMs: number
  private readonly onBlocked: (reason: BlockedReason) => void

  /** True until the account of the live socket was checked against the bound one on this connection. */
  private unverified = true
  private blockedReason: BlockedReason | null = null
  private blockPromise: Promise<void> = Promise.resolve()
  private connectedAt: number | null = null
  /** A scheduled tick that could not run when it fired. */
  private deferred = false
  private catchUpDone = false
  private digestRun: Promise<DigestOutcome> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private shutdownPromise: Promise<void> | null = null
  private finish: (code: number) => void = () => {}
  /** Resolves (with exit code 0) once the daemon has stopped. It never ends by itself: see "Terminal states". */
  readonly finished: Promise<number> = new Promise((resolve) => {
    this.finish = resolve
  })

  constructor(options: DaemonOptions) {
    this.runtime = options.runtime
    this.connection = options.connection
    this.logger = options.logger
    this.sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS
    this.missedRunDelayMs = options.missedRunDelayMs ?? DEFAULT_MISSED_RUN_DELAY_MS
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS
    this.onBlocked = options.onBlocked ?? (() => {})
    this.deliverPending = new DeliverPending(
      options.runtime.outbox,
      new WhatsAppSelfChatDelivery(options.connection, options.runtime.identity),
    )
    this.scheduler = new CronerScheduler({
      timezone: options.runtime.config.timezone,
      schedules: options.runtime.config.schedules,
      onTick: (schedule) => this.onTick(schedule),
    })
  }

  /** Why the daemon is idle, or null when it is working. */
  get blocked(): BlockedReason | null {
    return this.blockedReason
  }

  /** Resolves when everything a terminal state started is done: the marker written and the connection stopped. */
  whenBlocked(): Promise<void> {
    return this.blockPromise
  }

  async start(): Promise<void> {
    const marker = await readBlocked(this.runtime.layout.blockedFile)
    if (marker !== null) {
      // Restarted while blocked: say why, once, and do nothing else.
      this.blockedReason = marker.reason
      this.logger.error('daemon.blocked', { reason: marker.reason })
      this.onBlocked(marker.reason)
      return
    }
    this.unsubscribe = this.connection.onStatus((status) => this.onStatus(status))
    this.scheduler.start()
    this.sweepTimer = setInterval(() => void this.deliver(), this.sweepMs)
    const next = this.scheduler
      .nextRuns(new Date(this.runtime.clock.now()))
      .flatMap(({ next }) => (next === null ? [] : [next.getTime()]))
    this.logger.info('daemon.started', {
      count: this.runtime.config.schedules.length,
      nextRun: next.length === 0 ? null : new Date(Math.min(...next)).toISOString(),
    })
    await this.connection.start()
  }

  /** Stops everything and resolves when it is done. Safe to call more than once. */
  stop(): Promise<void> {
    this.shutdownPromise ??= this.doShutdown()
    return this.shutdownPromise
  }

  /**
   * Runs one digest and queues it for delivery (RF-63, RF-65, RF-66). Returns `busy`, starting nothing, when another
   * digest is running. The check and the claim of the slot happen in the same synchronous step.
   */
  async runScheduledDigest(trigger: DigestTrigger): Promise<DigestOutcome> {
    if (this.digestRun !== null) {
      this.logger.warn('digest.skipped', { reason: 'busy', trigger })
      return 'busy'
    }
    const run = this.executeDigest(trigger)
    this.digestRun = run
    try {
      return await run
    } finally {
      this.digestRun = null
    }
  }

  /** Sends what is queued, if the connection is open and the account was reconciled. */
  async deliver(): Promise<void> {
    if (this.blockedReason !== null || this.unverified || this.connection.status.state !== 'connected') return
    try {
      const { delivered, failure } = await this.deliverPending.run()
      if (failure !== null) this.logger.warn('delivery.stopped', { delivered, failure })
      else if (delivered > 0) this.logger.info('delivery.done', { delivered })
    } catch (error) {
      this.logger.error('delivery.failed', { code: errorCode(error) })
    }
  }

  private async executeDigest(trigger: DigestTrigger): Promise<DigestOutcome> {
    this.logger.info('digest.started', { trigger })
    try {
      const result = await runDigest(this.runtime, { preview: false })
      if (!result.ok) {
        this.logger.error('digest.failed', { trigger, reason: result.error.kind })
        return 'failed'
      }
      const { summarized, failed, parts, pointer } = result.value
      this.logger.info('digest.committed', { trigger, summarized, failed: failed.length, parts: parts.length, pointer })
      await this.deliver()
      return 'ran'
    } catch (error) {
      this.logger.error('digest.failed', { trigger, code: errorCode(error) })
      return 'failed'
    }
  }

  private onTick(schedule: string): void {
    this.logger.info('schedule.fired', { schedule })
    const settled =
      this.connectedAt !== null &&
      this.connection.status.state === 'connected' &&
      this.runtime.clock.now() - this.connectedAt >= this.missedRunDelayMs
    if (settled) {
      void this.runScheduledDigest('schedule')
      return
    }
    // Offline, or just connected: the messages that arrived meanwhile are not here yet.
    this.deferred = true
    this.logger.info('schedule.deferred', { schedule })
  }

  private onStatus(status: WhatsAppStatus): void {
    const fields: Record<string, string | number> = { state: status.state }
    if (status.state === 'reconnecting') {
      fields.attempt = status.attempt
      fields.delayMs = status.delayMs
      fields.reason = status.reason
    } else if (status.state === 'error') {
      fields.reason = status.reason
    }
    // A QR is never logged: it is a pairing credential, and the status line has no field for it.
    const failing = status.state === 'error' || status.state === 'loggedOut'
    ;(failing ? this.logger.error : this.logger.info).call(this.logger, 'connection.status', fields)

    if (status.state === 'connected') {
      this.handleConnected()
      return
    }
    this.unverified = true
    this.connectedAt = null
    this.clearCatchUp()
    if (status.state === 'loggedOut') this.blockPromise = this.block('loggedOut')
    else if (status.state === 'error') this.blockPromise = this.block(ERROR_REASONS[status.reason] ?? 'socketFailed')
    else if (status.state === 'qr') this.blockPromise = this.block('notLinked')
  }

  private handleConnected(): void {
    const check = reconcileAccount(this.runtime.identity, this.connection.selfChat()?.user)
    if (check === 'mismatch' || check === 'noAccount') {
      // RF-51: another phone was linked, or the socket has no phone-number account.
      this.blockPromise = this.block(check)
      return
    }
    this.unverified = false
    this.connectedAt = this.runtime.clock.now()
    this.logger.info('account.checked', { state: check })
    void this.deliver()
    if (!this.catchUpDone || this.deferred) this.scheduleCatchUp()
  }

  /**
   * Terminal state: stop everything, say it once, leave the marker, stay idle. The synchronous part runs before the
   * first await, so nothing more is captured, scheduled or delivered from the moment it is called.
   */
  private async block(reason: BlockedReason): Promise<void> {
    if (this.blockedReason !== null) return
    this.blockedReason = reason
    this.logger.error('daemon.blocked', { reason })
    this.onBlocked(reason)
    this.stopTimers()
    await Promise.all([
      writeBlocked(this.runtime.layout.blockedFile, reason, this.runtime.clock.now()).catch((error: unknown) =>
        this.logger.error('daemon.markerFailed', { code: errorCode(error) }),
      ),
      this.within(this.stopConnection()),
    ])
  }

  private scheduleCatchUp(): void {
    if (this.catchUpTimer !== null) return
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null
      void this.catchUp()
    }, this.missedRunDelayMs)
  }

  private clearCatchUp(): void {
    if (this.catchUpTimer !== null) clearTimeout(this.catchUpTimer)
    this.catchUpTimer = null
  }

  private async catchUp(): Promise<void> {
    try {
      // Connection dropped again meanwhile: the flags stay, the next connection schedules this again.
      if (this.blockedReason !== null || this.connection.status.state !== 'connected') return
      const wasDeferred = this.deferred
      const first = !this.catchUpDone
      this.deferred = false
      this.catchUpDone = true
      if (!wasDeferred) {
        const lastDue = this.scheduler.lastDue(new Date(this.runtime.clock.now()))
        const pointer = await this.runtime.store.getPointer()
        if (!first || lastDue === null || pointer === null || pointer >= lastDue.getTime()) return
        this.logger.info('digest.missed', { pointer, nextRun: lastDue.toISOString() })
      } else {
        this.logger.info('digest.missed', { reason: 'deferred' })
      }
      await this.runScheduledDigest('missed')
    } catch (error) {
      this.logger.error('digest.failed', { trigger: 'missed', code: errorCode(error) })
    }
  }

  private stopTimers(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    this.clearCatchUp()
    this.scheduler.stop()
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async stopConnection(): Promise<void> {
    try {
      await this.connection.stop()
    } catch (error) {
      this.logger.error('connection.stopFailed', { code: errorCode(error) })
    }
  }

  /** Waits for `work`, but never longer than the shutdown budget. */
  private async within(work: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.shutdownGraceMs)
      }),
    ])
    clearTimeout(timer)
  }

  private async doShutdown(): Promise<void> {
    this.stopTimers()
    const running = this.digestRun
    await this.within(
      Promise.all([
        this.blockPromise,
        this.stopConnection(),
        running === null ? undefined : running.catch(() => undefined),
      ]),
    )
    this.logger.info('daemon.stopped', { code: 0 })
    this.finish(0)
  }
}
