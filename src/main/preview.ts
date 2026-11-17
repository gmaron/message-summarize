import { existsSync } from 'node:fs'
import type { DigestErrorCode } from '../infrastructure/i18n/index.js'
import { isDirectory } from './accounts.js'
import { loadEffectiveConfig } from './config.js'
import type { CommandContext } from './context.js'
import { linkLockHolder } from './link-lock.js'
import { errorCode } from './logger.js'
import { accountLayoutOf, unsafeAccountPath } from './paths.js'
import { runDigest } from './run-digest.js'
import { createRuntime, type Runtime } from './runtime.js'

/** How long a finished preview is kept: it is private text, so it does not stay around. */
export const DEFAULT_PREVIEW_TTL_MS = 30 * 60_000

/** What `GET /api/accounts/:id/preview` says. `parts` is the content: private, and never in an event or a log. */
export interface PreviewView {
  readonly state: 'none' | 'running' | 'done' | 'empty' | 'failed'
  /** Epoch ms when it finished. */
  readonly generatedAt?: number
  readonly parts?: readonly string[]
  readonly summarized?: number
  readonly failed?: number
  readonly error?: DigestErrorCode
}

/** What the `preview` event says: how it ended, never what it holds. */
export interface PreviewEvent {
  readonly account: string
  readonly state: 'done' | 'empty' | 'failed'
  readonly error?: DigestErrorCode
}

export type StartPreviewResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: 'busy' | 'beingLinked' | 'invalidConfig' | 'unavailable' | 'unsafePath'
    }

/** What the previews need of the host of the accounts. */
export interface PreviewHost {
  /** The runtime of the account's running unit, if it has one. */
  runtimeOf(id: string): Runtime | undefined
  /** A link or a retry of the host holds the account. */
  isClaimed(id: string): boolean
  readonly isStopping: boolean
}

export interface PreviewServiceOptions {
  readonly ctx: Pick<CommandContext, 'env' | 'layout' | 'clock' | 'logger' | 'summarizer'>
  readonly host: PreviewHost
  /** Told when a preview ends. */
  readonly onEvent: (event: PreviewEvent) => void
  /** How long a finished preview is kept. Default 30 minutes. */
  readonly ttlMs?: number
  /**
   * Tells which incarnation of the account is registered now (its creation time), or null when it does not exist. A
   * preview belongs to the incarnation it was made for: an account deleted and created again with the same id does not
   * inherit it.
   */
  readonly accountStamp: (id: string) => string | null
  /** Opens the temporary runtime of an account that has no unit. Default `createRuntime`; tests watch it. */
  readonly openRuntime?: typeof createRuntime
}

interface Entry {
  readonly stamp: string | null
  state: 'running' | 'done' | 'empty' | 'failed'
  generatedAt?: number
  parts?: readonly string[]
  summarized?: number
  failed?: number
  error?: DigestErrorCode
  timer?: ReturnType<typeof setTimeout>
}

/**
 * The previews of the web (RF-64): the digest generated WITHOUT saving it, sending it or moving the pointer (the use case
 * runs with `preview: true`, which writes nothing). The result is private chat text, so it lives in memory only: the
 * latest one of each account, dropped after `ttlMs`, when a new preview of the account starts, and at shutdown. It is
 * never written to disk or to a log, and the `preview` event does not carry it: the page asks for it (behind the token).
 *
 * One preview at a time per account. It runs on the runtime of the account's unit when there is one; otherwise on a
 * temporary runtime (what `msum digest --dry-run` does), closed when the preview ends or at shutdown, and never while a
 * link or a retry of this host or another process (`msum link`) holds the account.
 */
export class PreviewService {
  private readonly entries = new Map<string, Entry>()
  /** Accounts with a preview being started or running: claimed synchronously, so two requests never both start. */
  private readonly active = new Set<string>()
  /** The temporary runtimes in use, so a shutdown can close them. */
  private readonly temporary = new Set<Runtime>()
  private readonly ttlMs: number
  private stopped = false

  constructor(private readonly options: PreviewServiceOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PREVIEW_TTL_MS
  }

  /** What the page shows of the account's latest preview. */
  get(id: string): PreviewView {
    const entry = this.entries.get(id)
    if (entry === undefined) return { state: 'none' }
    if (entry.stamp !== this.options.accountStamp(id)) {
      this.drop(id)
      return { state: 'none' }
    }
    if (entry.state === 'running') return { state: 'running' }
    return {
      state: entry.state,
      ...(entry.generatedAt === undefined ? {} : { generatedAt: entry.generatedAt }),
      ...(entry.parts === undefined ? {} : { parts: entry.parts }),
      ...(entry.summarized === undefined ? {} : { summarized: entry.summarized }),
      ...(entry.failed === undefined ? {} : { failed: entry.failed }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }
  }

  /**
   * Starts a preview in the background and answers once it is under way. A refusal keeps the previous result. The
   * account is claimed before anything is awaited.
   */
  async start(id: string): Promise<StartPreviewResult> {
    const { ctx, host } = this.options
    if (this.stopped || host.isStopping) return { ok: false, reason: 'unavailable' }
    if (this.active.has(id)) return { ok: false, reason: 'busy' }
    this.active.add(id)
    let temporary: Runtime | null = null
    let begun = false
    try {
      let runtime = host.runtimeOf(id)
      let nothingLinked = false
      if (runtime === undefined) {
        if (host.isClaimed(id)) return { ok: false, reason: 'busy' }
        const account = accountLayoutOf(ctx.layout, id)
        if ((await unsafeAccountPath(account)) !== null) return { ok: false, reason: 'unsafePath' }
        if ((await linkLockHolder(account)) !== null) return { ok: false, reason: 'beingLinked' }
        const loaded = await loadEffectiveConfig(ctx.layout.configFile, account.configFile)
        if (!loaded.ok) return { ok: false, reason: 'invalidConfig' }
        // Looked at again after the awaits: a link, a shutdown or a unit may have appeared meanwhile.
        if (this.stopped || host.isStopping) return { ok: false, reason: 'unavailable' }
        if (host.isClaimed(id)) return { ok: false, reason: 'busy' }
        runtime = host.runtimeOf(id)
        if (runtime === undefined) {
          // Opening the database would create it: an account with none has nothing to summarize.
          nothingLinked = !isDirectory(account.dir) || !existsSync(account.dbFile)
          if (!nothingLinked) {
            // Looked at once more right before opening, as `startUnit` does: a `msum link` may have taken the account
            // during the awaits above. The lock is NOT held for the whole preview: it only reads, with the exposure of
            // `msum digest --dry-run` next to a running daemon, and the window left here is a few microseconds.
            if ((await linkLockHolder(account)) !== null) return { ok: false, reason: 'beingLinked' }
            if (this.stopped || host.isStopping) return { ok: false, reason: 'unavailable' }
            if (host.isClaimed(id) || host.runtimeOf(id) !== undefined) return { ok: false, reason: 'busy' }
            runtime = (this.options.openRuntime ?? createRuntime)({
              layout: account,
              config: loaded.value,
              env: ctx.env,
              clock: ctx.clock,
              ...(ctx.summarizer === undefined ? {} : { summarizer: ctx.summarizer }),
            })
            temporary = runtime
            this.temporary.add(temporary)
          }
        }
      }
      const entry = this.replace(id, { state: 'running', stamp: this.options.accountStamp(id) })
      begun = true
      void this.run(id, entry, runtime ?? null, temporary)
      return { ok: true }
    } finally {
      if (!begun) {
        if (temporary !== null) this.release(temporary)
        this.active.delete(id)
      }
    }
  }

  /** Drops the preview of an account (a new link of it began). */
  forget(id: string): void {
    this.drop(id)
  }

  /** Drops the previews of accounts that are gone or were created again. */
  prune(): void {
    for (const [id, entry] of [...this.entries]) if (entry.stamp !== this.options.accountStamp(id)) this.drop(id)
  }

  private drop(id: string): void {
    const entry = this.entries.get(id)
    if (entry?.timer !== undefined) clearTimeout(entry.timer)
    this.entries.delete(id)
  }

  /** Drops everything and closes what is open. In-flight previews end quietly: nothing is kept or announced. */
  stop(): void {
    this.stopped = true
    for (const entry of this.entries.values()) if (entry.timer !== undefined) clearTimeout(entry.timer)
    this.entries.clear()
    for (const runtime of [...this.temporary]) this.release(runtime)
  }

  /** Puts a new entry in place of the previous one (which is discarded). */
  private replace(id: string, entry: Entry): Entry {
    const previous = this.entries.get(id)
    if (previous?.timer !== undefined) clearTimeout(previous.timer)
    this.entries.set(id, entry)
    return entry
  }

  private release(runtime: Runtime): void {
    if (!this.temporary.delete(runtime)) return
    try {
      runtime.close()
    } catch {
      // already closed
    }
  }

  private async run(id: string, entry: Entry, runtime: Runtime | null, temporary: Runtime | null): Promise<void> {
    const { ctx, onEvent } = this.options
    let event: PreviewEvent
    try {
      if (runtime === null) {
        Object.assign(entry, { state: 'empty', parts: [], summarized: 0, failed: 0 })
        event = { account: id, state: 'empty' }
      } else {
        const result = await runDigest(runtime, { preview: true })
        if (!result.ok) {
          const error: DigestErrorCode = result.error.kind
          Object.assign(entry, { state: 'failed', error })
          event = { account: id, state: 'failed', error }
        } else {
          const { digest, parts, summarized, failed } = result.value
          const state = digest === null ? 'empty' : 'done'
          Object.assign(entry, { state, parts: [...parts], summarized, failed: failed.length })
          event = { account: id, state }
        }
      }
    } catch (error) {
      // A runtime closed under the preview (the unit stopped, or a shutdown) ends here too.
      ctx.logger.error('preview.failed', { account: id, code: errorCode(error) })
      Object.assign(entry, { state: 'failed', error: 'failed' satisfies DigestErrorCode })
      event = { account: id, state: 'failed', error: 'failed' }
    } finally {
      if (temporary !== null) this.release(temporary)
      this.active.delete(id)
    }
    // Discarded meanwhile (a shutdown): nothing is kept, announced or logged.
    if (this.entries.get(id) !== entry || this.stopped) return
    if (entry.stamp !== this.options.accountStamp(id)) {
      this.drop(id)
      return
    }
    entry.generatedAt = ctx.clock.now()
    entry.timer = setTimeout(() => {
      if (this.entries.get(id) === entry) this.entries.delete(id)
    }, this.ttlMs)
    entry.timer.unref()
    ctx.logger.info('preview.finished', {
      account: id,
      state: entry.state,
      ...(entry.parts === undefined ? {} : { parts: entry.parts.length }),
      ...(entry.summarized === undefined ? {} : { summarized: entry.summarized }),
      ...(entry.failed === undefined ? {} : { failed: entry.failed }),
      ...(entry.error === undefined ? {} : { reason: entry.error }),
    })
    try {
      onEvent(event)
    } catch (error) {
      ctx.logger.error('preview.eventFailed', { code: errorCode(error) })
    }
  }
}
