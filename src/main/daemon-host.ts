import { mergeByTime, scheduleToCron } from '../domain/schedule.js'
import { getCatalog, type Language } from '../infrastructure/i18n/index.js'
import { type Installation, isDirectory } from './accounts.js'
import { type BlockedReason, readBlocked, writeBlocked } from './blocked.js'
import { type AppConfig, describeConfigIssue, loadEffectiveConfig, usesGenericCli } from './config.js'
import { type CommandContext, hasSession } from './context.js'
import { Daemon, type DaemonConnection } from './daemon.js'
import { linkLockHolder } from './link-lock.js'
import { errorCode, scopedLogger } from './logger.js'
import { accountLayoutOf } from './paths.js'
import { createRuntime, type Runtime } from './runtime.js'
import { importConfigSchedules } from './schedules.js'
import { type UnitState, writeUnitState } from './unit-state.js'

export const DEFAULT_POLL_MS = 5_000
export const DEFAULT_UNIT_BACKOFF_MS = 2_000
export const DEFAULT_UNIT_BACKOFF_MAX_MS = 60_000
/** A unit that stays connected this long has recovered: its failures stop counting. */
export const DEFAULT_UNIT_STABLE_MS = 10 * 60_000
/** After this many failures in a row the account is blocked (`socketFailed`) instead of being started again. */
export const DEFAULT_UNIT_MAX_FAILURES = 5

/** True when the account has nothing to summarize with: no provider chosen (or none given to the context). */
export function hasNoProvider(ctx: Pick<CommandContext, 'summarizer'>, config: Pick<AppConfig, 'provider'>): boolean {
  return ctx.summarizer === undefined ? config.provider.primary === null : ctx.summarizer === null
}

export interface DaemonHostTiming {
  /** How often the accounts are looked at again (new, removed, unblocked, being linked). Default 5 s. */
  readonly scheduleReloadMs?: number
  readonly sweepMs?: number
  readonly missedRunDelayMs?: number
  /** Total time a shutdown may take, all accounts in parallel. Default 7 s. */
  readonly shutdownGraceMs?: number
  /** First wait before a unit that crashed is started again; it doubles up to `unitBackoffMaxMs`. */
  readonly unitBackoffMs?: number
  readonly unitBackoffMaxMs?: number
  /** How long a unit must stay connected before its failures stop counting. Default 10 minutes. */
  readonly unitStableMs?: number
  /** Failures in a row after which the account is blocked. Default 5. */
  readonly unitMaxFailures?: number
}

export interface DaemonHostOptions {
  readonly ctx: CommandContext
  /** Open for as long as the host runs: the registry and the schedules are read on every poll. */
  readonly installation: Installation
  /** Run only this account (`msum daemon --account <id>`), for debugging. Null: every account. */
  readonly onlyAccount: string | null
  readonly timing?: DaemonHostTiming
  /** The language of the installation configuration, for what is said before an account's own is known. */
  readonly language: Language
  /** Writes `blocked.json`. Replaced by tests, to see when it is called and to make it fail. */
  readonly writeMarker?: (file: string, reason: BlockedReason, at: number) => Promise<void>
}

/** One account being run: its own runtime (database, delivery bound to its number), connection and `Daemon`. */
interface Unit {
  readonly id: string
  readonly runtime: Runtime
  readonly daemon: Daemon
}

/**
 * One daemon process for the whole installation (RF-03): it runs every registered account, each in an isolated unit
 * (see `Daemon`, which is the logic of ONE account), and keeps looking at the installation while it runs.
 *
 * Isolation. A unit has its own runtime, socket, scheduler, schedule reload, missed-run catch-up and single-flight, so
 * what happens in one does not reach the others: an account that reaches a terminal state (logged out, refused,
 * replaced...) writes its own `blocked.json` and idles while the rest go on. A failure inside a unit (a throw while
 * starting it, or in a status listener of its connection) is caught at the boundary, logged with the account id, and
 * that unit is stopped and started again with a growing wait. Nothing of a unit's work is left unhandled for the
 * process-level guards to see.
 *
 * Reconciliation (every `scheduleReloadMs`):
 * - a registered account that is linked, not blocked and not being linked gets a unit;
 * - an account removed from the registry has its unit stopped;
 * - an account being linked or unlinked (its `link.lock` is held by a live process) is not STARTED: the daemon never
 *   uses credentials `link` is still writing, nor what `unlink` deletes. A unit that already runs is never stopped by a
 *   lock: a running unit means the account is in use, and `link` and `unlink` refuse an account in use;
 * - when `blocked.json` of an account disappears (`msum retry`, a finished `link`) its unit is started again;
 * - an account that is blocked stays idle, and one that is not linked has no socket opened for it.
 *
 * The invariant of a block: when an account blocks (a terminal state of its connection, or a loop of failures) the host
 * first stops its socket and closes its runtime, database included, and only then writes `blocked.json`. So a marker
 * on disk always means the account has nothing open in this process, which is what lets `unlink` remove it safely.
 * If the marker cannot be written the block is kept in memory (see `blocks`) and the account stays idle.
 *
 * What the daemon says about each account (RF-04) goes to `accounts/<id>/state.json`.
 */
export class DaemonHost {
  private readonly ctx: CommandContext
  private readonly installation: Installation
  private readonly onlyAccount: string | null
  private readonly timing: Required<DaemonHostTiming>
  private readonly units = new Map<string, Unit>()
  /** Crashed units: how many times in a row, and when to try again (real time). */
  private readonly failures = new Map<string, { attempts: number; nextAt: number }>()
  /** Why each account without a unit is idle, so it is said once and not on every poll. */
  private readonly idleReasons = new Map<string, string>()
  private readonly states = new Map<
    string,
    { state: UnitState; since: number; writing: Promise<void>; unwritten: boolean }
  >()
  private readonly crashing = new Set<string>()
  /**
   * THE record of which accounts are blocked and why: one entry per blocked account, filled from `blocked.json` or, when
   * the marker could not be written, from memory. A blocked account has no unit. `persisted` says the marker was on disk
   * (read or written); a block counts as cleared by the user only when it was, and is now gone. An entry that is only in
   * memory stays blocked, whatever the disk says. The entry is dropped when the user clears it, and whenever a unit is
   * started for the account.
   */
  private readonly blocks = new Map<string, { reason: BlockedReason; persisted: boolean; warned: boolean }>()
  /** Blocks being released (socket and database closed, marker not yet written), so a shutdown waits for them. */
  private readonly releases = new Set<Promise<void>>()
  private readonly writeMarker: (file: string, reason: BlockedReason, at: number) => Promise<void>
  /** When each running unit last became connected (real time), for the stable period. */
  private readonly connectedSince = new Map<string, number>()
  /** The language each account runs with, once its configuration was read. */
  private readonly languages = new Map<string, Language>()
  private readonly rootLanguage: Language
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private reconciling: Promise<void> | null = null
  private again = false
  private stopping: Promise<void> | null = null
  private finish: (code: number) => void = () => {}
  /** Resolves (with exit code 0) once the daemon has stopped. */
  readonly finished: Promise<number> = new Promise((resolve) => {
    this.finish = resolve
  })

  constructor(options: DaemonHostOptions) {
    this.ctx = options.ctx
    this.installation = options.installation
    this.onlyAccount = options.onlyAccount
    this.rootLanguage = options.language
    this.writeMarker = options.writeMarker ?? writeBlocked
    const timing = options.timing ?? {}
    this.timing = {
      scheduleReloadMs: timing.scheduleReloadMs ?? DEFAULT_POLL_MS,
      sweepMs: timing.sweepMs ?? 30_000,
      missedRunDelayMs: timing.missedRunDelayMs ?? 60_000,
      shutdownGraceMs: timing.shutdownGraceMs ?? 7_000,
      unitBackoffMs: timing.unitBackoffMs ?? DEFAULT_UNIT_BACKOFF_MS,
      unitBackoffMaxMs: timing.unitBackoffMaxMs ?? DEFAULT_UNIT_BACKOFF_MAX_MS,
      unitStableMs: timing.unitStableMs ?? DEFAULT_UNIT_STABLE_MS,
      unitMaxFailures: timing.unitMaxFailures ?? DEFAULT_UNIT_MAX_FAILURES,
    }
  }

  /** The `Daemon` of an account that has a unit, for diagnostics and tests. */
  daemonOf(id: string): Daemon | undefined {
    return this.units.get(id)?.daemon
  }

  /** The ids of the accounts that have a unit running (or idling because they are blocked). */
  get running(): string[] {
    return [...this.units.keys()].sort()
  }

  /** Looks at the installation once, starts what can start, and keeps looking. */
  async start(): Promise<void> {
    await this.reconcile()
    this.ctx.logger.info('daemon.started', { count: this.accountIds().length })
    this.pollTimer = setInterval(() => void this.reconcile(), this.timing.scheduleReloadMs)
  }

  /** Stops every account in parallel, inside the shutdown budget, and resolves when it is done. Safe to repeat. */
  stop(): Promise<void> {
    this.stopping ??= this.doStop()
    return this.stopping
  }

  /** Runs a reconciliation; a call while one is going asks it to look once more when it ends. */
  reconcile(): Promise<void> {
    if (this.reconciling !== null) {
      this.again = true
      return this.reconciling
    }
    const run = (async () => {
      try {
        do {
          this.again = false
          if (this.stopping !== null) return
          await this.reconcileOnce()
        } while (this.again)
      } catch (error) {
        this.ctx.logger.error('daemon.pollFailed', { code: errorCode(error) })
      } finally {
        this.reconciling = null
      }
    })()
    this.reconciling = run
    return run
  }

  private accountIds(): string[] {
    const ids = this.installation.accounts().map((row) => row.id)
    return this.onlyAccount === null ? ids : ids.filter((id) => id === this.onlyAccount)
  }

  private async reconcileOnce(): Promise<void> {
    const ids = this.accountIds()
    for (const id of [...this.units.keys()]) {
      if (!ids.includes(id)) await this.stopUnit(id, 'removed')
    }
    for (const id of [...this.idleReasons.keys()]) if (!ids.includes(id)) this.idleReasons.delete(id)
    for (const id of [...this.blocks.keys()]) if (!ids.includes(id)) this.blocks.delete(id)
    // A unit that has stayed connected long enough has recovered: only now do its earlier failures stop counting.
    for (const [id, since] of this.connectedSince) {
      if (this.failures.has(id) && Date.now() - since >= this.timing.unitStableMs) this.failures.delete(id)
    }
    const starts: Promise<void>[] = []
    for (const id of ids) {
      const wanted = await this.decide(id)
      if (wanted) starts.push(this.startUnit(id))
    }
    await Promise.all(starts)
    await this.flushStates(ids)
  }

  /**
   * What to do with one account now. Stops its unit when it must not run, records why an account without a unit idles,
   * and returns true only when a unit has to be started.
   */
  private async decide(id: string): Promise<boolean> {
    const account = accountLayoutOf(this.ctx.layout, id)
    const unit = this.units.get(id)
    if ((await linkLockHolder(account)) !== null) {
      // The lock only keeps a unit from STARTING. A unit that runs means the account is in use, and `link` and `unlink`
      // refuse such an account: a lock seen on it belongs to a command that is about to be refused, so the unit is left
      // alone (stopping it would be the daemon dropping a healthy connection for nothing).
      if (unit !== undefined) return false
      // Nothing is recorded or written for an account while its lock is held: the directory is the other process's.
      if (this.idleReasons.get(id) !== 'linking') {
        this.idleReasons.set(id, 'linking')
        scopedLogger(this.ctx.logger, { account: id }).info('account.idle', { reason: 'linking' })
      }
      return false
    }
    // A running unit is left alone. One that is blocking itself is being released by `blockUnit` (its entry in `blocks`
    // is already there), so a blocked account never has a unit for long.
    if (unit !== undefined) return false
    if (!isDirectory(account.dir)) {
      this.setIdle(id, 'missingDir', 'idle')
      return false
    }
    const marker = await readBlocked(account.blockedFile)
    const entry = this.blocks.get(id)
    if (marker !== null) {
      this.blocks.set(id, { reason: marker.reason, persisted: true, warned: false })
      this.setIdle(id, `blocked:${marker.reason}`, 'blocked', marker.reason)
      return false
    }
    if (entry !== undefined) {
      if (!entry.persisted) {
        // A block that is only in memory (its marker could not be written) stays, whatever the disk says: a missing file
        // is not the user clearing it. Putting the marker on disk is tried again, quietly.
        await this.persistBlock(id)
        this.setIdle(id, `blocked:${entry.reason}`, 'blocked', entry.reason)
        return false
      }
      // The marker was on disk and is gone: the user cleared it (`msum retry`, a new link).
      this.blocks.delete(id)
    }
    if (!(await hasSession(account))) {
      this.setIdle(id, 'notLinked', 'idle')
      return false
    }
    const failure = this.failures.get(id)
    return failure === undefined || Date.now() >= failure.nextAt
  }

  /** An account that has no unit: said once (log, and a line for the user), and the state recorded. */
  private setIdle(id: string, why: string, state: UnitState, blocked?: BlockedReason): void {
    this.setState(id, state)
    if (this.idleReasons.get(id) === why) return
    this.idleReasons.set(id, why)
    const logger = scopedLogger(this.ctx.logger, { account: id })
    if (blocked !== undefined) {
      logger.error('daemon.blocked', { reason: blocked })
      const texts = this.textsOf(id)
      this.ctx.io.err(texts.daemon.blocked(texts.blockedReasons[blocked](id)))
    } else if (why === 'notLinked') {
      logger.info('account.idle', { reason: 'notLinked' })
      this.ctx.io.err(this.textsOf(id).daemon.notLinked(id))
    } else logger.info('account.idle', { reason: why })
  }

  /** The texts in the language the account runs with (its own file, else the installation's). */
  private textsOf(id: string) {
    return getCatalog(this.languages.get(id) ?? this.rootLanguage).cli
  }

  private setState(id: string, state: UnitState): void {
    const current = this.states.get(id)
    if (current?.state === state) return
    const entry = {
      state,
      since: this.ctx.clock.now(),
      writing: current?.writing ?? Promise.resolve(),
      unwritten: true,
    }
    this.states.set(id, entry)
    this.writeState(id, entry)
  }

  /**
   * Writes the state of an account to its file, after the writes before it, so the last state is the one that ends up
   * there. Nothing is written into an account that `link` or `unlink` holds the lock of: that process owns the
   * directory. The state stays unwritten and `flushStates` writes it on a later look, once the lock is gone.
   */
  private writeState(
    id: string,
    entry: { state: UnitState; since: number; writing: Promise<void>; unwritten: boolean },
  ): void {
    const account = accountLayoutOf(this.ctx.layout, id)
    entry.writing = entry.writing
      .then(async () => {
        if (this.states.get(id) !== entry) return // a newer state is on its way
        if (!entry.unwritten) return // already written (a second request for the same state)
        if ((await linkLockHolder(account)) !== null) return // stays unwritten: written once the lock is gone
        // Marked before the write, not after, so a look of the host that comes while it is being written does not
        // start a second write of the same state.
        entry.unwritten = false
        await writeUnitState(account.stateFile, { state: entry.state, since: entry.since })
      })
      .catch((error: unknown) => {
        entry.unwritten = false // it is not retried on every look: it would only repeat the same failure
        // An account deleted meanwhile has no directory to write to: not a problem.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.ctx.logger.error('state.writeFailed', { account: id, code: errorCode(error) })
        }
      })
  }

  /** Writes the states that had to wait for a link lock to go away. */
  private async flushStates(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const entry = this.states.get(id)
      if (entry?.unwritten === true) this.writeState(id, entry)
    }
    await Promise.all([...this.states.values()].map((entry) => entry.writing))
  }

  private async startUnit(id: string): Promise<void> {
    const account = accountLayoutOf(this.ctx.layout, id)
    const logger = scopedLogger(this.ctx.logger, { account: id })
    const loaded = await loadEffectiveConfig(this.ctx.layout.configFile, account.configFile)
    if (!loaded.ok) {
      if (this.idleReasons.get(id) !== 'config') {
        this.idleReasons.set(id, 'config')
        logger.error('account.configInvalid', { count: loaded.error.length })
        const catalog = getCatalog(this.languages.get(id) ?? this.rootLanguage)
        this.ctx.io.err(catalog.cli.config.heading)
        for (const issue of loaded.error) this.ctx.io.err(`  - ${describeConfigIssue(catalog, issue)}`)
      }
      this.setState(id, 'idle')
      return
    }
    const config = loaded.value
    this.languages.set(id, config.language)
    const texts = getCatalog(config.language).cli
    importConfigSchedules(this.installation, id, config)
    // Schedules and nothing to run them with: reported, and the account is left idle while the others go on.
    if (this.installation.schedules.list(id).length > 0 && hasNoProvider(this.ctx, config)) {
      if (this.idleReasons.get(id) !== 'noProvider') {
        this.idleReasons.set(id, 'noProvider')
        logger.error('account.noProvider', {})
        this.ctx.io.err(texts.config.noProvider)
      }
      this.setState(id, 'idle')
      return
    }
    this.idleReasons.delete(id)
    // RF-49: the generic CLI can run tools on chat text written by third parties: said when the account starts.
    if (this.ctx.summarizer === undefined && usesGenericCli(config)) {
      this.ctx.io.err(texts.config.genericCliWarning(config.provider.genericCli.acknowledgeRisk))
    }
    // A unit is being started, so nothing is blocked: whatever the host remembered of an earlier block is dropped, and
    // cannot make a later block look cleared (or not cleared).
    this.blocks.delete(id)

    let runtime: Runtime | null = null
    try {
      runtime = createRuntime({
        layout: account,
        config,
        env: this.ctx.env,
        clock: this.ctx.clock,
        ...(this.ctx.summarizer === undefined ? {} : { summarizer: this.ctx.summarizer }),
        ...(this.ctx.transcriber === undefined ? {} : { transcriber: this.ctx.transcriber }),
        onTranscription: (outcome) =>
          (outcome === 'transcribed' ? logger.info : logger.warn).call(logger, 'transcription.audio', {
            reason: outcome,
          }),
      })
      const connection = await this.ctx.connectionFactory(runtime, {
        onWarning: (code) => logger.warn('adapter.warning', { code }),
        // Only a fixed word: never the audio, its key or its path.
        onDownload: (outcome) =>
          (outcome === 'downloaded' ? logger.info : logger.warn).call(logger, 'media.download', { reason: outcome }),
      })
      const guarded = this.guard(id, connection)
      const daemon = new Daemon({
        runtime,
        connection: guarded,
        logger,
        scheduleSource: () =>
          mergeByTime(this.installation.schedules.list(id).map((stored) => stored.schedule)).map(scheduleToCron),
        scheduleReloadMs: this.timing.scheduleReloadMs,
        sweepMs: this.timing.sweepMs,
        missedRunDelayMs: this.timing.missedRunDelayMs,
        shutdownGraceMs: this.timing.shutdownGraceMs,
        onState: (state) => {
          this.setState(id, state)
          // Connected is not recovered: a unit that connects and fails again is still failing. The failures stop
          // counting only after it stays connected for the stable period (see `reconcileOnce`).
          if (state === 'connected') {
            if (!this.connectedSince.has(id)) this.connectedSince.set(id, Date.now())
          } else this.connectedSince.delete(id)
        },
        // The host owns the order of a block: release the account first, write the marker after (see `blockUnit`).
        writesMarker: false,
        onBlocked: (reason) => {
          this.ctx.io.err(texts.daemon.blocked(texts.blockedReasons[reason](id)))
          this.blockUnit(id, reason)
        },
      })
      // Right before starting: a `link` or `unlink` may have taken the account since it was decided on.
      if ((await linkLockHolder(account)) !== null) {
        runtime.close()
        return
      }
      this.units.set(id, { id, runtime, daemon })
      await daemon.start()
    } catch (error) {
      await this.failUnit(id, error, runtime)
    }
  }

  /**
   * The connection as the `Daemon` sees it, with the listeners of its status events wrapped: an exception inside the
   * reaction to an event of ONE account's socket is a failure of that unit, not of the process.
   */
  private guard(id: string, connection: DaemonConnection): DaemonConnection {
    return {
      start: () => connection.start(),
      stop: () => connection.stop(),
      get status() {
        return connection.status
      },
      selfChat: () => connection.selfChat(),
      kickDownloads: () => connection.kickDownloads?.(),
      onStatus: (listener) =>
        connection.onStatus((status) => {
          try {
            listener(status)
          } catch (error) {
            // Nothing may escape from here: a rejection nobody handles would take the whole process down.
            this.failUnit(id, error, this.units.get(id)?.runtime ?? null).catch((failure: unknown) => {
              this.ctx.logger.error('account.failUnitFailed', { account: id, code: errorCode(failure) })
            })
          }
        }),
    }
  }

  /** The unit boundary: log with the account id, stop that unit, and let the next poll start it again after a wait. */
  private async failUnit(id: string, error: unknown, runtime: Runtime | null): Promise<void> {
    if (this.crashing.has(id)) return
    this.crashing.add(id)
    try {
      const logger = scopedLogger(this.ctx.logger, { account: id })
      const previous = this.failures.get(id)?.attempts ?? 0
      const attempts = previous + 1
      this.connectedSince.delete(id)
      if (attempts >= this.timing.unitMaxFailures) {
        // A loop of failures is how a number gets banned: stop trying. The account is blocked like any other that
        // cannot be used, and `msum retry` brings it back when the user decides to.
        this.failures.delete(id)
        logger.error('account.crashLoop', { code: errorCode(error), count: attempts })
        if (this.units.has(id)) await this.stopUnit(id, 'crashLoop')
        else runtime?.close()
        await this.blockAccount(id, 'socketFailed')
        return
      }
      const delay = Math.min(this.timing.unitBackoffMs * 2 ** (attempts - 1), this.timing.unitBackoffMaxMs)
      this.failures.set(id, { attempts, nextAt: Date.now() + delay })
      logger.error('account.crashed', { code: errorCode(error), attempt: attempts, delayMs: delay })
      this.setState(id, 'reconnecting')
      if (this.units.has(id)) await this.stopUnit(id, 'crashed')
      else runtime?.close()
    } finally {
      this.crashing.delete(id)
    }
  }

  /**
   * An account that has no unit (its crash loop was detected and the unit already released) is blocked: remembered in
   * `blocks`, said once, and its marker written.
   */
  private async blockAccount(id: string, reason: BlockedReason): Promise<void> {
    this.blocks.set(id, { reason, persisted: false, warned: false })
    this.setIdle(id, `blocked:${reason}`, 'blocked', reason)
    await this.persistBlock(id)
  }

  /**
   * A unit blocked itself (a terminal state of its connection): the block is recorded at once, and then, in this order,
   * the unit is released (socket stopped, in-flight work finished, runtime and database closed) and the marker is
   * written. Started on the next tick, so the `Daemon` has finished starting its own block.
   */
  private blockUnit(id: string, reason: BlockedReason): void {
    this.blocks.set(id, { reason, persisted: false, warned: false })
    const release = Promise.resolve()
      .then(async () => {
        await this.stopUnit(id, 'blocked')
        await this.persistBlock(id)
      })
      .catch((error: unknown) => {
        scopedLogger(this.ctx.logger, { account: id }).error('account.blockFailed', { code: errorCode(error) })
      })
      .finally(() => this.releases.delete(release))
    this.releases.add(release)
  }

  /**
   * Writes the marker of a block. Only ever called when the account has nothing open in this process (no unit, no
   * database handle): a marker on disk means exactly that. When the write fails the block stays in memory, and is tried
   * again on the next looks; the failure is logged once. Nothing is written into an account a `link` or `unlink` holds.
   */
  private async persistBlock(id: string): Promise<void> {
    const entry = this.blocks.get(id)
    if (entry === undefined || entry.persisted) return
    const account = accountLayoutOf(this.ctx.layout, id)
    if ((await linkLockHolder(account)) !== null) return
    try {
      await this.writeMarker(account.blockedFile, entry.reason, this.ctx.clock.now())
      entry.persisted = true
    } catch (error) {
      if (!entry.warned) {
        entry.warned = true
        scopedLogger(this.ctx.logger, { account: id }).error('daemon.markerFailed', { code: errorCode(error) })
      }
    }
  }

  private async stopUnit(id: string, reason: string): Promise<void> {
    const unit = this.units.get(id)
    if (unit === undefined) return
    // Whatever stops a unit, a block it had is kept: it goes to `blocks` before the unit is gone.
    const reasonBlocked = unit.daemon.blocked
    if (reasonBlocked !== null && !this.blocks.has(id)) {
      this.blocks.set(id, { reason: reasonBlocked, persisted: false, warned: false })
    }
    this.units.delete(id)
    this.connectedSince.delete(id)
    scopedLogger(this.ctx.logger, { account: id }).info('account.unitStopped', { reason })
    try {
      await unit.daemon.stop()
    } catch (error) {
      scopedLogger(this.ctx.logger, { account: id }).error('account.stopFailed', { code: errorCode(error) })
    }
    try {
      unit.runtime.close()
    } catch {
      // already closed
    }
  }

  private async doStop(): Promise<void> {
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
    // A look at the installation that is still going (a socket that is slow to open) gets at most half the budget...
    const budget = this.timing.shutdownGraceMs
    const begun = Date.now()
    const within = async (work: Promise<unknown>, ms: number): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        work.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, ms))
        }),
      ])
      clearTimeout(timer)
    }
    if (this.reconciling !== null) await within(this.reconciling, budget / 2)
    // ...and then all the accounts stop at once, in what is left of it, so the whole stop takes the one budget.
    await within(
      Promise.all([...[...this.units.keys()].map((id) => this.stopUnit(id, 'shutdown')), ...[...this.releases]]),
      budget - (Date.now() - begun),
    )
    await within(Promise.all([...this.states.values()].map((entry) => entry.writing)), 500)
    this.ctx.logger.info('daemon.stopped', { code: 0 })
    this.finish(0)
  }
}
