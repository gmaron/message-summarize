import { afterEach, describe, expect, it } from 'vitest'
import { LogStore } from '../../../../src/main/logging/log-store.js'
import { buildLogRecord, type LogFields } from '../../../../src/main/logging/logger.js'
import { disposeHarnesses, until } from '../../../support/cli-harness.js'
import { disposeWorlds, world } from '../../../support/web-world.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

const T0 = Date.parse('2026-11-17T12:00:00Z')
const add = (store: LogStore, n: number, level: 'info' | 'warn' | 'error', fields: LogFields = {}) =>
  store.add(buildLogRecord(level, `event.${n}`, fields, T0 + n * 1000))

function filled(): LogStore {
  const store = new LogStore()
  add(store, 1, 'info', { account: 'alpha' })
  add(store, 2, 'warn', { account: 'beta', code: 'X' })
  add(store, 3, 'error')
  add(store, 4, 'info')
  add(store, 5, 'warn', { account: 'alpha', count: 2 })
  return store
}
const seqs = (body: Record<string, unknown>) => (body.items as { seq: number }[]).map((item) => item.seq)

describe('GET /api/logs (RF-75)', () => {
  it('is behind the token', async () => {
    const w = await world({ logs: filled() })
    expect((await w.api('GET', '/api/logs', undefined, null)).status).toBe(401)
    expect((await w.api('GET', '/api/logs', undefined, 'wrong')).status).toBe(401)
    expect((await w.api('GET', '/api/logs')).status).toBe(200)
  })

  it('is not served when the daemon keeps no log', async () => {
    const w = await world()
    expect((await w.api('GET', '/api/logs')).status).toBe(404)
  })

  it('says which run of the daemon the lines are from, the same on every answer', async () => {
    const store = filled()
    const w = await world({ logs: store })
    const first = await w.api('GET', '/api/logs')
    expect(first.body.boot).toBe(store.boot)
    expect(typeof store.boot).toBe('string')
    expect(new LogStore().boot).not.toBe(store.boot)
    expect((await w.api('GET', '/api/logs?level=error')).body.boot).toBe(store.boot)
  })

  it('answers newest first, the parsed line with seq, time, level, event, account and fields', async () => {
    const w = await world({ logs: filled() })
    const reply = await w.api('GET', '/api/logs')
    expect(seqs(reply.body)).toEqual([5, 4, 3, 2, 1])
    expect((reply.body.items as unknown[])[0]).toEqual({
      seq: 5,
      time: '2026-11-17T12:00:05.000Z',
      level: 'warn',
      event: 'event.5',
      account: 'alpha',
      fields: { count: 2 },
    })
  })

  it('filters by minimum level and by account, and "-" is the installation itself', async () => {
    const w = await world({ logs: filled() })
    expect(seqs((await w.api('GET', '/api/logs?level=warn')).body)).toEqual([5, 3, 2])
    expect(seqs((await w.api('GET', '/api/logs?level=error')).body)).toEqual([3])
    expect(seqs((await w.api('GET', '/api/logs?account=alpha')).body)).toEqual([5, 1])
    expect(seqs((await w.api('GET', '/api/logs?account=-')).body)).toEqual([4, 3])
    expect(seqs((await w.api('GET', '/api/logs?account=alpha&level=warn')).body)).toEqual([5])
    expect(seqs((await w.api('GET', '/api/logs?account=gone')).body)).toEqual([])
    // an empty value is no filter
    expect(seqs((await w.api('GET', '/api/logs?account=&level=info')).body)).toEqual([5, 4, 3, 2, 1])
  })

  it('pages with limit (default 200, at most 1000) and the before cursor', async () => {
    const store = new LogStore(5_000)
    for (let n = 1; n <= 1_500; n++) add(store, n, 'info')
    const w = await world({ logs: store })
    expect(seqs((await w.api('GET', '/api/logs')).body)).toHaveLength(200)
    expect(seqs((await w.api('GET', '/api/logs?limit=5000')).body)).toHaveLength(1_000)
    expect(seqs((await w.api('GET', '/api/logs?limit=0')).body)).toHaveLength(1)
    const first = seqs((await w.api('GET', '/api/logs?limit=3')).body)
    expect(first).toEqual([1500, 1499, 1498])
    expect(seqs((await w.api('GET', '/api/logs?limit=3&before=1498')).body)).toEqual([1497, 1496, 1495])
    expect(seqs((await w.api('GET', '/api/logs?limit=3&before=2')).body)).toEqual([1])
    expect(seqs((await w.api('GET', '/api/logs?before=1')).body)).toEqual([])
  })

  it('refuses a filter that is not valid with a 400', async () => {
    const w = await world({ logs: filled() })
    for (const query of ['level=debug', 'level=', 'account=../x', 'account=A', 'limit=x', 'limit=-1', 'before=abc']) {
      expect(await w.api('GET', `/api/logs?${query}`), query).toEqual({
        status: 400,
        body: { error: 'invalidRequest' },
      })
    }
  })

  it('serves nothing outside the allowlist, even if a caller tried to log it', async () => {
    const store = new LogStore()
    const sneaky = {
      code: 'E',
      text: 'PRIVATE-CHAT-TEXT',
      phone: '+9911963367943',
      account: 'alpha',
    } as unknown as LogFields
    store.add(buildLogRecord('warn', 'x.failed', sneaky, T0))
    const w = await world({ logs: store })
    const reply = await w.api('GET', '/api/logs')
    expect(JSON.stringify(reply.body)).not.toContain('PRIVATE')
    expect(JSON.stringify(reply.body)).not.toContain('9911963367943')
    expect((reply.body.items as { fields: object }[])[0]?.fields).toEqual({ code: 'E' })
  })
})

describe('the log event', () => {
  it('tells the page that there are new lines, with the seq and nothing else, at most once per interval', async () => {
    const store = new LogStore()
    const w = await world({ logs: store, logEventMs: 150 })
    add(store, 1, 'info', { account: 'alpha', code: 'SECRET-LOOKING' })
    await until(() => w.eventsOf('log').length === 1, 'the first log event')
    // a burst inside the interval becomes one more event, after the pause, with the newest seq
    for (let n = 2; n <= 30; n++) add(store, n, 'info')
    expect(w.eventsOf('log')).toHaveLength(1)
    await until(() => w.eventsOf('log').length === 2, 'the trailing log event')
    expect(w.eventsOf('log').map((e) => e.data)).toEqual([
      { seq: 1, boot: store.boot },
      { seq: 30, boot: store.boot },
    ])
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(w.eventsOf('log')).toHaveLength(2)
    expect(JSON.stringify(w.sse)).not.toContain('SECRET-LOOKING')
  })
})
