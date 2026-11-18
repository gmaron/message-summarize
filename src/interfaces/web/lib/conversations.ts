import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
import { type Api, ApiError } from './api.js'
import { fmt } from './i18n.js'
import type { ConversationItem, ConversationsView, MarkSource, MarksResult, UnreadView } from './types.js'

/** How many conversations each request asks for. */
export const PAGE_SIZE = 50
/** How long the search waits after the last key before it asks. */
export const SEARCH_DEBOUNCE_MS = 300

export type MarkKey = 'excluded' | 'localOnly'

/** What a toggle of the page can do now. */
export interface ToggleState {
  readonly checked: boolean
  /** Fixed: the mark comes from a pattern of the configuration, which this page does not edit. */
  readonly fixed: boolean
  /** Cannot be turned on: "local only" needs an Ollama model. A mark that is on can always be turned off. */
  readonly disabled: boolean
}

type Marked = { readonly marks: { readonly excluded: MarkSource; readonly localOnly: MarkSource } }

export function toggleState(item: Marked, key: MarkKey, localAvailable: boolean): ToggleState {
  const source = item.marks[key]
  const checked = source !== null
  const fixed = source === 'pattern'
  return { checked, fixed, disabled: fixed || (key === 'localOnly' && !checked && !localAvailable) }
}

/** How a chat's unread state is said. Null when it says nothing. */
export function unreadText(unread: UnreadView, texts: WebTexts): string | null {
  const t = texts.ui.conversations
  if (unread.kind === 'markedUnread') return t.markedUnread
  if (unread.kind === 'count' && unread.count > 0) return fmt(t.unread, { count: unread.count })
  return null
}

/**
 * The view after a successful change of marks. A chat that was excluded is no longer stored (the daemon deleted it): it
 * leaves the list and goes to `unlisted`, where its mark can be removed. An unlisted chat with no mark left is gone.
 */
export function applyMarks(view: ConversationsView, result: MarksResult): ConversationsView {
  const marks = { excluded: result.excluded, localOnly: result.localOnly, marks: result.marks }
  const index = view.items.findIndex((item) => item.id === result.id)
  if (index >= 0) {
    if (result.marks.excluded === 'account') {
      const items = view.items.filter((item) => item.id !== result.id)
      return {
        ...view,
        total: Math.max(0, view.total - 1),
        items,
        unlisted: [{ id: result.id, ...marks }, ...view.unlisted.filter((item) => item.id !== result.id)],
      }
    }
    const items = view.items.map((item) => (item.id === result.id ? ({ ...item, ...marks } as ConversationItem) : item))
    return { ...view, items }
  }
  const unlisted = view.unlisted
    .map((item) => (item.id === result.id ? { ...item, ...marks } : item))
    .filter((item) => item.marks.excluded !== null || item.marks.localOnly !== null)
  return { ...view, unlisted }
}

/** Items already shown plus the next page; a chat that moved between pages is not shown twice. */
export function appendPage(view: ConversationsView, next: ConversationsView): ConversationsView {
  const seen = new Set(view.items.map((item) => item.id))
  return {
    ...next,
    items: [...view.items, ...next.items.filter((item) => !seen.has(item.id))],
    unlisted: view.unlisted,
  }
}

export interface ConversationsUi {
  readonly status: 'loading' | 'ready' | 'error'
  /** Code of the error that stopped the list (status 'error'). */
  readonly error: string | null
  readonly query: string
  readonly view: ConversationsView | null
  readonly loadingMore: boolean
  /** Ids with a change in flight. */
  readonly saving: readonly string[]
  /** Code of the error of the last change of each chat. */
  readonly rowErrors: Readonly<Record<string, string>>
  /** An exclusion waiting for the person to confirm that the stored messages are deleted. */
  readonly confirming: { readonly id: string; readonly messages: number } | null
}

export interface ConversationListOptions {
  readonly api: Api
  readonly account: string
  readonly pageSize?: number
  readonly debounceMs?: number
}

const codeOf = (error: unknown): string => (error instanceof ApiError ? error.code : 'internal')

/**
 * The state and the actions of the conversations dialog, apart from drawing it. Searching waits for the person to stop
 * typing and ignores answers that are not for the latest search; "load more" asks for the next page of the same search.
 * The state is replaced on every step and `subscribe` tells whoever listens.
 */
export function createConversationList(options: ConversationListOptions) {
  const { api, account } = options
  const pageSize = options.pageSize ?? PAGE_SIZE
  const debounceMs = options.debounceMs ?? SEARCH_DEBOUNCE_MS
  let ui: ConversationsUi = {
    status: 'loading',
    error: null,
    query: '',
    view: null,
    loadingMore: false,
    saving: [],
    rowErrors: {},
    confirming: null,
  }
  const listeners = new Set<(ui: ConversationsUi) => void>()
  let latest = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const set = (next: ConversationsUi): void => {
    if (disposed) return
    ui = next
    for (const listener of [...listeners]) listener(ui)
  }

  /** Asks for the first page of the current search. */
  async function load(): Promise<void> {
    const ticket = ++latest
    const q = ui.query
    try {
      const view = await api.conversations(account, { q, limit: pageSize, offset: 0 })
      if (ticket !== latest) return
      set({ ...ui, status: 'ready', error: null, view, loadingMore: false })
    } catch (error) {
      if (ticket !== latest) return
      set({ ...ui, status: 'error', error: codeOf(error), loadingMore: false })
    }
  }

  async function loadMore(): Promise<void> {
    const view = ui.view
    if (view === null || ui.loadingMore || view.items.length >= view.total) return
    const ticket = latest
    const q = ui.query
    set({ ...ui, loadingMore: true })
    try {
      const next = await api.conversations(account, { q, limit: pageSize, offset: view.items.length })
      if (ticket !== latest || ui.view === null) return
      set({ ...ui, view: appendPage(ui.view, next), loadingMore: false })
    } catch (error) {
      if (ticket !== latest) return
      set({ ...ui, loadingMore: false, error: codeOf(error), status: 'error' })
    }
  }

  function setQuery(query: string): void {
    set({ ...ui, query })
    if (timer !== null) clearTimeout(timer)
    // Whatever was asked before is stale from this key on.
    latest++
    timer = setTimeout(() => {
      timer = null
      void load()
    }, debounceMs)
  }

  const without = (ids: readonly string[], id: string): string[] => ids.filter((x) => x !== id)

  async function send(
    id: string,
    body: { excluded?: boolean; localOnly?: boolean; confirmDelete?: boolean },
  ): Promise<void> {
    set({ ...ui, saving: [...without(ui.saving, id), id], confirming: null, rowErrors: omit(ui.rowErrors, id) })
    try {
      const result = await api.setMarks(account, id, body)
      const view = ui.view === null ? null : applyMarks(ui.view, result)
      set({ ...ui, view, saving: without(ui.saving, id) })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'confirmRequired' && error.messages !== undefined) {
        set({ ...ui, saving: without(ui.saving, id), confirming: { id, messages: error.messages } })
        return
      }
      set({ ...ui, saving: without(ui.saving, id), rowErrors: { ...ui.rowErrors, [id]: codeOf(error) } })
    }
  }

  /**
   * Turns a mark on or off. Excluding a chat that has stored messages asks first (`confirming`): nothing is sent until
   * `confirm()`. A mark that comes from a pattern cannot be changed from here.
   */
  async function toggle(id: string, key: MarkKey, value: boolean): Promise<void> {
    if (ui.saving.includes(id)) return
    const item = ui.view?.items.find((candidate) => candidate.id === id)
    const unlisted = ui.view?.unlisted.find((candidate) => candidate.id === id)
    const target = item ?? unlisted
    if (target === undefined || target.marks[key] === 'pattern') return
    if (key === 'excluded' && value && item !== undefined && item.messages > 0) {
      set({ ...ui, confirming: { id, messages: item.messages }, rowErrors: omit(ui.rowErrors, id) })
      return
    }
    await send(id, { [key]: value })
  }

  async function confirm(): Promise<void> {
    const pending = ui.confirming
    if (pending === null) return
    await send(pending.id, { excluded: true, confirmDelete: true })
  }

  function cancelConfirm(): void {
    set({ ...ui, confirming: null })
  }

  return {
    get state(): ConversationsUi {
      return ui
    },
    subscribe(listener: (ui: ConversationsUi) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
    loadMore,
    setQuery,
    toggle,
    confirm,
    cancelConfirm,
    dispose(): void {
      disposed = true
      latest++
      if (timer !== null) clearTimeout(timer)
      listeners.clear()
    },
  }
}

export type ConversationList = ReturnType<typeof createConversationList>

function omit(record: Readonly<Record<string, string>>, key: string): Record<string, string> {
  const { [key]: _removed, ...rest } = record
  return rest
}
