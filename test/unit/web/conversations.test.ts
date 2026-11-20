import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webEn } from '../../../src/infrastructure/i18n/web-en.js'
import { type Api, createApi } from '../../../src/interfaces/web/lib/api.js'
import {
  appendPage,
  applyMarks,
  createConversationList,
  SEARCH_DEBOUNCE_MS,
  toggleState,
  unreadText,
} from '../../../src/interfaces/web/lib/conversations.js'
import type { ConversationItem, ConversationsView, MarksResult } from '../../../src/interfaces/web/lib/types.js'
import { fakeFetch } from './support.js'

const item = (id: string, over: Partial<ConversationItem> = {}): ConversationItem => ({
  id,
  name: `Chat ${id}`,
  isGroup: false,
  address: '+9911963367943',
  lastMessageAt: 1_000,
  messages: 3,
  unread: { kind: 'unknown' },
  excluded: false,
  localOnly: false,
  marks: { excluded: null, localOnly: null },
  ...over,
})

const view = (items: ConversationItem[], over: Partial<ConversationsView> = {}): ConversationsView => ({
  total: items.length,
  items,
  unlisted: [],
  timezone: 'UTC',
  localAvailable: true,
  ...over,
})

const result = (id: string, over: Partial<MarksResult> = {}): MarksResult => ({
  id,
  excluded: false,
  localOnly: false,
  marks: { excluded: null, localOnly: null },
  deletedMessages: 0,
  ...over,
})

describe('toggleState', () => {
  const none = { marks: { excluded: null, localOnly: null } } as const
  it('is on for an own mark, fixed for a pattern, off for none', () => {
    expect(toggleState({ marks: { excluded: 'account', localOnly: null } }, 'excluded', true)).toEqual({
      checked: true,
      fixed: false,
      disabled: false,
    })
    expect(toggleState({ marks: { excluded: 'pattern', localOnly: null } }, 'excluded', true)).toEqual({
      checked: true,
      fixed: true,
      disabled: true,
    })
    expect(toggleState(none, 'excluded', true)).toEqual({ checked: false, fixed: false, disabled: false })
  })
  it('cannot turn "local only" on without an Ollama model, but can always turn it off', () => {
    expect(toggleState(none, 'localOnly', false).disabled).toBe(true)
    expect(toggleState({ marks: { excluded: null, localOnly: 'account' } }, 'localOnly', false).disabled).toBe(false)
    expect(toggleState(none, 'excluded', false).disabled).toBe(false)
  })
})

describe('unreadText', () => {
  it('says the count or "marked as unread", and nothing for the rest', () => {
    expect(unreadText({ kind: 'count', count: 3 }, webEn)).toBe('3 unread')
    expect(unreadText({ kind: 'markedUnread' }, webEn)).toBe(webEn.ui.conversations.markedUnread)
    expect(unreadText({ kind: 'count', count: 0 }, webEn)).toBeNull()
    expect(unreadText({ kind: 'unknown' }, webEn)).toBeNull()
  })
})

describe('applyMarks', () => {
  it('updates the marks of a chat in place', () => {
    const next = applyMarks(
      view([item('a'), item('b')]),
      result('b', { localOnly: true, marks: { excluded: null, localOnly: 'account' } }),
    )
    expect(next.items[1]).toMatchObject({ id: 'b', localOnly: true, marks: { localOnly: 'account' } })
    expect(next.items[0]).toMatchObject({ id: 'a', localOnly: false })
    expect(next.total).toBe(2)
  })
  it('moves an excluded chat out of the list into the unlisted ones', () => {
    const next = applyMarks(
      view([item('a'), item('b')]),
      result('a', { excluded: true, marks: { excluded: 'account', localOnly: null }, deletedMessages: 3 }),
    )
    expect(next.items.map((i) => i.id)).toEqual(['b'])
    expect(next.total).toBe(1)
    expect(next.unlisted).toEqual([
      { id: 'a', excluded: true, localOnly: false, marks: { excluded: 'account', localOnly: null } },
    ])
  })
  it('drops an unlisted chat that has no mark left, and keeps one that has', () => {
    const base = view([], {
      unlisted: [{ id: 'x', excluded: true, localOnly: true, marks: { excluded: 'account', localOnly: 'account' } }],
    })
    const half = applyMarks(base, result('x', { localOnly: true, marks: { excluded: null, localOnly: 'account' } }))
    expect(half.unlisted).toHaveLength(1)
    expect(applyMarks(half, result('x')).unlisted).toEqual([])
  })
})

describe('appendPage', () => {
  it('adds the next page after the ones shown, without repeating a chat', () => {
    const merged = appendPage(view([item('a'), item('b')], { total: 4 }), view([item('b'), item('c')], { total: 4 }))
    expect(merged.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(merged.total).toBe(4)
  })
})

describe('createConversationList', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const page = (ids: string[], total = ids.length) => ({
    body: view(
      ids.map((id) => item(id)),
      { total },
    ),
  })
  const setup = (answers: Parameters<typeof fakeFetch>[0]) => {
    const fake = fakeFetch(answers)
    const list = createConversationList({ api: createApi(fake.fetchFn), account: 'alpha', pageSize: 2 })
    return { ...fake, list }
  }

  it('loads the first page, and "load more" asks for the next one of the same search', async () => {
    const { list, calls } = setup({
      'GET /api/accounts/alpha/conversations?limit=2&offset=0': page(['a', 'b'], 3),
      'GET /api/accounts/alpha/conversations?limit=2&offset=2': page(['c'], 3),
    })
    await list.load()
    expect(list.state.status).toBe('ready')
    expect(list.state.view?.items.map((i) => i.id)).toEqual(['a', 'b'])
    await list.loadMore()
    expect(list.state.view?.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    await list.loadMore()
    expect(calls).toHaveLength(2)
  })

  it('waits for the typing to stop before it searches, and only the last search counts', async () => {
    const { list, calls } = setup({
      'GET /api/accounts/alpha/conversations?limit=2&offset=0': page(['a']),
      'GET /api/accounts/alpha/conversations?q=an&limit=2&offset=0': page(['an']),
      'GET /api/accounts/alpha/conversations?q=ana&limit=2&offset=0': page(['ana']),
    })
    await list.load()
    list.setQuery('a')
    list.setQuery('an')
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1)
    list.setQuery('ana')
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map((c) => c.path)).toEqual([
      '/api/accounts/alpha/conversations?limit=2&offset=0',
      '/api/accounts/alpha/conversations?q=ana&limit=2&offset=0',
    ])
    expect(list.state.view?.items.map((i) => i.id)).toEqual(['ana'])
  })

  it('ignores a slow answer of an older search', async () => {
    let releaseSlow: () => void = () => {}
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const api = {
      conversations: async (_id: string, query: { q?: string }) => {
        if (query.q === 'b') return view([item('new')])
        await slow
        return view([item('old')])
      },
    } as unknown as Api
    const list = createConversationList({ api, account: 'alpha' })
    const first = list.load()
    list.setQuery('b')
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    releaseSlow()
    await first
    expect(list.state.view?.items.map((i) => i.id)).toEqual(['new'])
  })

  it('shows the code of a failed load', async () => {
    const { list } = setup({
      'GET /api/accounts/alpha/conversations?limit=2&offset=0': { status: 422, body: { error: 'invalidConfig' } },
    })
    await list.load()
    expect(list.state).toMatchObject({ status: 'error', error: 'invalidConfig', view: null })
  })

  it('turns a mark on with one request, and does not touch a mark that comes from a pattern', async () => {
    const { list, calls } = setup({
      'GET /api/accounts/alpha/conversations?limit=2&offset=0': {
        body: view([item('a'), item('p', { excluded: true, marks: { excluded: 'pattern', localOnly: null } })]),
      },
      'PUT /api/accounts/alpha/conversations/a/marks': {
        body: result('a', { localOnly: true, marks: { excluded: null, localOnly: 'account' } }),
      },
    })
    await list.load()
    await list.toggle('a', 'localOnly', true)
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: { localOnly: true } })
    expect(list.state.view?.items[0]).toMatchObject({ localOnly: true })
    const sent = calls.length
    await list.toggle('p', 'excluded', false)
    expect(calls).toHaveLength(sent)
  })

  it('encodes the id of the chat in the path', async () => {
    const { list, calls } = setup({
      'GET /api/accounts/alpha/conversations?limit=2&offset=0': { body: view([item('5491@s.whatsapp.net')]) },
      'PUT /api/accounts/alpha/conversations/5491%40s.whatsapp.net/marks': {
        body: result('5491@s.whatsapp.net', { localOnly: true, marks: { excluded: null, localOnly: 'account' } }),
      },
    })
    await list.load()
    await list.toggle('5491@s.whatsapp.net', 'localOnly', true)
    expect(calls.at(-1)?.path).toBe('/api/accounts/alpha/conversations/5491%40s.whatsapp.net/marks')
  })

  it('asks before excluding a chat with stored messages, and sends nothing until confirmed', async () => {
    const { list, calls } = setup({
      'GET /api/accounts/alpha/conversations?limit=2&offset=0': { body: view([item('a', { messages: 7 }), item('b')]) },
      'PUT /api/accounts/alpha/conversations/a/marks': {
        body: result('a', { excluded: true, marks: { excluded: 'account', localOnly: null }, deletedMessages: 7 }),
      },
    })
    await list.load()
    await list.toggle('a', 'excluded', true)
    expect(list.state.confirming).toEqual({ id: 'a', messages: 7 })
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)

    list.cancelConfirm()
    expect(list.state.confirming).toBeNull()

    await list.toggle('a', 'excluded', true)
    await list.confirm()
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: { excluded: true, confirmDelete: true } })
    expect(list.state.confirming).toBeNull()
    expect(list.state.view?.items.map((i) => i.id)).toEqual(['b'])
    expect(list.state.view?.unlisted.map((i) => i.id)).toEqual(['a'])
  })

  it('excludes a chat with nothing stored at once, and asks when the daemon says there is something', async () => {
    const { list, calls } = setup({
      'GET /api/accounts/alpha/conversations?limit=2&offset=0': {
        body: view([item('a', { messages: 0 }), item('b', { messages: 0 })]),
      },
      'PUT /api/accounts/alpha/conversations/a/marks': {
        body: result('a', { excluded: true, marks: { excluded: 'account', localOnly: null } }),
      },
      'PUT /api/accounts/alpha/conversations/b/marks': { status: 409, body: { error: 'confirmRequired', messages: 2 } },
    })
    await list.load()
    await list.toggle('a', 'excluded', true)
    expect(calls.at(-1)).toMatchObject({ body: { excluded: true } })
    expect(calls.at(-1)?.body).not.toHaveProperty('confirmDelete')
    await list.toggle('b', 'excluded', true)
    expect(list.state.confirming).toEqual({ id: 'b', messages: 2 })
  })

  it('keeps the error of a refused change next to its chat', async () => {
    const { list } = setup({
      'GET /api/accounts/alpha/conversations?limit=2&offset=0': { body: view([item('a')]) },
      'PUT /api/accounts/alpha/conversations/a/marks': { status: 422, body: { error: 'invalidConfig' } },
    })
    await list.load()
    await list.toggle('a', 'localOnly', true)
    expect(list.state.rowErrors).toEqual({ a: 'invalidConfig' })
    expect(list.state.saving).toEqual([])
    expect(list.state.view?.items[0]).toMatchObject({ localOnly: false })
  })

  it('tells its listeners, and stops after dispose', async () => {
    const { list } = setup({ 'GET /api/accounts/alpha/conversations?limit=2&offset=0': page(['a']) })
    const seen: string[] = []
    list.subscribe((ui) => seen.push(ui.status))
    await list.load()
    expect(seen).toEqual(['ready'])
    list.dispose()
    list.setQuery('x')
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    expect(seen).toEqual(['ready'])
  })
})
