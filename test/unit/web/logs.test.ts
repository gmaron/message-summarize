import { describe, expect, it } from 'vitest'
import { webEn } from '../../../src/infrastructure/i18n/web-en.js'
import { webEs } from '../../../src/infrastructure/i18n/web-es.js'
import { createApi } from '../../../src/interfaces/web/lib/api.js'
import {
  accountLabel,
  createLogsList,
  fieldsText,
  INSTALLATION,
  levelTone,
  logTime,
  logTimeFull,
  MAX_KEPT,
  mergeNewest,
} from '../../../src/interfaces/web/lib/logs.js'
import type { LogEntry, LogLevel } from '../../../src/interfaces/web/lib/types.js'
import { fakeFetch } from './support.js'

const entry = (seq: number, over: Partial<LogEntry> = {}): LogEntry => ({
  seq,
  time: '2026-11-17T12:00:00.000Z',
  level: 'info',
  event: `event.${seq}`,
  fields: {},
  ...over,
})
/** Newest first, like the daemon answers. */
const page = (from: number, to: number): LogEntry[] => {
  const items: LogEntry[] = []
  for (let seq = from; seq >= to; seq--) items.push(entry(seq))
  return items
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A fake daemon that answers /api/logs by the query it receives. */
function daemon(
  handler: (query: URLSearchParams) => LogEntry[] | { status: number; error: string },
  boot: () => string = () => 'boot-1',
) {
  const seen: URLSearchParams[] = []
  const fetchFn = async (input: string) => {
    const url = new URL(input, 'http://x')
    seen.push(url.searchParams)
    const result = handler(url.searchParams)
    if (!Array.isArray(result)) return { status: result.status, ok: false, json: async () => ({ error: result.error }) }
    return { status: 200, ok: true, json: async () => ({ boot: boot(), items: result }) }
  }
  return { seen, api: createApi(fetchFn, () => undefined) }
}

describe('text of a line', () => {
  it('shows the fields as key=value, and null as null', () => {
    expect(fieldsText({})).toBe('')
    expect(fieldsText({ code: 'EACCES', count: 3, delivered: true, pointer: null })).toBe(
      'code=EACCES count=3 delivered=true pointer=null',
    )
  })

  it('keeps markup as text: nothing is interpreted here, the page draws it as a text node', () => {
    expect(fieldsText({ reason: '<img src=x onerror=alert(1)>' })).toBe('reason=<img src=x onerror=alert(1)>')
  })

  it('formats the time in the locale of the page, and leaves a value that is not a date as it came', () => {
    // Short and the same for every line: day, month and 24-hour time, with no year and no seconds.
    expect(logTime('2026-11-17T12:00:00.000Z', 'en')).toMatch(/^(Nov 17|17 Nov), \d{2}:\d{2}$/)
    expect(logTime('2026-11-17T12:00:00.000Z', 'es')).toMatch(/^17 nov,? \d{2}:\d{2}$/)
    expect(logTimeFull('2026-11-17T12:00:00.000Z', 'en')).toMatch(/2026|26/)
    expect(logTimeFull('not a date', 'en')).toBe('not a date')
    expect(logTime('not a date', 'en')).toBe('not a date')
  })

  it('names the account, or the installation when the line has none', () => {
    expect(accountLabel('alpha', webEn)).toBe('alpha')
    expect(accountLabel(undefined, webEn)).toBe('Installation')
    expect(accountLabel(undefined, webEs)).toBe('Instalación')
    expect(levelTone('error')).toBe('error')
    expect(levelTone('warn')).toBe('warn')
    expect(levelTone('info')).toBe('ok')
  })
})

describe('mergeNewest', () => {
  it('puts the new lines over the ones shown, without repeating any', () => {
    const merged = mergeNewest(page(10, 6), page(12, 9))
    expect(merged.map((e) => e.seq)).toEqual([12, 11, 10, 9, 8, 7, 6])
  })

  it('keeps what is shown when nothing new came, and takes the page when nothing was shown', () => {
    const shown = page(10, 6)
    expect(mergeNewest(shown, [])).toBe(shown)
    expect(mergeNewest(shown, page(10, 8)).map((e) => e.seq)).toEqual([10, 9, 8, 7, 6])
    const fresh = page(3, 1)
    expect(mergeNewest([], fresh)).toBe(fresh)
  })

  it('replaces the list when the new page does not touch it (more than a page arrived) or the daemon restarted', () => {
    const gap = page(500, 301)
    expect(mergeNewest(page(10, 6), gap)).toBe(gap)
    const restarted = page(4, 1)
    expect(mergeNewest(page(10, 6), restarted)).toBe(restarted)
  })

  it('never keeps more than the bound', () => {
    const shown = page(MAX_KEPT, 1)
    expect(mergeNewest(shown, page(MAX_KEPT + 5, MAX_KEPT)).length).toBe(MAX_KEPT)
  })
})

describe('the logs list', () => {
  it('loads the first page with the default filters (info, every account)', async () => {
    const { api, seen } = daemon(() => page(5, 1))
    const list = createLogsList({ api, pageSize: 5 })
    expect(list.state.status).toBe('loading')
    await list.load()
    expect(list.state.status).toBe('ready')
    expect(list.state.items.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1])
    expect(list.state.more).toBe(true)
    expect(seen[0]?.get('level')).toBe('info')
    expect(seen[0]?.has('account')).toBe(false)
    expect(seen[0]?.get('limit')).toBe('5')
  })

  it('"load older" asks before the oldest shown, appends, and stops when a page is short', async () => {
    const { api, seen } = daemon((query) => (query.has('before') ? page(2, 1) : page(5, 3)))
    const list = createLogsList({ api, pageSize: 3 })
    await list.load()
    expect(list.state.more).toBe(true)
    await list.loadOlder()
    expect(seen[1]?.get('before')).toBe('3')
    expect(list.state.items.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1])
    expect(list.state.more).toBe(false)
    await list.loadOlder()
    expect(seen).toHaveLength(2)
  })

  it('changing a filter starts again with it, and an answer for the old filter is ignored', async () => {
    const slow: { resolve?: () => void } = {}
    const seen: URLSearchParams[] = []
    const fetchFn = async (input: string) => {
      const query = new URL(input, 'http://x').searchParams
      seen.push(query)
      if (query.get('level') === 'info') await new Promise<void>((resolve) => (slow.resolve = resolve))
      const items = query.get('level') === 'info' ? [entry(1, { event: 'old.filter' })] : [entry(9, { level: 'error' })]
      return { status: 200, ok: true, json: async () => ({ boot: 'boot-1', items }) }
    }
    const list = createLogsList({ api: createApi(fetchFn, () => undefined) })
    const first = list.load()
    await wait()
    list.setFilters({ level: 'error' as LogLevel, account: INSTALLATION })
    await wait()
    slow.resolve?.()
    await first
    await wait()
    expect(list.state.items.map((e) => e.seq)).toEqual([9])
    expect(seen.at(-1)?.get('level')).toBe('error')
    expect(seen.at(-1)?.get('account')).toBe('-')
    expect(list.state.level).toBe('error')
    expect(list.state.account).toBe('-')
  })

  it('refresh adds the new lines on top and keeps what was loaded below', async () => {
    let newest = 5
    const { api } = daemon(() => page(newest, newest - 4))
    const list = createLogsList({ api, pageSize: 5 })
    await list.load()
    newest = 7
    await list.refresh()
    expect(list.state.items.map((e) => e.seq)).toEqual([7, 6, 5, 4, 3, 2, 1].slice(0, 7))
  })

  it('refresh with a failing daemon leaves the list alone; a failing first load is an error with a code', async () => {
    let fail = false
    const { api } = daemon(() => (fail ? { status: 503, error: 'unavailable' } : page(3, 1)))
    const list = createLogsList({ api })
    await list.load()
    fail = true
    await list.refresh()
    expect(list.state.status).toBe('ready')
    expect(list.state.items).toHaveLength(3)
    await list.load()
    expect(list.state).toMatchObject({ status: 'error', error: 'unavailable' })
    fail = false
    await list.refresh()
    expect(list.state.status).toBe('ready')
  })

  it('replaces the list when the run of the daemon changed, even when the numbers would merge', async () => {
    let boot = 'boot-1'
    let answer = page(10, 6)
    const { api } = daemon(
      () => answer,
      () => boot,
    )
    const list = createLogsList({ api, pageSize: 5 })
    await list.load()
    // a restarted daemon has fewer lines, numbered again from 1, and one of them has the same seq as one shown
    boot = 'boot-2'
    answer = page(11, 7).map((e) => ({ ...e, event: 'new.run' }))
    await list.refresh()
    expect(list.state.boot).toBe('boot-2')
    expect(list.state.items.map((e) => e.seq)).toEqual([11, 10, 9, 8, 7])
    expect(list.state.items.every((e) => e.event === 'new.run')).toBe(true)
  })

  it('"load older" after a restart starts again instead of mixing two runs', async () => {
    let boot = 'boot-1'
    const { api } = daemon(
      (query) => (query.has('before') ? page(2, 1) : page(5, 3)),
      () => boot,
    )
    const list = createLogsList({ api, pageSize: 3 })
    await list.load()
    boot = 'boot-2'
    await list.loadOlder()
    await wait()
    expect(list.state.boot).toBe('boot-2')
    expect(list.state.items.map((e) => e.seq)).toEqual([5, 4, 3])
  })

  it('ignores answers after dispose and tells its listeners of each step', async () => {
    const { api } = daemon(() => page(2, 1))
    const list = createLogsList({ api })
    const states: string[] = []
    list.subscribe((ui) => states.push(ui.status))
    await list.load()
    expect(states).toEqual(['ready'])
    list.dispose()
    await list.load()
    expect(states).toEqual(['ready'])
  })

  it('goes through the real api client: the query has only what was chosen', async () => {
    const { fetchFn, calls } = fakeFetch({
      'GET /api/logs?level=warn&account=alpha&limit=50&before=9': { body: { boot: 'b', items: [] } },
    })
    const api = createApi(fetchFn, () => undefined)
    expect(await api.logs({ level: 'warn', account: 'alpha', limit: 50, before: 9 })).toEqual({ boot: 'b', items: [] })
    expect(calls[0]?.path).toBe('/api/logs?level=warn&account=alpha&limit=50&before=9')
    await api.logs({}).catch(() => undefined)
    expect(calls[1]?.path).toBe('/api/logs')
  })
})
