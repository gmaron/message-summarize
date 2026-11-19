import { describe, expect, it } from 'vitest'
import { webEn } from '../../../src/infrastructure/i18n/web-en.js'
import { webEs } from '../../../src/infrastructure/i18n/web-es.js'
import { createApi } from '../../../src/interfaces/web/lib/api.js'
import {
  appendRuns,
  createHistoryList,
  durationText,
  failureReasonText,
  mergeNewest,
  outcomeKey,
  providersText,
  runErrorText,
  runPill,
} from '../../../src/interfaces/web/lib/history.js'
import type { HistoryDetail, HistoryRun, HistoryView } from '../../../src/interfaces/web/lib/types.js'
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
const view = (ids: number[], total = ids.length): HistoryView => ({ total, items: ids.map((id) => run(id)) })
const wait = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('texts of a run', () => {
  it('says a duration the way a person reads it', () => {
    expect(durationText(null, webEn)).toBeNull()
    expect(durationText(300, webEn)).toBe('under 1 s')
    expect(durationText(12_400, webEn)).toBe('12 s')
    expect(durationText(125_000, webEn)).toBe('2 min 5 s')
    expect(durationText(125_000, webEs)).toBe('2 min 5 s')
  })

  it('lists the providers biggest first, and names the unknown one', () => {
    expect(providersText({ ollama: 2, 'claude-cli': 12 }, webEn)).toBe('Claude (command line): 12, Ollama (local): 2')
    expect(providersText({ unknown: 1 }, webEn)).toBe('unknown: 1')
    expect(providersText({ 'other-llm': 1 }, webEn)).toBe('other-llm: 1')
    expect(providersText({ unknown: 1 }, webEs)).toBe('sin datos: 1')
    expect(providersText({}, webEn)).toBe('none')
  })

  it('translates the error of a run, with the generic text for a code it does not know', () => {
    expect(runErrorText(null, webEn)).toBeNull()
    expect(runErrorText('noProvider', webEn)).toBe(webEn.digestErrors.noProvider)
    expect(runErrorText('interrupted', webEs)).toBe(webEs.ui.history.interrupted)
    expect(runErrorText('somethingNew', webEn)).toBe(webEn.ui.digest.failed)
  })

  it('translates the reason of a failed conversation, with the generic text for a new code', () => {
    expect(failureReasonText('timeout', webEn)).toBe(webEn.ui.history.reason.timeout)
    expect(failureReasonText('toString', webEn)).toBe(webEn.ui.history.reason.failed)
    expect(failureReasonText('newReason', webEs)).toBe(webEs.ui.history.reason.failed)
  })

  it('an open run is "running"', () => {
    expect(outcomeKey(run(1, { outcome: null }))).toBe('running')
    expect(outcomeKey(run(1))).toBe('committed')
  })

  it('the pill of a run follows its outcome, and a digest that left chats out is partial', () => {
    expect(runPill(run(1))).toEqual({ tone: 'ok', key: 'committed' })
    expect(runPill(run(1, { failed: 2 }))).toEqual({ tone: 'busy', key: 'partial' })
    expect(runPill(run(1, { outcome: 'empty' }))).toEqual({ tone: 'idle', key: 'empty' })
    expect(runPill(run(1, { outcome: 'failed' }))).toEqual({ tone: 'bad', key: 'failed' })
    expect(runPill(run(1, { outcome: null }))).toEqual({ tone: 'busy', key: 'running' })
  })

  it('has the same shape in Spanish and English', () => {
    const keys = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? keys(v).map((c) => `${k}.${c}`) : [k],
      )
    expect(keys(webEs.ui.history)).toEqual(keys(webEn.ui.history))
  })
})

describe('merging pages', () => {
  it('appends a page without showing a run twice', () => {
    expect(appendRuns(view([5, 4], 6), view([4, 3], 6)).items.map((r) => r.id)).toEqual([5, 4, 3])
  })

  it('puts new runs first, keeps what was loaded below and replaces a run that ended', () => {
    const open = { ...view([5, 4, 3, 2]), items: [run(5, { outcome: null, finishedAt: null }), run(4), run(3), run(2)] }
    const merged = mergeNewest(open, { total: 6, items: [run(6), run(5), run(4)] })
    expect(merged.total).toBe(6)
    expect(merged.items.map((r) => r.id)).toEqual([6, 5, 4, 3, 2])
    expect(merged.items[1]?.outcome).toBe('committed')
  })
})

function setup(answers: Parameters<typeof fakeFetch>[0]) {
  const { fetchFn, calls } = fakeFetch(answers)
  const api = createApi(fetchFn)
  return { list: createHistoryList({ api, account: 'alpha', pageSize: 2 }), calls }
}

describe('createHistoryList', () => {
  it('loads the first page and then the next one, asking for each offset', async () => {
    const { list, calls } = setup({
      'GET /api/accounts/alpha/history?limit=2&offset=0': { body: view([5, 4], 3) },
      'GET /api/accounts/alpha/history?limit=2&offset=2': { body: view([3], 3) },
    })
    expect(list.state.status).toBe('loading')
    await list.load()
    expect(list.state.view?.items.map((r) => r.id)).toEqual([5, 4])
    await list.loadMore()
    expect(list.state.view?.items.map((r) => r.id)).toEqual([5, 4, 3])
    await list.loadMore()
    expect(calls.filter((c) => c.path.includes('offset=2'))).toHaveLength(1)
  })

  it('reports the code of a failed load and recovers on retry', async () => {
    const answer: { status: number; body: unknown } = { status: 409, body: { error: 'busy' } }
    const { list } = setup({ 'GET /api/accounts/alpha/history?limit=2&offset=0': () => answer })
    await list.load()
    expect(list.state).toMatchObject({ status: 'error', error: 'busy', view: null })
    Object.assign(answer, { status: 200, body: view([1]) })
    await list.load()
    expect(list.state).toMatchObject({ status: 'ready', error: null })
  })

  it('refresh brings the new run to the top without losing the pages already loaded', async () => {
    let first = view([5, 4], 4)
    const { list } = setup({
      'GET /api/accounts/alpha/history?limit=2&offset=0': () => ({ body: first }),
      'GET /api/accounts/alpha/history?limit=2&offset=2': { body: view([3, 2], 4) },
    })
    await list.load()
    await list.loadMore()
    first = { total: 5, items: [run(6), run(5)] }
    await list.refresh()
    expect(list.state.view?.items.map((r) => r.id)).toEqual([6, 5, 4, 3, 2])
    expect(list.state.view?.total).toBe(5)
  })

  it('opens the detail of a run with the full digest, as text, and goes back', async () => {
    const detail: HistoryDetail = {
      ...run(7),
      since: 1,
      until: 2,
      digest: { text: '<img src=x onerror=alert(1)>\nfull text', since: 1, until: 2 },
      failedConversations: [{ id: '5491100000001@s.whatsapp.net', name: '<b>Ana</b>', reason: 'timeout' }],
    }
    const { list } = setup({
      'GET /api/accounts/alpha/history?limit=2&offset=0': { body: view([7]) },
      'GET /api/accounts/alpha/history/7': { body: detail },
    })
    await list.load()
    const opening = list.open(7)
    expect(list.state.detail).toMatchObject({ runId: 7, status: 'loading' })
    await opening
    expect(list.state.detail?.run?.digest?.text).toBe('<img src=x onerror=alert(1)>\nfull text')
    list.back()
    expect(list.state.detail).toBeNull()
    expect(list.state.view?.items).toHaveLength(1)
  })

  it('shows the code when the detail cannot be read, and ignores an answer for a run no longer open', async () => {
    const { list } = setup({
      'GET /api/accounts/alpha/history/9': { status: 404, body: { error: 'notFound' } },
      'GET /api/accounts/alpha/history/8': { body: { ...run(8), digest: null, failedConversations: [] } },
    })
    await list.open(9)
    expect(list.state.detail).toMatchObject({ runId: 9, status: 'error', error: 'notFound' })
    const slow = list.open(8)
    list.back()
    await slow
    expect(list.state.detail).toBeNull()
  })

  it('does nothing after dispose', async () => {
    const { list } = setup({ 'GET /api/accounts/alpha/history?limit=2&offset=0': { body: view([1]) } })
    const seen: unknown[] = []
    list.subscribe((ui) => seen.push(ui))
    list.dispose()
    await list.load()
    await wait()
    expect(seen).toEqual([])
    expect(list.state.view).toBeNull()
  })
})
