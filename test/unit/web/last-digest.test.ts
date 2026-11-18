import { describe, expect, it } from 'vitest'
import { createApi } from '../../../src/interfaces/web/lib/api.js'
import { loadLastDigest } from '../../../src/interfaces/web/lib/last-digest.js'
import type { HistoryDetail, HistoryRun } from '../../../src/interfaces/web/lib/types.js'
import { fakeFetch } from './support.js'

const run = (id: number, over: Partial<HistoryRun> = {}): HistoryRun => ({
  id,
  trigger: 'schedule',
  startedAt: id * 1_000,
  finishedAt: id * 1_000 + 5_000,
  durationMs: 5_000,
  outcome: 'committed',
  error: null,
  summarized: 3,
  failed: 0,
  providers: { 'claude-cli': 3 },
  digestId: id,
  ...over,
})
const detail = (r: HistoryRun, text: string | null): HistoryDetail => ({
  ...r,
  since: 1,
  until: 2,
  digest: text === null ? null : { text, since: 1, until: 2 },
  failedConversations: [],
})

describe('the last digest of an account', () => {
  it('is the text of the newest run that has a digest', async () => {
    const empty = run(9, { digestId: null, outcome: 'empty' })
    const sent = run(8)
    const { fetchFn, calls } = fakeFetch({
      'GET /api/accounts/alpha/history?limit=20&offset=0': { body: { total: 3, items: [empty, sent, run(7)] } },
      'GET /api/accounts/alpha/history/8': { body: detail(sent, '*Resumen*') },
    })
    const last = await loadLastDigest(createApi(fetchFn), 'alpha')
    expect(last).toEqual({ run: sent, text: '*Resumen*', at: sent.finishedAt })
    expect(calls.map((call) => call.path)).toEqual([
      '/api/accounts/alpha/history?limit=20&offset=0',
      '/api/accounts/alpha/history/8',
    ])
  })

  it('is null when no run of the first page has one, without asking for any detail', async () => {
    const { fetchFn, calls } = fakeFetch({
      'GET /api/accounts/alpha/history?limit=20&offset=0': {
        body: { total: 1, items: [run(1, { digestId: null, outcome: 'empty' })] },
      },
    })
    expect(await loadLastDigest(createApi(fetchFn), 'alpha')).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('is null when the run says it has a digest and the detail does not, and uses the start of an open run', async () => {
    const open = run(2, { finishedAt: null })
    const { fetchFn } = fakeFetch({
      'GET /api/accounts/alpha/history?limit=20&offset=0': { body: { total: 1, items: [open] } },
      'GET /api/accounts/alpha/history/2': { body: detail(open, null) },
    })
    expect(await loadLastDigest(createApi(fetchFn), 'alpha')).toBeNull()
    const again = fakeFetch({
      'GET /api/accounts/alpha/history?limit=20&offset=0': { body: { total: 1, items: [open] } },
      'GET /api/accounts/alpha/history/2': { body: detail(open, 'hola') },
    })
    expect((await loadLastDigest(createApi(again.fetchFn), 'alpha'))?.at).toBe(open.startedAt)
  })

  it('lets the error of the daemon through', async () => {
    const { fetchFn } = fakeFetch({})
    await expect(loadLastDigest(createApi(fetchFn), 'alpha')).rejects.toMatchObject({ code: 'notFound' })
  })
})

describe('looking further than the first page', () => {
  const noDigest = (id: number) => run(id, { digestId: null, outcome: 'empty' })
  const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => noDigest(from - i))

  it('pages through the history until it finds a run with a digest', async () => {
    const sent = run(5)
    const { fetchFn, calls } = fakeFetch({
      'GET /api/accounts/alpha/history?limit=20&offset=0': { body: { total: 60, items: page(100, 20) } },
      'GET /api/accounts/alpha/history?limit=20&offset=20': { body: { total: 60, items: page(80, 20) } },
      'GET /api/accounts/alpha/history?limit=20&offset=40': { body: { total: 60, items: [...page(60, 19), sent] } },
      'GET /api/accounts/alpha/history/5': { body: detail(sent, 'hola') },
    })
    expect((await loadLastDigest(createApi(fetchFn), 'alpha'))?.text).toBe('hola')
    expect(calls).toHaveLength(4)
  })

  it('gives up after five pages, and stops early when the history ends', async () => {
    const answers: Record<string, { body: unknown }> = {}
    for (let i = 0; i < 6; i++) {
      answers[`GET /api/accounts/alpha/history?limit=20&offset=${i * 20}`] = {
        body: { total: 500, items: page(500 - i * 20, 20) },
      }
    }
    const long = fakeFetch(answers)
    expect(await loadLastDigest(createApi(long.fetchFn), 'alpha')).toBeNull()
    expect(long.calls).toHaveLength(5)
    const short = fakeFetch({
      'GET /api/accounts/alpha/history?limit=20&offset=0': { body: { total: 3, items: page(3, 3) } },
    })
    expect(await loadLastDigest(createApi(short.fetchFn), 'alpha')).toBeNull()
    expect(short.calls).toHaveLength(1)
  })
})
