import type { AskProgress } from '../application/ask-chats.js'
import type { AskRecord } from '../application/ports/ask-history.js'
import { ASK_SELECTIONS, type AskSelection } from '../domain/ask-selection.js'
import { cleanQuestion, deliveryParts, toWhatsApp } from '../domain/ask-text.js'
import { getCatalog, type WebErrorCode } from '../infrastructure/i18n/index.js'
import type { CommandContext } from './context.js'
import { errorCode, type LogFields } from './logger.js'
import type { Runtime } from './runtime.js'

export type { AskSelection }
export { ASK_SELECTIONS }

/** The periods the page offers. */
export const ASK_PERIODS = ['today', 'h24', 'd3', 'd7'] as const
export type AskPeriod = (typeof ASK_PERIODS)[number]

const HOUR_MS = 3_600_000

/** Where the delivery of an answer to the owner's own chat stands. `off`: it was not asked for. */
export type AskDelivery = 'off' | 'queued' | 'sent' | 'notQueued' | 'discarded'

/** What the page shows of one request. The text of the answer is private: it is only in the `GET`, never in an event or a log. */
export interface AskView {
  readonly id: number
  readonly question: string
  readonly selection: AskSelection
  readonly period: AskPeriod
  readonly chats: readonly string[]
  readonly state: 'running' | 'done' | 'failed'
  readonly createdAt: number
  readonly finishedAt?: number
  readonly since: number
  readonly until: number
  /** While running: how far the reading of the parts is. Absent when the whole text goes in one call. */
  readonly progress?: AskProgress
  readonly deliver: boolean
  readonly delivery: AskDelivery
  readonly result?: {
    /** Simple markdown. The page draws it as text, never as markup. */
    readonly answer: string
    readonly provider: string
    readonly chats: number
    readonly messages: number
    /** Chats left out because they are "local only" and the provider is external. */
    readonly leftOutLocalOnly: number
    readonly parts: number
  }
  readonly error?: WebErrorCode | 'failed'
}

/** What the `ask` event says: that a request ended and how, never what it holds. */
export interface AskEvent {
  readonly account: string
  readonly id: number
  readonly state: 'done' | 'failed'
  readonly error?: WebErrorCode | 'failed'
}

/** What starts a request. */
export interface StartAskInput {
  readonly question: string
  readonly period: AskPeriod
  readonly selection: AskSelection
  readonly chats: readonly string[]
  /** Queue the answer for the owner's own chat. */
  readonly deliver: boolean
}

export type StartAskResult =
  | { readonly ok: true; readonly id: number }
  | { readonly ok: false; readonly reason: 'busy' | 'notRunning' | 'noProvider' | 'unavailable' | 'emptyQuestion' }

/** What the requests need of the host of the accounts. */
export interface AskHost {
  /** The runtime of the account's running unit, if it has one. */
  runtimeOf(id: string): Runtime | undefined
  readonly isStopping: boolean
  /** Asks the unit to deliver what is queued now (it does anyway on its next look). */
  requestDelivery?(id: string): void
}

export interface AskServiceOptions {
  readonly ctx: Pick<CommandContext, 'clock' | 'logger'>
  readonly host: AskHost
  readonly onEvent: (event: AskEvent) => void
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

/** The errors a record keeps are the web's own codes (or `failed`/`interrupted`): never a message. */
const KNOWN_ERRORS = new Set<string>(['emptyQuestion', 'noMessages', 'tooMuch', 'failed'])
const errorOf = (code: string | null): AskView['error'] =>
  code === null ? undefined : KNOWN_ERRORS.has(code) ? (code as WebErrorCode | 'failed') : 'failed'

/**
 * The free requests of the web ("Ask"): what the owner asks about the chats of a period, answered by the providers of the
 * account with ONE answer over all the chats, without sending anything to anyone but the owner's own chat and without
 * moving the digest pointer. Requests and answers are stored in the account's database (the latest 50) so they survive a
 * restart; they are private chat-derived text, only in the `GET` behind the token, never in an event or a log.
 *
 * The answer is queued for the account's OWN chat (RF-51) when the request asks for it, through the same outbox and
 * delivery as the digest: there is no recipient anywhere in this path.
 *
 * One request at a time per account. It runs on the runtime of the account's unit: without one (not linked, blocked,
 * starting) there is nothing connected to ask, as for "Summarize now".
 */
export class AskService {
  private readonly active = new Map<string, { id: number; progress: AskProgress | null }>()
  private stopped = false

  constructor(private readonly options: AskServiceOptions) {}

  isBusy(id: string): boolean {
    return this.active.has(id)
  }

  /** The requests of the account, the latest first. Empty when the account has no running unit (its database is closed). */
  async list(id: string): Promise<readonly AskView[]> {
    const runtime = this.options.host.runtimeOf(id)
    if (runtime === undefined) return []
    // A request found running that this process is not running ended with the process that wrote it.
    if (!this.active.has(id)) await runtime.askHistory.failRunning(this.options.ctx.clock.now())
    const records = await runtime.askHistory.list()
    return Promise.all(records.map((record) => this.viewOf(id, runtime, record)))
  }

  private async viewOf(id: string, runtime: Runtime, record: AskRecord): Promise<AskView> {
    const running = this.active.get(id)
    const progress = record.state === 'running' && running?.id === record.id ? running.progress : null
    let delivery: AskDelivery = 'off'
    if (record.deliver && record.state === 'done') {
      delivery =
        record.outboxId === null
          ? 'notQueued'
          : await runtime.outbox.status(record.outboxId).then((s) => (s === 'gone' ? 'discarded' : s))
    }
    const error = errorOf(record.error)
    return {
      id: record.id,
      question: record.question,
      selection: record.selection,
      period: record.period,
      chats: record.chats,
      state: record.state,
      createdAt: record.createdAt,
      ...(record.finishedAt === null ? {} : { finishedAt: record.finishedAt }),
      since: record.since,
      until: record.until,
      ...(progress === null ? {} : { progress }),
      deliver: record.deliver,
      delivery,
      ...(record.result === null
        ? {}
        : {
            result: {
              answer: record.result.answer,
              provider: record.result.provider,
              chats: record.result.chats,
              messages: record.result.messages,
              leftOutLocalOnly: record.result.leftOutLocalOnly,
              parts: record.result.parts,
            },
          }),
      ...(error === undefined ? {} : { error }),
    }
  }

  async start(id: string, input: StartAskInput): Promise<StartAskResult> {
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

    // The slot is taken in the same synchronous step as the check, before anything is awaited.
    const slot: { id: number; progress: AskProgress | null } = { id: 0, progress: null }
    this.active.set(id, slot)
    const now = ctx.clock.now()
    const window = windowOf(input.period, now, runtime.config.timezone)
    try {
      slot.id = await runtime.askHistory.start({
        createdAt: now,
        question,
        selection: input.selection,
        period: input.period,
        since: window.since,
        until: window.until,
        chats: input.chats,
        deliver: input.deliver,
      })
    } catch (error) {
      this.active.delete(id)
      ctx.logger.error('ask.failed', { account: id, code: errorCode(error) })
      return { ok: false, reason: 'unavailable' }
    }
    void this.run(id, slot, runtime, askChats, { ...input, question }, window)
    return { ok: true, id: slot.id }
  }

  /** Deletes one request (not one that is running). False when it does not exist. */
  async remove(id: string, askId: number): Promise<boolean> {
    const runtime = this.options.host.runtimeOf(id)
    if (runtime === undefined || this.active.get(id)?.id === askId) return false
    return runtime.askHistory.remove(askId)
  }

  /** Drops the history of an account (a new link of it began): it holds chats of what may be another number. */
  async forget(id: string): Promise<void> {
    try {
      await this.options.host.runtimeOf(id)?.askHistory.clear()
    } catch (error) {
      this.options.ctx.logger.error('ask.forgetFailed', { account: id, code: errorCode(error) })
    }
  }

  /** Requests in flight end quietly. */
  stop(): void {
    this.stopped = true
  }

  private async run(
    id: string,
    slot: { id: number; progress: AskProgress | null },
    runtime: Runtime,
    askChats: NonNullable<Runtime['askChats']>,
    input: StartAskInput,
    window: { since: number; until: number },
  ): Promise<void> {
    const { ctx, onEvent, host } = this.options
    let event: AskEvent
    const fields: LogFields = { account: id }
    try {
      const result = await askChats({
        question: input.question,
        window,
        chats: input.chats,
        selection: input.selection,
        settings: runtime.config.digest,
        askHints: runtime.config.askHints,
        onProgress: (progress) => {
          slot.progress = progress
        },
      })
      if (result.ok) {
        const report = result.value
        let outboxId: number | null = null
        let queued = false
        if (input.deliver) {
          try {
            outboxId = await runtime.outbox.queueForOwnChat(this.deliveryOf(runtime, report))
            queued = outboxId !== null
          } catch (error) {
            // The answer is kept and shown; only its delivery failed.
            ctx.logger.error('ask.deliveryFailed', { account: id, code: errorCode(error) })
          }
        }
        await runtime.askHistory.finish(slot.id, {
          finishedAt: ctx.clock.now(),
          state: 'done',
          outboxId,
          result: {
            answer: report.answer,
            provider: report.provider,
            chats: report.chats,
            messages: report.messages,
            leftOutLocalOnly: report.leftOutLocalOnly,
            parts: report.parts,
            calls: report.calls,
          },
        })
        fields.state = 'done'
        fields.chats = report.chats
        fields.messages = report.messages
        fields.skipped = report.leftOutLocalOnly
        event = { account: id, id: slot.id, state: 'done' }
        if (queued) host.requestDelivery?.(id)
      } else {
        const kind = result.error.kind
        // Only the class of the failure, a fixed word: the reason text of a provider can carry chat text or secrets.
        if (result.error.kind === 'answerFailed') {
          ctx.logger.error('ask.failed', { account: id, reason: result.error.failure })
        }
        const error: WebErrorCode | 'failed' =
          kind === 'emptyQuestion' || kind === 'noMessages' || kind === 'tooMuch' ? kind : 'failed'
        await runtime.askHistory.finish(slot.id, { finishedAt: ctx.clock.now(), state: 'failed', error })
        fields.state = 'failed'
        fields.reason = error
        event = { account: id, id: slot.id, state: 'failed', error }
      }
    } catch (error) {
      // A runtime closed under the request (the unit stopped, or a shutdown) ends here too.
      ctx.logger.error('ask.failed', { account: id, code: errorCode(error) })
      try {
        await runtime.askHistory.finish(slot.id, { finishedAt: ctx.clock.now(), state: 'failed', error: 'failed' })
      } catch {
        // the database is gone with the runtime: the next list closes it as interrupted
      }
      fields.state = 'failed'
      fields.reason = 'failed'
      event = { account: id, id: slot.id, state: 'failed', error: 'failed' }
    } finally {
      this.active.delete(id)
    }
    if (this.stopped) return
    ctx.logger.info('ask.finished', fields)
    try {
      onEvent(event)
    } catch (error) {
      ctx.logger.error('ask.eventFailed', { code: errorCode(error) })
    }
  }

  /** The parts queued for the own chat: a header and the answer in WhatsApp's formatting, cut like the digest. */
  private deliveryOf(
    runtime: Runtime,
    report: { window: { since: number; until: number }; selection: AskSelection; answer: string },
  ): string[] {
    const catalog = getCatalog(runtime.config.language)
    const when = (t: number): string => runtime.renderers.transcript.formatDateTime(t)
    const header = catalog.ask.deliveryHeader({
      since: when(report.window.since),
      until: when(report.window.until),
      selection: report.selection,
    })
    return deliveryParts(header, toWhatsApp(report.answer))
  }
}
