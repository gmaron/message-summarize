import { type AskItem, cleanQuestion } from '../application/ask-chats.js'
import type { WebErrorCode } from '../infrastructure/i18n/index.js'
import type { CommandContext } from './context.js'
import { errorCode } from './logger.js'
import type { Runtime } from './runtime.js'

/** The periods the page offers. */
export const ASK_PERIODS = ['today', 'h24', 'd3', 'd7'] as const
export type AskPeriod = (typeof ASK_PERIODS)[number]

/** The most requests kept per account: the oldest is dropped when another is made. */
export const MAX_ASKS_PER_ACCOUNT = 20

const HOUR_MS = 3_600_000

/** What the page shows of one request. The text of the answers is private: it is only in the `GET`, never in an event or a log. */
export interface AskView {
  readonly id: number
  readonly question: string
  readonly period: AskPeriod
  readonly chats: readonly string[]
  readonly state: 'running' | 'done' | 'failed'
  readonly createdAt: number
  readonly finishedAt?: number
  readonly since: number
  readonly until: number
  readonly consulted?: number
  readonly failedChats?: number
  readonly items?: readonly AskItem[]
  readonly error?: WebErrorCode | 'failed'
}

/** What the `ask` event says: that a request ended and how, never what it holds. */
export interface AskEvent {
  readonly account: string
  readonly id: number
  readonly state: 'done' | 'failed'
  readonly error?: WebErrorCode | 'failed'
}

export type StartAskResult =
  | { readonly ok: true; readonly id: number }
  | { readonly ok: false; readonly reason: 'busy' | 'notRunning' | 'noProvider' | 'unavailable' | 'emptyQuestion' }

/** What the requests need of the host of the accounts. */
export interface AskHost {
  /** The runtime of the account's running unit, if it has one. */
  runtimeOf(id: string): Runtime | undefined
  readonly isStopping: boolean
}

export interface AskServiceOptions {
  readonly ctx: Pick<CommandContext, 'clock' | 'logger'>
  readonly host: AskHost
  readonly onEvent: (event: AskEvent) => void
  /** The creation time of the registered incarnation of the account, or null when it does not exist (as the previews). */
  readonly accountStamp: (id: string) => string | null
}

interface Entry {
  readonly stamp: string | null
  view: AskView
}

/** The wall clock of an instant in the time zone, read as if it were UTC, minus the instant: the zone offset then. */
function offsetAt(instant: number, timeZone: string): { offset: number; year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
  return { offset: wall - Math.floor(instant / 1000) * 1000, year: n('year'), month: n('month'), day: n('day') }
}

/**
 * The start of the local day of `now` in the time zone, in epoch ms. The offset is the one in force at that midnight,
 * not at `now`: on the day the clocks change they differ.
 */
export function startOfLocalDay(now: number, timeZone: string): number {
  const at = offsetAt(now, timeZone)
  const wallMidnight = Date.UTC(at.year, at.month - 1, at.day)
  const guess = wallMidnight - at.offset
  return wallMidnight - offsetAt(guess, timeZone).offset
}

/** The window of a period, ending now. */
export function windowOf(period: AskPeriod, now: number, timeZone: string): { since: number; until: number } {
  switch (period) {
    case 'today':
      return { since: startOfLocalDay(now, timeZone), until: now }
    case 'h24':
      return { since: now - 24 * HOUR_MS, until: now }
    case 'd3':
      return { since: now - 72 * HOUR_MS, until: now }
    case 'd7':
      return { since: now - 168 * HOUR_MS, until: now }
  }
}

/**
 * The free requests of the web ("Ask"): what the owner asks about the chats of a period, answered by the providers of
 * the account without saving anything in the database, sending anything or moving the digest pointer. The answers are
 * private chat text, so they live in memory only, the latest `MAX_ASKS_PER_ACCOUNT` of each account, and are lost when the
 * program restarts, when the account is deleted or linked again, and when the owner deletes them.
 *
 * One request at a time per account. It runs on the runtime of the account's unit: without one (not linked, blocked,
 * starting) there is nothing connected to ask, as for "Summarize now".
 */
export class AskService {
  private readonly entries = new Map<string, Entry[]>()
  private readonly active = new Set<string>()
  private counter = 0
  private stopped = false

  constructor(private readonly options: AskServiceOptions) {}

  isBusy(id: string): boolean {
    return this.active.has(id)
  }

  /** The requests of the account, the latest first. */
  list(id: string): readonly AskView[] {
    const list = this.entries.get(id)
    if (list === undefined) return []
    if (list.length > 0 && list[0]?.stamp !== this.options.accountStamp(id)) {
      this.entries.delete(id)
      return []
    }
    return [...list].reverse().map((entry) => entry.view)
  }

  start(
    id: string,
    input: { readonly question: string; readonly period: AskPeriod; readonly chats: readonly string[] },
  ): StartAskResult {
    const { ctx, host } = this.options
    if (this.stopped || host.isStopping) return { ok: false, reason: 'unavailable' }
    // What is stored and shown is what the model gets.
    const question = cleanQuestion(input.question)
    if (question === '') return { ok: false, reason: 'emptyQuestion' }
    if (this.active.has(id)) return { ok: false, reason: 'busy' }
    const runtime = host.runtimeOf(id)
    if (runtime === undefined) return { ok: false, reason: 'notRunning' }
    const askChats = runtime.askChats
    if (askChats === null) return { ok: false, reason: 'noProvider' }

    this.active.add(id)
    const now = ctx.clock.now()
    const window = windowOf(input.period, now, runtime.config.timezone)
    const entry: Entry = {
      stamp: this.options.accountStamp(id),
      view: {
        id: ++this.counter,
        question,
        period: input.period,
        chats: input.chats,
        state: 'running',
        createdAt: now,
        since: window.since,
        until: window.until,
      },
    }
    const list = this.entries.get(id) ?? []
    if (list.length > 0 && list[0]?.stamp !== entry.stamp) list.length = 0
    list.push(entry)
    while (list.length > MAX_ASKS_PER_ACCOUNT) list.shift()
    this.entries.set(id, list)
    void this.run(id, entry, runtime, askChats, window)
    return { ok: true, id: entry.view.id }
  }

  /** Deletes one request. False when it does not exist. */
  remove(id: string, askId: number): boolean {
    const list = this.entries.get(id)
    const at = list?.findIndex((entry) => entry.view.id === askId) ?? -1
    if (list === undefined || at < 0) return false
    list.splice(at, 1)
    return true
  }

  /** Drops the requests of an account (a new link of it began). */
  forget(id: string): void {
    this.entries.delete(id)
  }

  /** Drops the requests of accounts that are gone or were created again. */
  prune(): void {
    for (const [id, list] of [...this.entries]) {
      if (list.length === 0 || list[0]?.stamp !== this.options.accountStamp(id)) this.entries.delete(id)
    }
  }

  /** Drops everything. Requests in flight end quietly. */
  stop(): void {
    this.stopped = true
    this.entries.clear()
  }

  private async run(
    id: string,
    entry: Entry,
    runtime: Runtime,
    askChats: NonNullable<Runtime['askChats']>,
    window: { since: number; until: number },
  ): Promise<void> {
    const { ctx, onEvent } = this.options
    let event: AskEvent
    try {
      const result = await askChats({
        question: entry.view.question,
        window,
        chats: entry.view.chats,
        settings: runtime.config.digest,
        concurrency: runtime.config.concurrency,
      })
      if (result.ok) {
        entry.view = {
          ...entry.view,
          state: 'done',
          finishedAt: ctx.clock.now(),
          consulted: result.value.consulted,
          failedChats: result.value.failed,
          items: result.value.items,
        }
        event = { account: id, id: entry.view.id, state: 'done' }
      } else {
        const error: WebErrorCode | 'failed' =
          result.error.kind === 'tooMany'
            ? 'tooManyChats'
            : result.error.kind === 'emptyQuestion'
              ? 'emptyQuestion'
              : 'failed'
        entry.view = { ...entry.view, state: 'failed', finishedAt: ctx.clock.now(), error }
        event = { account: id, id: entry.view.id, state: 'failed', error }
      }
    } catch (error) {
      // A runtime closed under the request (the unit stopped, or a shutdown) ends here too.
      ctx.logger.error('ask.failed', { account: id, code: errorCode(error) })
      entry.view = { ...entry.view, state: 'failed', finishedAt: ctx.clock.now(), error: 'failed' }
      event = { account: id, id: entry.view.id, state: 'failed', error: 'failed' }
    } finally {
      this.active.delete(id)
    }
    if (this.stopped) return
    ctx.logger.info('ask.finished', {
      account: id,
      state: entry.view.state,
      ...(entry.view.consulted === undefined ? {} : { consulted: entry.view.consulted }),
      ...(entry.view.items === undefined ? {} : { answered: entry.view.items.length }),
    })
    try {
      onEvent(event)
    } catch (error) {
      ctx.logger.error('ask.eventFailed', { code: errorCode(error) })
    }
  }
}
