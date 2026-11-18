import { rm } from 'node:fs/promises'
import { exactIdOf, hasIdPattern, idPattern } from '../domain/exclusion.js'
import { mergeByTime, scheduleToCron } from '../domain/schedule.js'
import { getCatalog, type Language, type LinkErrorCode } from '../infrastructure/i18n/index.js'
import { type Installation, isDirectory } from './accounts.js'
import {
  type BlockedReason,
  clearBlocked,
  FIXED_BY_LINKING,
  readBlocked,
  WAIT_BEFORE_RETRY,
  WEB_RETRY_MIN_WAIT_MS,
  writeBlocked,
} from './blocked.js'
import { type AppConfig, configStamp, describeConfigIssue, loadEffectiveConfig, readConfigObject } from './config.js'
import { editAccountPrivacyLists, type PrivacyEdit } from './config-writer.js'
import { type CommandContext, hasSession } from './context.js'
import { type CountingCapture, countingCapture } from './counting-capture.js'
import { Daemon, type DaemonConnection, type DigestEvent } from './daemon.js'
import type { DaemonLock } from './daemon-lock.js'
import { LinkFlow, type LinkFlowResult, type LinkPhase, type LinkSnapshot } from './link-flow.js'
import { acquireLinkLock, LINK_HEARTBEAT_MS, linkLockHolder } from './link-lock.js'
import { errorCode, scopedLogger } from './logger.js'
import { accountLayoutOf, ensureAccountDirs, unsafeAccountPath } from './paths.js'
import { type AliasHost, coverAlias, purgeNow } from './privacy-aliases.js'
import { retryBlock } from './retry.js'
import { createRuntime, type Runtime } from './runtime.js'
import { importConfigSchedules } from './schedules.js'
import { type UnitState, writeUnitState } from './unit-state.js'
import type { ManagedConnection } from './whatsapp.js'

/** What WhatsApp ending the connection of a freshly bound account blocks it for: the same as a `Daemon`'s. */
const BLOCK_AFTER_LINK: Readonly<Partial<Record<LinkErrorCode, BlockedReason>>> = {
  loggedOut: 'loggedOut',
  forbidden: 'forbidden',
  replaced: 'replaced',
  socketFailed: 'socketFailed',
}

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
  /** How often the link lock of an account the daemon is linking is refreshed. Default `LINK_HEARTBEAT_MS`. */
  readonly linkHeartbeatMs?: number
}

/** What the host says about the connection of one account, in memory (the web shows it live). */
export interface AccountState {
  readonly state: UnitState
  /** Epoch ms of the last change of state. */
  readonly since: number
  /** Why the account is blocked, when its state is `blocked`. */
  readonly blockedReason: BlockedReason | null
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
  /** The pid written in the link locks the host takes while it links or retries an account. Default: this process. For tests. */
  readonly linkLockPid?: number
}

/** What the host says while it links an account from the web: the QR, the progress of the sync, the outcome. Codes only. */
export type LinkEvent =
  | { readonly type: 'qr'; readonly account: string; readonly qr: string }
  | {
      readonly type: 'sync'
      readonly account: string
      readonly chats: number
      readonly messages: number
      readonly percent?: number
      readonly done: boolean
    }
  | { readonly type: 'link'; readonly account: string; readonly state: LinkPhase; readonly error?: LinkErrorCode }

export type StartLinkResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason:
        | 'unknown'
        | 'unavailable'
        | 'inUse'
        | 'beingLinked'
        | 'alreadyLinking'
        | 'needsRetry'
        | 'invalidConfig'
        | 'unsafePath'
        | 'busy'
        | 'cancelled'
    }

/** How a digest of an account went, as the host reports it (see `onDigest`). */
export type HostDigestEvent = DigestEvent & { readonly account: string }

export type DigestNowResult =
  /** `deferred`: the connection is not settled, so the digest waits for the catch-up (see `DigestTrigger`). */
  | { readonly ok: true; readonly deferred: boolean }
  /** The account has no unit that can run a digest: it is not linked, blocked, starting, stopping or being linked. */
  | { readonly ok: false; readonly reason: 'notRunning' | 'busy' }

export type RetryAccountResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason:
        | 'unknown'
        | 'alreadyLinking'
        | 'busy'
        | 'beingLinked'
        | 'notBlocked'
        | 'needsRelink'
        | 'unsafePath'
    }
  /** Too soon after a block WhatsApp asked to wait for: `retryAfter` is when the web's retry is allowed (epoch ms). */
  | { readonly ok: false; readonly reason: 'tooSoon'; readonly retryAfter: number }

/** The runtime and socket of a link that went well, taken over by a normal unit without closing the socket. */
interface AdoptedLink {
  readonly runtime: Runtime
  readonly connection: ManagedConnection
}

/**
 * An operation of this host that holds the link lock of an account: a link from the web, or a retry. ONE per account,
 * for the whole life of the operation: the pid in a lock file is this process's for all of them, and a lock taken
 * twice by the same pid is taken over, not refused, so what keeps two of them apart is this map.
 */
interface ActiveLink {
  readonly kind: 'link' | 'retry'
  flow: LinkFlow | null
  /** A cancel (or a shutdown) that came before the flow existed. */
  cancelRequested: boolean
  /** Resolves when the operation is over and the lock is released. Real from the moment the account is claimed. */
  readonly done: Promise<void>
  readonly finish: () => void
}

function claim(kind: ActiveLink['kind']): ActiveLink {
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { kind, flow: null, cancelRequested: false, done, finish }
}

/** One account being run: its own runtime (database, delivery bound to its number), connection and `Daemon`. */
interface Unit {
  readonly id: string
  readonly runtime: Runtime
  readonly daemon: Daemon
  /** The connection itself (not the guarded view the daemon has): the privacy marks ask it for the aliases of an id. */
  readonly connection: ManagedConnection
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
 * Linking from the web (see `startLink`): the host links an account itself, as a unit in `linking` mode that holds the
 * account's link lock. That lock is the host's own, not someone else's, so it never keeps the host from writing the
 * state of that account (and `links` is what tells them apart). When the link succeeds the socket it opened goes to a
 * normal unit (schedules, delivery, catch-up) without being closed.
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
  /** What the config files of each running unit looked like when its configuration was last read (see `configStamp`). */
  private readonly configStamps = new Map<string, string>()
  /** The problems of the last invalid configuration found on a running unit, so each is logged once. */
  private readonly invalidConfigs = new Map<string, string>()
  /** The code of the last failure to apply a configuration of each unit, so a failure that repeats is logged once. */
  private readonly reloadFailures = new Map<string, string>()
  /** The refresh of each account that is going (see `refreshConfig`). */
  private readonly refreshes = new Map<string, Promise<void>>()
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
  /** Accounts being linked by this host (from the web). The host holds each one's link lock, so it is not "foreign". */
  private readonly links = new Map<string, ActiveLink>()
  /** The last link of each account (also after it ended) as `GET /api/accounts/:id/link` says it. In memory only. */
  private readonly linkSnapshots = new Map<string, LinkSnapshot>()
  private readonly linkListeners = new Set<(event: LinkEvent) => void>()
  private readonly digestListeners = new Set<(event: HostDigestEvent) => void>()
  private readonly linkLockPid: number
  private readonly linkHeartbeatMs: number
  private readonly writeMarker: (file: string, reason: BlockedReason, at: number) => Promise<void>
  /** When each running unit last became connected (real time), for the stable period. */
  private readonly connectedSince = new Map<string, number>()
  /** The language each account runs with, once its configuration was read. */
  private readonly languages = new Map<string, Language>()
  private readonly rootLanguage: Language
  private pollTimer: ReturnType<typeof setInterval> | null = null
  /** Marks put in force in memory only (their file write failed or was not applied), per account: stricter, never lost. */
  private readonly pendingMarks = new Map<string, PrivacyEdit[]>()
  /** Ids whose stored data must be deleted when no digest or preview of the account is running. */
  private readonly deferredPurges = new Map<string, Set<string>>()
  private readonly busyChecks = new Set<(id: string) => boolean>()
  private reconciling: Promise<void> | null = null
  private again = false
  private stopping: Promise<void> | null = null
  private finish: (code: number) => void = () => {}
  private readonly changeListeners = new Set<() => void>()
  private changeQueued = false
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
    this.linkLockPid = options.linkLockPid ?? process.pid
    this.linkHeartbeatMs = options.timing?.linkHeartbeatMs ?? LINK_HEARTBEAT_MS
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
      linkHeartbeatMs: this.linkHeartbeatMs,
    }
  }

  /**
   * Reads the configuration of a running account again and applies it WITHOUT closing its socket (RF-73): the runtime and
   * the scheduler follow the new values from the next digest on. Called after the web saves a change, and by every look of
   * the host (a file edited by hand is noticed by its modification time and size). With nothing changed it does nothing.
   *
   * A configuration that is not valid (a hand edit) is NOT applied: the unit keeps the last valid one, `account.configInvalid`
   * is logged once per set of problems, and the account view lists them. Fixing the file applies it. An account with no unit
   * is not touched here: its next start reads the files.
   */
  async reloadConfig(id: string): Promise<void> {
    await this.refreshConfig(id)
  }

  /**
   * One refresh at a time per account: a refresh that starts while another is going waits for it, and takes its own
   * stamp and reads the files AFTER that. Two overlapping refreshes could otherwise apply an older read after a newer
   * one, with the stamp already matching so nothing would correct it.
   */
  private refreshConfig(id: string): Promise<void> {
    const previous = this.refreshes.get(id) ?? Promise.resolve()
    const run = previous.then(() => this.refreshConfigNow(id))
    const tail = run.catch(() => undefined)
    this.refreshes.set(id, tail)
    void tail.then(() => {
      if (this.refreshes.get(id) === tail) this.refreshes.delete(id)
    })
    return run
  }

  /**
   * The privacy lists of an invalid configuration (RF-14, RF-43): whatever the raw files say, when each is a list of
   * non-empty texts, joined to the ones the unit already has (the union rule of `mergeConfigJson`). An invalid file can
   * make the privacy of the unit stricter, never looser. A list of the wrong shape, or a file that is not JSON, adds nothing.
   */
  private async privacyOfInvalid(files: readonly string[], current: AppConfig): Promise<AppConfig | null> {
    const found: Record<'localOnlyPatterns' | 'excludePatterns', string[]> = {
      localOnlyPatterns: [...current.localOnlyPatterns],
      excludePatterns: [...current.digest.excludePatterns],
    }
    const before = JSON.stringify(found)
    for (const file of files) {
      const read = await readConfigObject(file)
      if (!read.ok) continue
      for (const key of ['localOnlyPatterns', 'excludePatterns'] as const) {
        const value = read.value[key]
        if (!Array.isArray(value) || !value.every((p) => typeof p === 'string' && p.trim() !== '')) continue
        found[key] = [...new Set([...found[key], ...(value as string[])])]
      }
    }
    if (JSON.stringify(found) === before) return null
    return {
      ...current,
      localOnlyPatterns: found.localOnlyPatterns,
      digest: { ...current.digest, excludePatterns: found.excludePatterns },
    }
  }

  private async refreshConfigNow(id: string): Promise<void> {
    const unit = this.units.get(id)
    if (unit === undefined || unit.daemon.blocked !== null || this.links.has(id)) return
    const account = accountLayoutOf(this.ctx.layout, id)
    const files = [this.ctx.layout.configFile, account.configFile]
    // Taken BEFORE reading: a write that lands in between makes the next look read again.
    const stamp = await configStamp(files)
    if (this.configStamps.get(id) === stamp) return
    this.configStamps.set(id, stamp)
    const logger = scopedLogger(this.ctx.logger, { account: id })
    try {
      const loaded = await this.loadConfig(files[0] as string, account.configFile)
      // Gone, or replaced by another unit, while the files were read.
      if (this.units.get(id) !== unit || unit.daemon.blocked !== null) return
      if (!loaded.ok) {
        const signature = loaded.error.map((issue) => `${issue.option}:${issue.code}`).join(',')
        if (this.invalidConfigs.get(id) !== signature) {
          this.invalidConfigs.set(id, signature)
          logger.error('account.configInvalid', { count: loaded.error.length })
        }
        // The last valid configuration stays, with the privacy entries the invalid files add: never looser.
        const stricter = await this.privacyOfInvalid(files, unit.runtime.config)
        if (stricter !== null && this.units.get(id) === unit) unit.daemon.applyConfig(stricter)
        this.notifyChange()
        return
      }
      this.invalidConfigs.delete(id)
      const next = this.withPendingMarks(id, loaded.value)
      if (JSON.stringify(next) !== JSON.stringify(unit.runtime.config)) {
        this.languages.set(id, loaded.value.language)
        unit.daemon.applyConfig(next)
      }
      this.reloadFailures.delete(id)
      this.notifyChange()
    } catch (error) {
      // Looked at again on the next look, but said once per kind of failure.
      this.configStamps.delete(id)
      const code = errorCode(error)
      if (this.reloadFailures.get(id) !== code) {
        this.reloadFailures.set(id, code)
        logger.error('config.reloadFailed', { code })
      }
    }
  }

  /** Reads the effective configuration of an account. A seam: tests slow it down to interleave two refreshes. */
  protected loadConfig(rootFile: string, accountFile: string) {
    return loadEffectiveConfig(rootFile, accountFile)
  }

  /** The `Daemon` of an account that has a unit, for diagnostics and tests. */
  daemonOf(id: string): Daemon | undefined {
    return this.units.get(id)?.daemon
  }

  /** The state of an account as the host holds it now, or null when the host has not looked at the account yet. */
  accountState(id: string): AccountState | null {
    const entry = this.states.get(id)
    if (entry === undefined) return null
    const blocked = entry.state === 'blocked' ? (this.blocks.get(id)?.reason ?? null) : null
    return { state: entry.state, since: entry.since, blockedReason: blocked }
  }

  /**
   * Calls `listener` after any account changes state (or gets blocked). Several changes in the same tick make one call,
   * made after they all happened, so what `accountState` says is the settled picture. Returns the way to stop listening.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  private notifyChange(): void {
    if (this.changeQueued || this.changeListeners.size === 0) return
    this.changeQueued = true
    queueMicrotask(() => {
      this.changeQueued = false
      for (const listener of [...this.changeListeners]) {
        try {
          listener()
        } catch (error) {
          this.ctx.logger.error('daemon.listenerFailed', { code: errorCode(error) })
        }
      }
    })
  }

  /** Calls `listener` for every digest of every account: started, finished, failed or skipped. Returns the way to stop listening. */
  onDigest(listener: (event: HostDigestEvent) => void): () => void {
    this.digestListeners.add(listener)
    return () => {
      this.digestListeners.delete(listener)
    }
  }

  private emitDigest(event: HostDigestEvent): void {
    for (const listener of [...this.digestListeners]) {
      try {
        listener(event)
      } catch (error) {
        this.ctx.logger.error('daemon.listenerFailed', { code: errorCode(error) })
      }
    }
    // The last digest (where it ended) and the next run are part of what the web shows of an account.
    if (event.state !== 'busy') this.notifyChange()
  }

  /**
   * The runtime of the account's running unit, or undefined when it has none. A preview borrows it: the host closes it
   * when the unit stops, so a user of it must expect to fail at that point.
   */
  runtimeOf(id: string): Runtime | undefined {
    const unit = this.units.get(id)
    return unit === undefined || unit.daemon.blocked !== null ? undefined : unit.runtime
  }

  /** True while a digest of the account's unit is running (scheduled or asked for). */
  isDigestBusy(id: string): boolean {
    return this.units.get(id)?.daemon.digestBusy === true
  }

  /** Adds a check of "something of this account is running that reads its messages" (the web's previews). */
  addBusyCheck(check: (id: string) => boolean): () => void {
    this.busyChecks.add(check)
    return () => {
      this.busyChecks.delete(check)
    }
  }

  /** A digest or a preview of the account is running: what is stored must not be deleted under it. */
  isBusy(id: string): boolean {
    return this.isDigestBusy(id) || [...this.busyChecks].some((check) => check(id))
  }

  /**
   * The other ids of the same person that the account's running connection knows for `conversationId`. LOCAL knowledge only
   * (memory and the platform's stored mapping): asking for it never makes the client query WhatsApp (RNF-01, RNF-17).
   */
  async aliasesOf(id: string, conversationId: string): Promise<string[]> {
    const unit = this.units.get(id)
    if (unit === undefined) return []
    try {
      return (await unit.connection.aliasesOf?.(conversationId)) ?? []
    } catch {
      return []
    }
  }

  private aliasHost(unit: Unit): AliasHost {
    return {
      layout: this.ctx.layout,
      account: accountLayoutOf(this.ctx.layout, unit.id),
      runtime: unit.runtime,
      reload: () => this.reloadConfig(unit.id),
      applyInMemory: (edits) => this.applyMarksInMemory(unit, edits),
      isBusy: () => this.isBusy(unit.id),
      deferPurge: (ids) => {
        const set = this.deferredPurges.get(unit.id) ?? new Set<string>()
        for (const id of ids) set.add(id)
        this.deferredPurges.set(unit.id, set)
      },
    }
  }

  /** The configuration with the marks that are only in memory added: they are never lost when the files are read again. */
  private withPendingMarks(id: string, config: AppConfig): AppConfig {
    const pending = this.pendingMarks.get(id)
    if (pending === undefined || pending.length === 0) return config
    const lists = {
      excludePatterns: [...config.digest.excludePatterns],
      localOnlyPatterns: [...config.localOnlyPatterns],
    }
    for (const edit of pending) {
      if (edit.present && !hasIdPattern(lists[edit.list], edit.id)) lists[edit.list].push(idPattern(edit.id))
    }
    return {
      ...config,
      localOnlyPatterns: lists.localOnlyPatterns,
      digest: { ...config.digest, excludePatterns: lists.excludePatterns },
    }
  }

  private applyMarksInMemory(unit: Unit, edits: readonly PrivacyEdit[]): void {
    const pending = this.pendingMarks.get(unit.id) ?? []
    for (const edit of edits) {
      if (!pending.some((p) => p.list === edit.list && p.id.toLowerCase() === edit.id.toLowerCase())) pending.push(edit)
    }
    this.pendingMarks.set(unit.id, pending)
    try {
      unit.daemon.applyConfig(this.withPendingMarks(unit.id, unit.runtime.config))
    } catch (error) {
      scopedLogger(this.ctx.logger, { account: unit.id }).error('conversation.aliasFailed', { code: errorCode(error) })
    }
  }

  private async coverAlias(unit: Unit, a: string, b: string): Promise<void> {
    const logger = scopedLogger(this.ctx.logger, { account: unit.id })
    try {
      // The unit may be gone, or replaced, by the time the event is looked at.
      if (this.units.get(unit.id) !== unit) return
      const covered = await coverAlias(this.aliasHost(unit), a, b)
      if (covered.added > 0) logger.info('conversation.aliasCovered', { count: covered.added })
    } catch (error) {
      logger.error('conversation.aliasFailed', { code: errorCode(error) })
    }
  }

  /**
   * When a unit starts (and when a link is adopted): every pair of ids the connection already knows is looked at (the
   * ones learned during the link had no listener), and what is stored under an excluded id is deleted (an earlier deletion
   * may have been deferred, or lost with a restart).
   */
  private async sweepMarks(unit: Unit): Promise<void> {
    const logger = scopedLogger(this.ctx.logger, { account: unit.id })
    try {
      for (const [a, b] of unit.connection.knownAliases?.() ?? []) await this.coverAlias(unit, a, b)
      const ids = unit.runtime.config.digest.excludePatterns
        .map((pattern) => exactIdOf(pattern))
        .filter((id): id is string => id !== null && id !== '')
      purgeNow(this.aliasHost(unit), ids)
    } catch (error) {
      logger.error('conversation.aliasFailed', { code: errorCode(error) })
    }
  }

  /** At every look: writes again the marks that were only put in memory, and runs the deletions that were deferred. */
  private async housekeepMarks(id: string): Promise<void> {
    const unit = this.units.get(id)
    if (unit === undefined) return
    try {
      const pending = this.pendingMarks.get(id)
      if (pending !== undefined && pending.length > 0) {
        const written = await editAccountPrivacyLists({
          rootFile: this.ctx.layout.configFile,
          accountFile: accountLayoutOf(this.ctx.layout, id).configFile,
          edits: pending,
        })
        if (written.ok && this.units.get(id) === unit) {
          this.pendingMarks.delete(id)
          await this.reloadConfig(id)
        }
      }
      const deferred = this.deferredPurges.get(id)
      if (deferred !== undefined && deferred.size > 0 && !this.isBusy(id)) {
        this.deferredPurges.delete(id)
        purgeNow(this.aliasHost(unit), [...deferred])
      }
    } catch (error) {
      scopedLogger(this.ctx.logger, { account: id }).error('conversation.aliasFailed', { code: errorCode(error) })
    }
  }

  /** True while a link or a retry of this host holds the account (a temporary runtime must not be opened on it then). */
  isClaimed(id: string): boolean {
    return this.links.has(id)
  }

  /**
   * "Summarize now" (RF-63): starts a digest on the account's running unit and returns at once; how it goes is told through
   * `onDigest`. It needs a unit because delivery needs the account's connection (`msum digest` stays for offline use).
   * `busy` (nothing started) when a digest of the account is running, scheduled ones included (RF-66): known at once, the
   * check and the claim of the slot happen in the same synchronous step.
   */
  digestNow(id: string): DigestNowResult {
    const unit = this.units.get(id)
    if (this.stopping !== null || unit === undefined || unit.daemon.blocked !== null || this.links.has(id)) {
      return { ok: false, reason: 'notRunning' }
    }
    if (unit.daemon.digestBusy) return { ok: false, reason: 'busy' }
    // Decided in the same step as the call, so what is answered is what happens. `runDigestNow` never rejects: every
    // failure inside it is reported as an event.
    const deferred = !unit.daemon.settled
    void unit.daemon.runDigestNow('manual')
    return { ok: true, deferred }
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
    for (const [id, active] of [...this.links]) {
      if (!ids.includes(id)) {
        active.flow?.cancel()
        active.cancelRequested = true
      }
    }
    for (const id of [...this.linkSnapshots.keys()])
      if (!ids.includes(id) && !this.links.has(id)) this.linkSnapshots.delete(id)
    for (const id of [...this.idleReasons.keys()]) if (!ids.includes(id)) this.idleReasons.delete(id)
    for (const id of [...this.blocks.keys()]) if (!ids.includes(id)) this.blocks.delete(id)
    // A unit that has stayed connected long enough has recovered: only now do its earlier failures stop counting.
    for (const [id, since] of this.connectedSince) {
      if (this.failures.has(id) && Date.now() - since >= this.timing.unitStableMs) this.failures.delete(id)
    }
    // A config file edited by hand (or by another process) while the unit runs: applied without reconnecting.
    for (const id of [...this.units.keys()]) {
      await this.refreshConfig(id)
      await this.housekeepMarks(id)
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
    // The lock of an account this host is linking is its own, not someone else's: nothing to start, stop or say.
    if (this.links.has(id)) return false
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
      // A block that changes reason while the account stays blocked is no change of state: said here (the web shows it).
      if (entry !== undefined && entry.reason !== marker.reason) this.notifyChange()
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
    this.notifyChange()
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
        if ((await this.foreignLinkHolder(id)) !== null) return // stays unwritten: written once the lock is gone
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

  /** The pid that holds the link lock of an account when it is not this host: its own lock does not count. */
  private foreignLinkHolder(id: string): Promise<number | null> {
    if (this.links.has(id)) return Promise.resolve(null)
    return linkLockHolder(accountLayoutOf(this.ctx.layout, id))
  }

  /**
   * Starts the unit of an account. `adopted` is the runtime and the open socket of a link this host just finished: the
   * unit takes them over, so the socket is not closed and opened again (that is how a number gets flagged).
   */
  private async startUnit(id: string, adopted?: AdoptedLink): Promise<void> {
    const account = accountLayoutOf(this.ctx.layout, id)
    const logger = scopedLogger(this.ctx.logger, { account: id })
    // What an adopted link leaves behind when the unit cannot be built: the socket stopped and the database closed.
    const abandon = async (): Promise<void> => {
      if (adopted === undefined) return
      await adopted.connection.stop().catch(() => undefined)
      try {
        adopted.runtime.close()
      } catch {
        // already closed
      }
    }
    // Before reading: an edit that lands while the unit starts is seen by the next look (see `refreshConfig`).
    const stamp = await configStamp([this.ctx.layout.configFile, account.configFile])
    const loaded = await loadEffectiveConfig(this.ctx.layout.configFile, account.configFile)
    if (!loaded.ok) {
      await abandon()
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
      await abandon()
      if (this.idleReasons.get(id) !== 'noProvider') {
        this.idleReasons.set(id, 'noProvider')
        logger.error('account.noProvider', {})
        this.ctx.io.err(texts.config.noProvider)
      }
      this.setState(id, 'idle')
      return
    }
    this.idleReasons.delete(id)
    this.configStamps.set(id, stamp)
    this.invalidConfigs.delete(id)
    // A unit is being started, so nothing is blocked: whatever the host remembered of an earlier block is dropped, and
    // cannot make a later block look cleared (or not cleared).
    this.blocks.delete(id)

    let runtime: Runtime | null = null
    try {
      runtime =
        adopted?.runtime ??
        createRuntime({
          layout: account,
          config,
          env: this.ctx.env,
          clock: this.ctx.clock,
          ...(this.ctx.summarizer === undefined ? {} : { summarizer: this.ctx.summarizer }),
        })
      const connection =
        adopted?.connection ??
        (await this.ctx.connectionFactory(runtime, {
          onWarning: (code) => logger.warn('adapter.warning', { code }),
        }))
      const guarded = this.guard(id, connection, adopted !== undefined)
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
        onDigest: (event) => {
          this.emitDigest({ ...event, account: id })
          // Deletions that waited for the digest to end.
          if (event.state === 'done' || event.state === 'empty' || event.state === 'failed')
            void this.housekeepMarks(id)
        },
        // Another process (`msum schedule`) changed them: the next run the web shows is another.
        onSchedulesChanged: () => this.notifyChange(),
        // A new configuration (time zone, language) moves the next run the web shows.
        onConfigApplied: () => this.notifyChange(),
        // The host owns the order of a block: release the account first, write the marker after (see `blockUnit`).
        writesMarker: false,
        onBlocked: (reason) => {
          this.ctx.io.err(texts.daemon.blocked(texts.blockedReasons[reason](id)))
          this.blockUnit(id, reason)
        },
      })
      // Right before starting: a `link` or `unlink` may have taken the account since it was decided on, and so may a
      // link started from the web (its lock is the host's own, so it is looked for in `links`). An adopted link holds
      // the lock itself and is the one starting.
      if (adopted === undefined) {
        const foreign = (await linkLockHolder(account)) !== null
        // Looked at AFTER the await: a link or retry of this host may have claimed the account while it was waiting.
        if (foreign || this.links.has(id)) {
          runtime.close()
          return
        }
      }
      const unit: Unit = { id, runtime, daemon, connection }
      this.units.set(id, unit)
      // Two ids of one person (a LID and the phone number): a mark of one is put on the other, before the event that
      // taught the pair goes on to be stored.
      connection.onAlias?.((a, b) => this.coverAlias(unit, a, b))
      await this.sweepMarks(unit)
      await daemon.start()
    } catch (error) {
      if (adopted !== undefined && !this.units.has(id)) await adopted.connection.stop().catch(() => undefined)
      await this.failUnit(id, error, runtime)
    }
  }

  /**
   * The connection as the `Daemon` sees it, with the listeners of its status events wrapped: an exception inside the
   * reaction to an event of ONE account's socket is a failure of that unit, not of the process.
   */
  private guard(id: string, connection: DaemonConnection, alreadyOpen = false): DaemonConnection {
    return {
      // A socket a link opened is open already: starting the unit does not ask it to connect again.
      start: () => (alreadyOpen ? Promise.resolve() : connection.start()),
      stop: () => connection.stop(),
      get status() {
        return connection.status
      },
      selfChat: () => connection.selfChat(),
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
    this.notifyChange()
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
    this.notifyChange()
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
    if ((await this.foreignLinkHolder(id)) !== null) return
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

  /** True while this host is linking the account (it holds the account's link lock). */
  isLinking(id: string): boolean {
    return this.links.get(id)?.kind === 'link'
  }

  /** True once a stop was asked for. */
  get isStopping(): boolean {
    return this.stopping !== null
  }

  /** The account this host is limited to (`--account`), or null when it runs every account. */
  get onlyAccountId(): string | null {
    return this.onlyAccount
  }

  /**
   * Where the link of an account is: the one in progress, or how the last one ended. Null when this host has not linked
   * the account since it started. The QR in it is the raw pairing credential: it reaches the web only as the SVG that
   * `GET /api/accounts/:id/link/qr.svg` draws from it (behind the token), never in a JSON or an event.
   */
  linkSnapshot(id: string): LinkSnapshot | null {
    return this.linkSnapshots.get(id) ?? null
  }

  /** Calls `listener` for every QR, sync progress and outcome of a link. Returns the way to stop listening. */
  onLink(listener: (event: LinkEvent) => void): () => void {
    this.linkListeners.add(listener)
    return () => {
      this.linkListeners.delete(listener)
    }
  }

  private emitLink(event: LinkEvent): void {
    for (const listener of [...this.linkListeners]) {
      try {
        listener(event)
      } catch (error) {
        this.ctx.logger.error('daemon.listenerFailed', { code: errorCode(error) })
      }
    }
  }

  /**
   * Links an account from the web (RF-01, RF-02): the unit of the account runs in "linking" mode, which is what
   * `msum link` does inside the daemon. It answers once the link has started; the QR, the progress and the outcome
   * come through `onLink` and `linkSnapshot`.
   *
   * Refused (nothing is touched) when the account is linked and in use (`inUse`), when a `msum link` or `unlink` holds
   * its lock (`beingLinked`), when it is being linked already, or when it is blocked for a reason that retrying fixes
   * (`needsRetry`). An account that is not linked, or blocked for a reason linking fixes, is linked: in the second case
   * the old session is deleted first, as `msum link` does.
   *
   * The host holds the link lock of the account from here to the end, with its heartbeat, so a `msum link` or `unlink`
   * is refused as it would be for another process. A cancelled or failed link that bound nothing deletes the session it
   * made (the account stays registered, empty), so the next try starts clean.
   */
  async startLink(id: string): Promise<StartLinkResult> {
    if (this.stopping !== null) return { ok: false, reason: 'unavailable' }
    if (!this.accountIds().includes(id)) return { ok: false, reason: 'unknown' }
    const existing = this.links.get(id)
    if (existing !== undefined) return { ok: false, reason: existing.kind === 'link' ? 'alreadyLinking' : 'busy' }
    // Claimed before anything is awaited: a second request, or a look of the host, sees it at once.
    const active = claim('link')
    this.links.set(id, active)
    const account = accountLayoutOf(this.ctx.layout, id)
    let lock: DaemonLock | null = null
    let runtime: Runtime | null = null
    let started = false
    let removedBlock: { reason: BlockedReason; persisted: boolean; warned: boolean } | undefined
    // A shutdown or a cancel that comes while this is still preparing: nothing more is done (no session deleted, no
    // socket made or opened) and the caller is told.
    const aborted = (): StartLinkResult | null => {
      if (this.stopping !== null) return { ok: false, reason: 'unavailable' }
      return active.cancelRequested ? { ok: false, reason: 'cancelled' } : null
    }
    try {
      if (this.units.has(id)) {
        // A unit that is blocking itself is being released: wait for that before deciding it is in use.
        if (this.units.get(id)?.daemon.blocked !== null) await Promise.all([...this.releases])
        if (this.units.has(id)) return { ok: false, reason: 'inUse' }
      }
      const loaded = await loadEffectiveConfig(this.ctx.layout.configFile, account.configFile)
      if (!loaded.ok) return { ok: false, reason: 'invalidConfig' }
      if ((await unsafeAccountPath(account)) !== null) return { ok: false, reason: 'unsafePath' }
      if (!isDirectory(account.dir)) await ensureAccountDirs(account)
      const taken = await acquireLinkLock(account, this.linkLockPid)
      if (!taken.ok) return { ok: false, reason: 'beingLinked' }
      lock = taken
      const early = aborted()
      if (early !== null) return early
      // The authoritative checks: the lock is held, so nothing can change between them and the work.
      if (this.units.has(id)) return { ok: false, reason: 'inUse' }
      const marker = await readBlocked(account.blockedFile)
      const reason = marker?.reason ?? this.blocks.get(id)?.reason ?? null
      const session = await hasSession(account)
      if (reason !== null && !FIXED_BY_LINKING.includes(reason) && session) return { ok: false, reason: 'needsRetry' }
      const relinking = reason !== null && FIXED_BY_LINKING.includes(reason)
      if (reason === null && session) {
        runtime = this.openRuntime(account, loaded.value)
        if (runtime.identity.get() !== null) return { ok: false, reason: 'inUse' }
      }
      runtime ??= this.openRuntime(account, loaded.value)
      await rm(account.qrFile, { force: true })
      const beforeConnection = aborted()
      if (beforeConnection !== null) return beforeConnection

      const logger = scopedLogger(this.ctx.logger, { account: id })
      this.idleReasons.delete(id)
      this.linkSnapshots.set(id, { state: 'waitingQr' })
      this.setState(id, 'linking')
      const counted = countingCapture(runtime.capture)
      const connection = await this.ctx.connectionFactory(runtime, {
        capture: counted.capture,
        onWarning: (code) => logger.warn('adapter.warning', { code }),
      })
      // The block is forgotten only now that the link has a connection: a start that fails before it keeps it.
      removedBlock = this.blocks.get(id)
      this.blocks.delete(id)
      const beforeClear = aborted()
      if (beforeClear !== null) return beforeClear
      if (relinking) await connection.clearSession()
      const afterClear = aborted()
      if (afterClear !== null) return afterClear
      const heartbeat = setInterval(() => void taken.heartbeat(), this.linkHeartbeatMs)
      heartbeat.unref()
      const flow = this.makeFlow(id, runtime, connection, counted)
      active.flow = flow
      logger.info('link.started', { reason: relinking ? 'relink' : 'new' })
      this.emitLink({ type: 'link', account: id, state: 'waitingQr' })
      this.notifyChange()
      const ownedRuntime = runtime
      void this.runLink(id, { account, runtime: ownedRuntime, connection, flow, lock: taken, heartbeat, active })
      started = true
      if (active.cancelRequested || this.stopping !== null) flow.cancel()
      return { ok: true }
    } catch (error) {
      scopedLogger(this.ctx.logger, { account: id }).error('link.startFailed', { code: errorCode(error) })
      // It did not start: the page is told so, and a block that was only in memory is still there.
      if (removedBlock !== undefined && !this.blocks.has(id)) this.blocks.set(id, removedBlock)
      this.linkSnapshots.set(id, { state: 'failed', error: 'failed' })
      this.emitLink({ type: 'link', account: id, state: 'failed', error: 'failed' })
      throw error
    } finally {
      if (!started) {
        try {
          runtime?.close()
        } catch {
          // already closed
        }
        // An abort (not a throw) leaves the block as it was too.
        if (removedBlock !== undefined && !this.blocks.has(id)) this.blocks.set(id, removedBlock)
        this.links.delete(id)
        // A release that fails must not keep `done` pending: a DELETE waiting on it would never answer.
        await lock?.release().catch(() => undefined)
        if (this.states.get(id)?.state === 'linking') {
          const kept = this.blocks.get(id)
          if (kept === undefined) this.setState(id, 'idle')
          else this.setState(id, 'blocked')
        }
        if (this.linkSnapshots.get(id)?.state === 'waitingQr') {
          this.linkSnapshots.set(id, { state: 'failed', error: 'cancelled' })
        }
        active.finish()
      }
    }
  }

  private openRuntime(account: ReturnType<typeof accountLayoutOf>, config: AppConfig): Runtime {
    return createRuntime({
      layout: account,
      config,
      env: this.ctx.env,
      clock: this.ctx.clock,
      ...(this.ctx.summarizer === undefined ? {} : { summarizer: this.ctx.summarizer }),
    })
  }

  private makeFlow(id: string, runtime: Runtime, connection: ManagedConnection, counted: CountingCapture): LinkFlow {
    let phase: LinkPhase = 'waitingQr'
    const account = accountLayoutOf(this.ctx.layout, id)
    return new LinkFlow({
      runtime,
      connection,
      activity: counted,
      timing: this.ctx.linkTiming,
      onSnapshot: (snapshot) => {
        this.linkSnapshots.set(id, snapshot)
        // The raw QR goes to `onLink` listeners (the web turns it into an SVG on request) and nowhere else: not to disk, not
        // to a log, not to an event of the stream.
        if (snapshot.state === 'qr' && snapshot.qr !== undefined) {
          this.emitLink({ type: 'qr', account: id, qr: snapshot.qr })
        }
        // How a link ends is announced by `runLink`, once the socket is handed over or everything is released: a page that
        // reacts to `done` or `failed` may ask for a new link at once.
        if (snapshot.state !== phase && snapshot.state !== 'done' && snapshot.state !== 'failed') {
          this.emitLink({
            type: 'link',
            account: id,
            state: snapshot.state,
            ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
          })
        }
        phase = snapshot.state
      },
      onSync: (progress) => {
        // The snapshot a page finds when it (re)connects carries the latest progress, not the one of the last state change.
        const current = this.linkSnapshots.get(id)
        if (current !== undefined && (current.state === 'syncing' || current.state === 'done')) {
          this.linkSnapshots.set(id, { ...current, sync: progress })
        }
        this.emitLink({ type: 'sync', account: id, ...progress })
      },
      // The account is bound and its session is real: whatever it was blocked for no longer applies (as `msum link`).
      onBound: async () => {
        await clearBlocked(account.blockedFile)
        this.notifyChange()
      },
    })
  }

  /** The life of a link after it started: the flow, then either the unit takes over or everything is cleaned up. */
  private async runLink(
    id: string,
    link: {
      readonly account: ReturnType<typeof accountLayoutOf>
      readonly runtime: Runtime
      readonly connection: ManagedConnection
      readonly flow: LinkFlow
      readonly lock: Extract<DaemonLock, { ok: true }>
      readonly heartbeat: ReturnType<typeof setInterval>
      readonly active: ActiveLink
    },
  ): Promise<void> {
    const logger = scopedLogger(this.ctx.logger, { account: id })
    let ended: LinkEvent = { type: 'link', account: id, state: 'failed', error: 'failed' }
    try {
      let result: LinkFlowResult
      try {
        result = await link.flow.run()
      } catch (error) {
        logger.error('link.crashed', { code: errorCode(error) })
        result = { ok: false, error: 'failed', bound: false }
      }
      if (result.ok) {
        logger.info('link.done', {})
        // The unit takes over the socket the link opened: schedules, delivery and catch-up start, nothing reconnects.
        await this.startUnit(id, { runtime: link.runtime, connection: link.connection })
        ended = { type: 'link', account: id, state: 'done' }
      } else {
        logger.warn('link.failed', { reason: result.error })
        await link.connection.stop().catch(() => undefined)
        // Nothing bound: the session is a half-made one and goes. A session that was bound stays (the account is
        // linked), unless WhatsApp closed it.
        if (result.error === 'loggedOut' || !result.bound) {
          await link.connection.clearSession().catch((error: unknown) => {
            logger.error('link.clearFailed', { code: errorCode(error) })
          })
        }
        try {
          link.runtime.close()
        } catch {
          // already closed
        }
        // WhatsApp ended the connection after the account was bound (during the sync): the account is blocked as a
        // `Daemon` would block it, so it idles until a deliberate retry or relink and nothing reconnects by itself. The
        // socket is stopped and the database closed (above) BEFORE the marker is written, and the lock is released after.
        const blockedFor = result.bound ? BLOCK_AFTER_LINK[result.error] : undefined
        if (blockedFor === undefined) this.setState(id, 'idle')
        else {
          this.blocks.set(id, { reason: blockedFor, persisted: false, warned: false })
          this.setIdle(id, `blocked:${blockedFor}`, 'blocked', blockedFor)
          await this.persistBlock(id)
        }
        ended = { type: 'link', account: id, state: 'failed', error: result.error }
      }
    } catch (error) {
      logger.error('link.endFailed', { code: errorCode(error) })
      this.linkSnapshots.set(id, { state: 'failed', error: 'failed' })
    } finally {
      clearInterval(link.heartbeat)
      // Last: only now may the daemon, or a command, take the account.
      await link.lock.release().catch(() => undefined)
      this.links.delete(id)
      link.active.finish()
    }
    this.emitLink(ended)
    this.notifyChange()
    if (this.stopping === null) void this.reconcile()
  }

  /** Cancels the link in progress of an account and waits until it is over. False when there is none. */
  async cancelLink(id: string): Promise<boolean> {
    const active = this.links.get(id)
    if (active?.kind !== 'link') return false
    active.cancelRequested = true
    active.flow?.cancel()
    await active.done
    return true
  }

  /**
   * `msum retry` from the web: clears the block of an account if retrying fixes it, under the account's link lock.
   * The unit starts on the next look of the host (this asks for one).
   *
   * For a block WhatsApp asked to wait for (`forbidden`, `replaced`) it is refused (`tooSoon`, with when it is allowed)
   * until `WEB_RETRY_MIN_WAIT_MS` have passed since the block: one click of a button must not reconnect at once. The
   * commands `msum retry` and `msum daemon --retry` do not wait (typed on purpose), and use `retryBlock` directly.
   */
  async retryAccount(id: string): Promise<RetryAccountResult> {
    if (!this.accountIds().includes(id)) return { ok: false, reason: 'unknown' }
    const existing = this.links.get(id)
    if (existing !== undefined) return { ok: false, reason: existing.kind === 'link' ? 'alreadyLinking' : 'busy' }
    // Claimed before anything is awaited, like a link: the lock below is this process's, and a second one by the same
    // pid would be taken over instead of refused.
    const active = claim('retry')
    this.links.set(id, active)
    const account = accountLayoutOf(this.ctx.layout, id)
    let lock: DaemonLock | null = null
    try {
      if ((await unsafeAccountPath(account)) !== null) return { ok: false, reason: 'unsafePath' }
      lock = isDirectory(account.dir) ? await acquireLinkLock(account, this.linkLockPid) : null
      if (lock !== null && !lock.ok) return { ok: false, reason: 'beingLinked' }
      const marker = await readBlocked(account.blockedFile)
      const blockedFor = marker?.reason ?? this.blocks.get(id)?.reason ?? null
      if (blockedFor !== null && WAIT_BEFORE_RETRY.includes(blockedFor)) {
        // The time of the block: its marker, or (a block only in memory) when the account became blocked.
        const at = marker?.at ?? this.states.get(id)?.since ?? null
        if (at !== null && this.ctx.clock.now() < at + WEB_RETRY_MIN_WAIT_MS) {
          return { ok: false, reason: 'tooSoon', retryAfter: at + WEB_RETRY_MIN_WAIT_MS }
        }
      }
      const outcome = await retryBlock(account)
      const remembered = this.blocks.get(id)
      if (outcome.result === 'needsRelink') return { ok: false, reason: 'needsRelink' }
      if (outcome.result === 'notBlocked') {
        // A block that is only in memory (its marker could not be written) is a block too.
        if (remembered === undefined) return { ok: false, reason: 'notBlocked' }
        if (FIXED_BY_LINKING.includes(remembered.reason)) return { ok: false, reason: 'needsRelink' }
      }
      this.blocks.delete(id)
      scopedLogger(this.ctx.logger, { account: id }).info('account.retried', {
        reason: outcome.result === 'cleared' ? outcome.reason : (remembered?.reason ?? 'unknown'),
      })
      return { ok: true }
    } finally {
      if (lock?.ok === true) await lock.release().catch(() => undefined)
      this.links.delete(id)
      active.finish()
      if (this.stopping === null) void this.reconcile()
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
    this.pendingMarks.delete(id)
    this.deferredPurges.delete(id)
    this.connectedSince.delete(id)
    this.configStamps.delete(id)
    this.invalidConfigs.delete(id)
    this.reloadFailures.delete(id)
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
    // A link in progress is cancelled (its socket stopped, its lock released) before the units are stopped, in the same
    // half of the budget: one that is handing its socket over to a unit finishes that first.
    for (const active of this.links.values()) {
      active.cancelRequested = true
      active.flow?.cancel()
    }
    await within(Promise.all([...this.links.values()].map((active) => active.done)), budget / 2 - (Date.now() - begun))
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
