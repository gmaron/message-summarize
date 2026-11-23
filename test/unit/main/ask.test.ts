import { describe, expect, it } from 'vitest'
import type { AskChats, AskReport } from '../../../src/application/ask-chats.js'
import { err, ok } from '../../../src/domain/result.js'
import { DEFAULT_SETTINGS } from '../../../src/domain/settings.js'
import {
  type AskEvent,
  AskService,
  type AskView,
  MAX_ASKS_PER_ACCOUNT,
  startOfLocalDay,
  windowOf,
} from '../../../src/main/ask.js'
import type { Runtime } from '../../../src/main/runtime.js'
import { deferred } from '../../support/application-fakes.js'

const HOUR = 3_600_000
/** 2026-03-10 15:30:00 in Buenos Aires (UTC-3). */
const NOW = Date.UTC(2026, 2, 10, 18, 30)
const BA = 'America/Argentina/Buenos_Aires'

const report = (overrides: Partial<AskReport> = {}): AskReport => ({
  window: { since: 0, until: 1 },
  consulted: 2,
  items: [{ name: 'Ana Gómez', answer: 'Asked for a loan.', todos: [], needsReply: true, messageCount: 2 }],
  failed: 0,
  providers: { 'claude-cli': 2 },
  ...overrides,
})

interface Logged {
  level: string
  message: string
  fields: unknown
}

function setup(options: { askChats?: AskChats | null; runtime?: boolean; timezone?: string } = {}) {
  const logs: Logged[] = []
  const logger = new Proxy(
    {},
    {
      get:
        (_t, level: string) =>
        (message: string, fields: unknown): void => {
          logs.push({ level, message, fields })
        },
    },
  )
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
    config: { timezone: options.timezone ?? BA, digest: DEFAULT_SETTINGS, concurrency: 3 },
  } as unknown as Runtime
  const state = {
    stamp: 'created-1' as string | null,
    stopping: false,
    now: NOW,
    hasRuntime: options.runtime !== false,
  }
  const service = new AskService({
    ctx: { clock: { now: () => state.now }, logger } as never,
    host: {
      runtimeOf: () => (state.hasRuntime ? runtime : undefined),
      get isStopping() {
        return state.stopping
      },
    },
    onEvent: (event) => events.push(event),
    accountStamp: () => state.stamp,
  })
  return { service, events, calls, logs, state }
}

const input = { question: '  who asked me for money?  ', period: 'h24' as const, chats: [] as string[] }
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

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
  it('runs the request with the trimmed question, the window, the filters and the runtime config, then publishes done', async () => {
    const { service, events, calls, state } = setup()
    const started = service.start('alpha', { ...input, chats: ['ana'] })
    expect(started).toEqual({ ok: true, id: 1 })
    expect(service.isBusy('alpha')).toBe(true)
    expect(service.list('alpha')[0]).toMatchObject({ id: 1, state: 'running', question: 'who asked me for money?' })
    state.now = NOW + 5
    await settled()
    expect(calls).toEqual([
      {
        question: 'who asked me for money?',
        window: { since: NOW - 24 * HOUR, until: NOW },
        chats: ['ana'],
        settings: DEFAULT_SETTINGS,
        concurrency: 3,
      },
    ])
    expect(service.isBusy('alpha')).toBe(false)
    const view = service.list('alpha')[0] as AskView
    expect(view).toMatchObject({
      state: 'done',
      consulted: 2,
      failedChats: 0,
      finishedAt: NOW + 5,
      period: 'h24',
      chats: ['ana'],
    })
    expect(view.items).toHaveLength(1)
    expect(events).toEqual([{ account: 'alpha', id: 1, state: 'done' }])
  })

  it('never puts the text of the answers in an event or a log', async () => {
    const { service, events, logs } = setup()
    service.start('alpha', input)
    await settled()
    const everything = JSON.stringify([events, logs])
    expect(everything).not.toContain('Asked for a loan')
    expect(everything).not.toContain('Ana Gómez')
    expect(everything).not.toContain('money')
  })

  it('stores and shows the cleaned question, the same one the model gets', async () => {
    const { service, calls } = setup()
    service.start('alpha', { ...input, question: `  a\u0001  b\n c ${'z'.repeat(1100)}` })
    const shown = service.list('alpha')[0]?.question ?? ''
    expect(shown).toHaveLength(1000)
    expect(shown.startsWith('a b c z')).toBe(true)
    await Promise.resolve()
    expect(calls[0]?.question).toBe(shown)
  })

  it('rejects an empty question, a missing runtime, a missing provider and a stopping host', () => {
    expect(setup().service.start('alpha', { ...input, question: '   ' })).toEqual({
      ok: false,
      reason: 'emptyQuestion',
    })
    expect(setup({ runtime: false }).service.start('alpha', input)).toEqual({ ok: false, reason: 'notRunning' })
    expect(setup({ askChats: null }).service.start('alpha', input)).toEqual({ ok: false, reason: 'noProvider' })
    const stopping = setup()
    stopping.state.stopping = true
    expect(stopping.service.start('alpha', input)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('answers busy while one runs, per account, and accepts another when it ends', async () => {
    const gate = deferred<ReturnType<typeof ok<AskReport>>>()
    const { service } = setup({ askChats: () => gate.promise })
    expect(service.start('alpha', input)).toMatchObject({ ok: true })
    expect(service.start('alpha', input)).toEqual({ ok: false, reason: 'busy' })
    expect(service.start('beta', input)).toMatchObject({ ok: true })
    gate.resolve(ok(report()))
    await settled()
    expect(service.isBusy('alpha')).toBe(false)
    expect(service.start('alpha', input)).toEqual({ ok: true, id: 3 })
  })

  it('marks the request failed with the mapped error code of the use case', async () => {
    const cases = [
      [{ kind: 'tooMany' as const, count: 70 }, 'tooManyChats'],
      [{ kind: 'emptyQuestion' as const }, 'emptyQuestion'],
      [{ kind: 'invalidWindow' as const }, 'failed'],
    ] as const
    for (const [error, code] of cases) {
      const { service, events } = setup({ askChats: async () => err(error) })
      service.start('alpha', input)
      await settled()
      expect(service.list('alpha')[0]).toMatchObject({ state: 'failed', error: code })
      expect(events).toEqual([{ account: 'alpha', id: 1, state: 'failed', error: code }])
    }
  })

  it('marks the request failed when the use case throws, logging the code and not the message', async () => {
    const { service, events, logs } = setup({
      askChats: async () => {
        throw new Error('database closed: PRIVATE-TEXT')
      },
    })
    service.start('alpha', input)
    await settled()
    expect(service.list('alpha')[0]).toMatchObject({ state: 'failed', error: 'failed' })
    expect(events).toEqual([{ account: 'alpha', id: 1, state: 'failed', error: 'failed' }])
    expect(service.isBusy('alpha')).toBe(false)
    expect(JSON.stringify(logs)).not.toContain('PRIVATE-TEXT')
  })

  it('survives an event handler that throws', async () => {
    const { service, logs } = setup()
    ;(service as unknown as { options: { onEvent: () => void } }).options.onEvent = () => {
      throw new Error('subscriber')
    }
    service.start('alpha', input)
    await settled()
    expect(service.list('alpha')[0]?.state).toBe('done')
    expect(logs.some((l) => l.message === 'ask.eventFailed')).toBe(true)
  })
})

describe('AskService: the list', () => {
  it('keeps the latest MAX_ASKS_PER_ACCOUNT, newest first', async () => {
    const { service } = setup()
    for (let i = 0; i < MAX_ASKS_PER_ACCOUNT + 3; i++) {
      service.start('alpha', input)
      await settled()
    }
    const ids = service.list('alpha').map((v) => v.id)
    expect(ids).toHaveLength(MAX_ASKS_PER_ACCOUNT)
    expect(ids[0]).toBe(MAX_ASKS_PER_ACCOUNT + 3)
    expect(ids.at(-1)).toBe(4)
  })

  it('removes one request and says whether it existed', async () => {
    const { service } = setup()
    service.start('alpha', input)
    await settled()
    service.start('alpha', input)
    await settled()
    expect(service.remove('alpha', 1)).toBe(true)
    expect(service.remove('alpha', 1)).toBe(false)
    expect(service.remove('beta', 2)).toBe(false)
    expect(service.list('alpha').map((v) => v.id)).toEqual([2])
  })

  it('forgets an account, and drops the requests of an account created again or gone', async () => {
    const { service, state } = setup()
    service.start('alpha', input)
    service.start('beta', input)
    await settled()
    service.forget('alpha')
    expect(service.list('alpha')).toEqual([])
    state.stamp = 'created-2'
    expect(service.list('beta')).toEqual([])
    service.start('gamma', input)
    await settled()
    state.stamp = null
    service.prune()
    expect(service.list('gamma')).toEqual([])
  })

  it('keeps the requests of an account on prune when the stamp is the same', async () => {
    const { service } = setup()
    service.start('alpha', input)
    await settled()
    service.prune()
    expect(service.list('alpha')).toHaveLength(1)
  })

  it('a new incarnation of the account starts a clean list', async () => {
    const { service, state } = setup()
    service.start('alpha', input)
    await settled()
    state.stamp = 'created-2'
    service.start('alpha', input)
    await settled()
    expect(service.list('alpha').map((v) => v.id)).toEqual([2])
  })

  it('stop drops everything, ends in flight requests quietly and refuses new ones', async () => {
    const gate = deferred<ReturnType<typeof ok<AskReport>>>()
    const { service, events } = setup({ askChats: () => gate.promise })
    service.start('alpha', input)
    service.stop()
    expect(service.list('alpha')).toEqual([])
    gate.resolve(ok(report()))
    await settled()
    expect(events).toEqual([])
    expect(service.start('alpha', input)).toEqual({ ok: false, reason: 'unavailable' })
  })
})
