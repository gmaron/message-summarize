import { afterEach, describe, expect, it } from 'vitest'
import type { AskChats, AskReport } from '../../../src/application/ask-chats.js'
import { ASK_HISTORY_LIMIT } from '../../../src/application/ports/ask-history.js'
import { err, ok } from '../../../src/domain/result.js'
import { DEFAULT_SETTINGS } from '../../../src/domain/settings.js'
import { SqliteAskHistory } from '../../../src/infrastructure/persistence/sqlite/index.js'
import { createRenderers } from '../../../src/infrastructure/rendering/index.js'
import { type AskEvent, AskService, type AskView, startOfLocalDay, windowOf } from '../../../src/main/ask.js'
import { buildLogRecord, type LogFields, type LogLevel } from '../../../src/main/logger.js'
import type { Runtime } from '../../../src/main/runtime.js'
import { deferred, InMemoryOutbox } from '../../support/application-fakes.js'
import { TempDatabase } from '../../support/persistence-backends.js'

const HOUR = 3_600_000
/** 2026-03-10 15:30:00 in Buenos Aires (UTC-3). */
const NOW = Date.UTC(2026, 2, 10, 18, 30)
const BA = 'America/Argentina/Buenos_Aires'
const SECRET = 'SECRET-ANSWER: Ana wants a loan of 500'

const report = (overrides: Partial<AskReport> = {}): AskReport => ({
  window: { since: NOW - 24 * HOUR, until: NOW },
  selection: 'unanswered',
  chats: 2,
  messages: 5,
  leftOutLocalOnly: 0,
  parts: 1,
  calls: 1,
  provider: 'claude-cli',
  answer: `## Loans\n- **Ana**: ${SECRET}`,
  ...overrides,
})

interface Logged {
  level: string
  message: string
  fields: unknown
}

const temps: TempDatabase[] = []
afterEach(() => {
  for (const temp of temps.splice(0)) temp.dispose()
})

function setup(options: { askChats?: AskChats | null; runtime?: boolean; queueFails?: boolean } = {}) {
  const logs: Logged[] = []
  const logger = new Proxy(
    {},
    {
      get:
        (_t, level: string) =>
        (message: string, fields: unknown): void => {
          // Through the real allowlist: a field the logger would drop does not reach the assertions either.
          const {
            time: _t,
            level: _l,
            event: _e,
            ...kept
          } = buildLogRecord(level as LogLevel, message, (fields ?? {}) as LogFields, 0)
          logs.push({ level, message, fields: kept })
        },
    },
  )
  const temp = new TempDatabase()
  temps.push(temp)
  const history = new SqliteAskHistory(temp.open())
  const outbox = new InMemoryOutbox()
  if (options.queueFails === true) {
    outbox.queueForOwnChat = async () => {
      throw new Error('disk full')
    }
  }
  const events: AskEvent[] = []
  const calls: Parameters<AskChats>[0][] = []
  const askChats: AskChats | null =
    options.askChats === undefined
      ? async (request) => {
          calls.push(request)
          return ok(report())
        }
      : options.askChats
  const runtime = {
    askChats,
    askHistory: history,
    outbox,
    renderers: createRenderers('en', BA),
    config: {
      timezone: BA,
      language: 'en',
      digest: DEFAULT_SETTINGS,
      concurrency: 3,
      askHints: [{ when: ['x'], text: 'y' }],
    },
  } as unknown as Runtime
  const state = { stopping: false, now: NOW, hasRuntime: options.runtime !== false }
  const deliveries: string[] = []
  const ctx = { clock: { now: () => state.now }, logger } as never
  const host = {
    runtimeOf: () => (state.hasRuntime ? runtime : undefined),
    get isStopping() {
      return state.stopping
    },
    requestDelivery: (id: string) => deliveries.push(id),
  }
  const service = new AskService({ ctx, host, onEvent: (event) => events.push(event) })
  return { service, ctx, host, events, calls, logs, state, history, outbox, deliveries }
}

const input = {
  question: '  who asked me for money?  ',
  period: 'h24' as const,
  selection: 'unanswered' as const,
  chats: [] as string[],
  deliver: false,
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('AskService: windows', () => {
  it('computes the start of the local day in a time zone, also across the date line of UTC', () => {
    expect(startOfLocalDay(NOW, BA)).toBe(Date.UTC(2026, 2, 10, 3))
    // 01:00 UTC of the 11th is still the 10th in Buenos Aires
    expect(startOfLocalDay(Date.UTC(2026, 2, 11, 1), BA)).toBe(Date.UTC(2026, 2, 10, 3))
    expect(startOfLocalDay(NOW, 'UTC')).toBe(Date.UTC(2026, 2, 10))
  })

  it('uses the offset at local midnight on the days the clocks change', () => {
    // Madrid, 2026-03-29: clocks go forward at 02:00 (midnight is still UTC+1); now is 10:00 local (UTC+2)
    expect(startOfLocalDay(Date.UTC(2026, 2, 29, 8), 'Europe/Madrid')).toBe(Date.UTC(2026, 2, 28, 23))
    // Madrid, 2026-10-25: clocks go back (midnight is UTC+2); now is 10:00 local (UTC+1)
    expect(startOfLocalDay(Date.UTC(2026, 9, 25, 9), 'Europe/Madrid')).toBe(Date.UTC(2026, 9, 24, 22))
    // New York, 2026-03-08: midnight is UTC-5, now is 12:00 local (UTC-4)
    expect(startOfLocalDay(Date.UTC(2026, 2, 8, 16), 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 5))
    // New York, 2026-11-01: midnight is UTC-4, now is 12:00 local (UTC-5)
    expect(startOfLocalDay(Date.UTC(2026, 10, 1, 17), 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 4))
    // a normal day
    expect(startOfLocalDay(Date.UTC(2026, 6, 10, 15), 'Europe/Madrid')).toBe(Date.UTC(2026, 6, 9, 22))
  })

  it('gives the window of each period ending now', () => {
    expect(windowOf('today', NOW, BA)).toEqual({ since: Date.UTC(2026, 2, 10, 3), until: NOW })
    expect(windowOf('h24', NOW, BA)).toEqual({ since: NOW - 24 * HOUR, until: NOW })
    expect(windowOf('d3', NOW, BA)).toEqual({ since: NOW - 72 * HOUR, until: NOW })
    expect(windowOf('d7', NOW, BA)).toEqual({ since: NOW - 168 * HOUR, until: NOW })
  })
})

describe('AskService: start', () => {
  it('runs the request with the cleaned question, the window, the selection, the filters and the runtime config, then publishes done', async () => {
    const gate = deferred<void>()
    const calls: Parameters<AskChats>[0][] = []
    const { service, events } = setup({
      askChats: async (request) => {
        calls.push(request)
        await gate.promise
        return ok(report())
      },
    })
    expect(await service.start('alpha', { ...input, chats: ['ana'] })).toEqual({ ok: true, id: 1 })
    expect(service.isBusy('alpha')).toBe(true)
    expect((await service.list('alpha'))[0]).toMatchObject({
      id: 1,
      state: 'running',
      question: 'who asked me for money?',
    })
    gate.resolve()
    await settled()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      question: 'who asked me for money?',
      window: { since: NOW - 24 * HOUR, until: NOW },
      chats: ['ana'],
      selection: 'unanswered',
      settings: DEFAULT_SETTINGS,
      askHints: [{ when: ['x'], text: 'y' }],
    })
    expect(service.isBusy('alpha')).toBe(false)
    expect(events).toEqual([{ account: 'alpha', id: 1, state: 'done' }])
    expect((await service.list('alpha'))[0]).toMatchObject({
      state: 'done',
      selection: 'unanswered',
      deliver: false,
      delivery: 'off',
      result: { answer: report().answer, provider: 'claude-cli', chats: 2, messages: 5, leftOutLocalOnly: 0, parts: 1 },
    })
  })

  it('keeps line breaks of a pasted question', async () => {
    const { service } = setup()
    await service.start('alpha', { ...input, question: 'List:\n\n\n- a\n- b' })
    expect((await service.list('alpha'))[0]?.question).toBe('List:\n\n- a\n- b')
  })

  it('rejects an empty question, a missing runtime, a missing provider and a stopping host', async () => {
    expect(await setup().service.start('alpha', { ...input, question: ' \n\u0001 ' })).toEqual({
      ok: false,
      reason: 'emptyQuestion',
    })
    expect(await setup({ runtime: false }).service.start('alpha', input)).toEqual({ ok: false, reason: 'notRunning' })
    expect(await setup({ askChats: null }).service.start('alpha', input)).toEqual({ ok: false, reason: 'noProvider' })
    const stopping = setup()
    stopping.state.stopping = true
    expect(await stopping.service.start('alpha', input)).toEqual({ ok: false, reason: 'unavailable' })
    expect(await stopping.service.list('alpha')).toEqual([])
  })

  it('answers busy while one runs and accepts another when it ends; the progress is in the view', async () => {
    const gate = deferred<void>()
    const { service } = setup({
      askChats: async (request) => {
        request.onProgress?.({ phase: 'reading', done: 1, total: 3 })
        await gate.promise
        return ok(report())
      },
    })
    expect(await service.start('alpha', input)).toEqual({ ok: true, id: 1 })
    expect(await service.start('alpha', input)).toEqual({ ok: false, reason: 'busy' })
    expect((await service.list('alpha'))[0]).toMatchObject({
      state: 'running',
      progress: { phase: 'reading', done: 1, total: 3 },
    })
    gate.resolve()
    await settled()
    expect(await service.start('alpha', input)).toEqual({ ok: true, id: 2 })
  })

  it('takes the slot at once: two starts in the same step cannot both run', async () => {
    const { service } = setup()
    const [a, b] = await Promise.all([service.start('alpha', input), service.start('alpha', input)])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
  })

  it('does not delete a request that is running', async () => {
    const gate = deferred<void>()
    const { service } = setup({
      askChats: async () => {
        await gate.promise
        return ok(report())
      },
    })
    await service.start('alpha', input)
    expect(await service.remove('alpha', 1)).toBe(false)
    gate.resolve()
    await settled()
    expect(await service.remove('alpha', 1)).toBe(true)
    expect(await service.remove('alpha', 1)).toBe(false)
  })

  it.each([
    ['emptyQuestion', 'emptyQuestion'],
    ['noMessages', 'noMessages'],
    ['tooMuch', 'tooMuch'],
    ['answerFailed', 'failed'],
    ['invalidWindow', 'failed'],
  ] as const)('marks the request failed with the code of %s, in the history and in the event', async (kind, code) => {
    const error =
      kind === 'noMessages' ? { kind, leftOutLocalOnly: 0 } : kind === 'tooMuch' ? { kind, chars: 9 } : { kind }
    const { service, events } = setup({ askChats: async () => err(error as never) })
    await service.start('alpha', input)
    await settled()
    expect((await service.list('alpha'))[0]).toMatchObject({ state: 'failed', error: code })
    expect(events).toEqual([{ account: 'alpha', id: 1, state: 'failed', error: code }])
  })

  it('marks the request failed when the use case throws, logging the code and not the message', async () => {
    const { service, logs } = setup({
      askChats: async () => {
        throw Object.assign(new Error(`boom ${SECRET}`), { code: 'EBOOM' })
      },
    })
    await service.start('alpha', input)
    await settled()
    expect((await service.list('alpha'))[0]).toMatchObject({ state: 'failed', error: 'failed' })
    expect(JSON.stringify(logs)).not.toContain(SECRET)
    expect(logs.find((l) => l.message === 'ask.failed')?.fields).toMatchObject({ account: 'alpha', code: 'EBOOM' })
  })

  it('survives an event handler that throws', async () => {
    const setupped = setup()
    const throwing = new AskService({
      ctx: { clock: { now: () => NOW }, logger: { info() {}, warn() {}, error() {} } } as never,
      host: {
        runtimeOf: () =>
          ({
            askChats: async () => ok(report()),
            askHistory: setupped.history,
            outbox: setupped.outbox,
            config: { timezone: BA, language: 'en', digest: DEFAULT_SETTINGS, askHints: [] },
            renderers: createRenderers('en', BA),
          }) as never,
        isStopping: false,
      },
      onEvent: () => {
        throw new Error('listener')
      },
    })
    await throwing.start('alpha', input)
    await settled()
    expect(throwing.isBusy('alpha')).toBe(false)
  })

  it('never logs the question or the answer: only counts and codes', async () => {
    const { service, logs } = setup()
    await service.start('alpha', { ...input, question: 'PRIVATE-QUESTION' })
    await settled()
    expect(JSON.stringify(logs)).not.toMatch(/SECRET|PRIVATE-QUESTION/)
    expect(logs.find((l) => l.message === 'ask.finished')?.fields).toEqual({
      account: 'alpha',
      state: 'done',
      chats: 2,
      messages: 5,
      skipped: 0,
    })
  })
})

describe('AskService: failures are logged by class only', () => {
  it('logs ask.failed with the fixed class and nothing of the provider text', async () => {
    const { service, logs } = setup({
      askChats: async () => err({ kind: 'answerFailed', failure: 'rateLimit' }),
    })
    await service.start('alpha', input)
    await settled()
    const failed = logs.find((l) => l.message === 'ask.failed')
    expect(failed).toMatchObject({ level: 'error', fields: { account: 'alpha', reason: 'rateLimit' } })
    expect(JSON.stringify(logs)).not.toMatch(/SECRET|sk-/)
    expect((await service.list('alpha'))[0]).toMatchObject({ state: 'failed', error: 'failed' })
  })
})

describe('AskService: the delivery to the own chat (RF-51)', () => {
  it('queues the answer in WhatsApp format for the OWN chat, with a header, and asks the unit to deliver', async () => {
    const { service, outbox, deliveries } = setup()
    await service.start('alpha', { ...input, deliver: true })
    await settled()
    const queued = (await outbox.pending()).map((i) => i.text)
    expect(queued[0]).toContain('Request about your chats')
    expect(queued[0]).toContain('only what is unanswered')
    expect(queued[1]).toBe(`*Loans*\n• *Ana*: ${SECRET}`)
    expect(deliveries).toEqual(['alpha'])
    expect((await service.list('alpha'))[0]).toMatchObject({ deliver: true, delivery: 'queued' })
  })

  it('shows it as sent once the outbox marks the last part sent, and as discarded if it was thrown away', async () => {
    const { service, outbox } = setup()
    await service.start('alpha', { ...input, deliver: true })
    await settled()
    for (const item of await outbox.pending()) await outbox.markSent(item.id)
    expect((await service.list('alpha'))[0]?.delivery).toBe('sent')
    await service.start('alpha', { ...input, deliver: true })
    await settled()
    await outbox.discardPending()
    expect((await service.list('alpha'))[0]?.delivery).toBe('discarded')
  })

  it('queues nothing when it was not asked for', async () => {
    const { service, outbox, deliveries } = setup()
    await service.start('alpha', { ...input, deliver: false })
    await settled()
    expect(await outbox.pending()).toEqual([])
    expect(deliveries).toEqual([])
  })

  it('queues nothing for a failed request', async () => {
    const { service, outbox } = setup({ askChats: async () => err({ kind: 'answerFailed', failure: 'timeout' }) })
    await service.start('alpha', { ...input, deliver: true })
    await settled()
    expect(await outbox.pending()).toEqual([])
  })

  it('keeps the answer when the queue fails, says it was not queued and logs only the code', async () => {
    const { service, logs, deliveries } = setup({ queueFails: true })
    await service.start('alpha', { ...input, deliver: true })
    await settled()
    expect((await service.list('alpha'))[0]).toMatchObject({
      state: 'done',
      delivery: 'notQueued',
      result: { provider: 'claude-cli' },
    })
    expect(deliveries).toEqual([])
    expect(logs.some((l) => l.message === 'ask.deliveryFailed')).toBe(true)
    expect(JSON.stringify(logs)).not.toContain('disk full')
  })

  it('has no way to name a recipient: the only thing it hands the outbox is text', async () => {
    const { service, outbox } = setup()
    const seen: unknown[][] = []
    const original = outbox.queueForOwnChat.bind(outbox)
    outbox.queueForOwnChat = async (...args: Parameters<typeof original>) => {
      seen.push(args)
      return original(...args)
    }
    await service.start('alpha', { ...input, deliver: true, chats: ['someone else'] })
    await settled()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(1)
    const parts = seen[0]?.[0] as string[]
    expect(parts.every((part) => typeof part === 'string')).toBe(true)
  })
})

describe('AskService: the persistent list', () => {
  it('keeps the latest requests, newest first, and no more than the limit of the history', async () => {
    const { service, history } = setup()
    for (let n = 0; n < ASK_HISTORY_LIMIT + 3; n++) {
      await service.start('alpha', input)
      await settled()
    }
    const list = await service.list('alpha')
    expect(list).toHaveLength(ASK_HISTORY_LIMIT)
    expect(list[0]?.id).toBe(ASK_HISTORY_LIMIT + 3)
    expect((await history.list()).length).toBe(ASK_HISTORY_LIMIT)
  }, 30_000)

  it('survives a restart: another service over the same database lists what was answered', async () => {
    const first = setup()
    await first.service.start('alpha', { ...input, deliver: true })
    await settled()
    const second = new AskService({
      ctx: first.ctx,
      host: first.host,
      onEvent: () => {},
    })
    const list: readonly AskView[] = await second.list('alpha')
    expect(list[0]).toMatchObject({ id: 1, state: 'done', result: { answer: report().answer } })
  })

  it('closes a request left running by a process that died as failed, not as running forever', async () => {
    const { service, history } = setup()
    await history.start({
      createdAt: NOW,
      question: 'q',
      selection: 'all',
      period: 'today',
      since: 0,
      until: 1,
      chats: [],
      deliver: false,
    })
    expect((await service.list('alpha'))[0]).toMatchObject({ state: 'failed', error: 'failed' })
  })

  it('is empty without a running unit, and forget clears the history', async () => {
    const stopped = setup({ runtime: false })
    expect(await stopped.service.list('alpha')).toEqual([])
    const { service } = setup()
    await service.start('alpha', input)
    await settled()
    await service.forget('alpha')
    expect(await service.list('alpha')).toEqual([])
  })

  it('stop ends in flight requests quietly and refuses new ones', async () => {
    const gate = deferred<void>()
    const { service, events } = setup({
      askChats: async () => {
        await gate.promise
        return ok(report())
      },
    })
    await service.start('alpha', input)
    service.stop()
    gate.resolve()
    await settled()
    expect(events).toEqual([])
    expect(await service.start('alpha', input)).toEqual({ ok: false, reason: 'unavailable' })
  })
})
