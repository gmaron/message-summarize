import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
import { type Api, ApiError } from './api.js'
import { digestErrorText } from './digest.js'
import { fmt } from './i18n.js'
import type { HistoryDetail, HistoryRun, HistoryView, RunOutcome } from './types.js'

/** How many runs each request asks for. */
export const PAGE_SIZE = 20

export type OutcomeKey = RunOutcome | 'running'

/** The label of a run's outcome: a run with no outcome is still running (or was cut off, which the error says). */
export const outcomeKey = (run: Pick<HistoryRun, 'outcome'>): OutcomeKey => run.outcome ?? 'running'

/** What the pill of a run says: a run that sent its digest but left chats unsummarized is "partial". */
export type RunPillKey = OutcomeKey | 'partial'

export function runPill(run: Pick<HistoryRun, 'outcome' | 'failed'>): {
  tone: 'ok' | 'bad' | 'busy' | 'idle'
  key: RunPillKey
} {
  if (run.outcome === 'committed')
    return run.failed > 0 ? { tone: 'busy', key: 'partial' } : { tone: 'ok', key: 'committed' }
  if (run.outcome === 'empty') return { tone: 'idle', key: 'empty' }
  if (run.outcome === 'failed') return { tone: 'bad', key: 'failed' }
  return { tone: 'busy', key: 'running' }
}

/** A duration the way a person reads it: "under 1 s", "12 s", "2 min 5 s". Null while the run is open. */
export function durationText(durationMs: number | null, texts: WebTexts): string | null {
  if (durationMs === null) return null
  const t = texts.ui.history
  const total = Math.round(durationMs / 1000)
  if (total < 1) return t.underSecond
  if (total < 60) return fmt(t.seconds, { n: total })
  return fmt(t.minutes, { m: Math.floor(total / 60), s: total % 60 })
}

/** The name of a provider as the settings say it ("Claude (command line)"); a name the page does not know is shown as it is. */
export function providerLabel(name: string, texts: WebTexts): string {
  if (name === 'unknown') return texts.ui.history.unknownProvider
  const names = texts.ui.settings.providerNames as Readonly<Record<string, string>>
  return Object.hasOwn(names, name) ? (names[name] as string) : name
}

/** The providers of a run, biggest first: "Claude: 12, Ollama: 2". Empty when none summarized anything. */
export function providersText(providers: Readonly<Record<string, number>>, texts: WebTexts): string {
  const t = texts.ui.history
  const entries = Object.entries(providers).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (entries.length === 0) return t.noProviders
  return entries
    .map(([name, count]) => fmt(t.providerCount, { provider: providerLabel(name, texts), count }))
    .join(texts.ui.text.listSeparator)
}

/** Why a run failed: `interrupted` is the history's own code, the others are the ones of a digest. Null when it did not fail. */
export function runErrorText(code: string | null, texts: WebTexts): string | null {
  if (code === null) return null
  return code === 'interrupted' ? texts.ui.history.interrupted : digestErrorText(code, texts)
}

/** Why a conversation could not be summarized, with the generic text for a code the page does not know. */
export function failureReasonText(code: string, texts: WebTexts): string {
  const table = texts.ui.history.reason as Record<string, string>
  return Object.hasOwn(table, code) ? (table[code] as string) : texts.ui.history.reason.failed
}

export interface HistoryUi {
  readonly status: 'loading' | 'ready' | 'error'
  readonly error: string | null
  readonly view: HistoryView | null
  readonly loadingMore: boolean
  /** The run being looked at in detail, or null for the list. */
  readonly detail:
    | { readonly runId: number; readonly status: 'loading'; readonly error: null; readonly run: null }
    | { readonly runId: number; readonly status: 'error'; readonly error: string; readonly run: null }
    | { readonly runId: number; readonly status: 'ready'; readonly error: null; readonly run: HistoryDetail }
    | null
}

export interface HistoryListOptions {
  readonly api: Api
  readonly account: string
  readonly pageSize?: number
}

const codeOf = (error: unknown): string => (error instanceof ApiError ? error.code : 'internal')

/** Runs already shown plus the next page; a run that moved between pages is not shown twice. */
export function appendRuns(view: HistoryView, next: HistoryView): HistoryView {
  const seen = new Set(view.items.map((run) => run.id))
  return { total: next.total, items: [...view.items, ...next.items.filter((run) => !seen.has(run.id))] }
}

/**
 * The runs at the top of a fresh first page that the list does not have yet, put before what is shown: a new run
 * arrived while the list was open. What was loaded further down stays (the person may have pressed "load more").
 */
export function mergeNewest(view: HistoryView, fresh: HistoryView): HistoryView {
  const freshIds = new Set(fresh.items.map((run) => run.id))
  // a run that was open and has ended now is replaced by its new version
  const rest = view.items.filter((run) => !freshIds.has(run.id))
  return { total: fresh.total, items: [...fresh.items, ...rest] }
}

/**
 * The state and the actions of the history dialog, apart from drawing it: the list with "load more", the detail of one
 * run, and a refresh when the daemon says that the history has a new run. The state is replaced on every step and
 * `subscribe` tells whoever listens. Answers that arrive after `dispose()` or for a run that is no longer open are ignored.
 */
export function createHistoryList(options: HistoryListOptions) {
  const { api, account } = options
  const pageSize = options.pageSize ?? PAGE_SIZE
  let ui: HistoryUi = { status: 'loading', error: null, view: null, loadingMore: false, detail: null }
  const listeners = new Set<(ui: HistoryUi) => void>()
  let disposed = false
  let listTicket = 0

  const set = (next: HistoryUi): void => {
    if (disposed) return
    ui = next
    for (const listener of [...listeners]) listener(ui)
  }

  async function load(): Promise<void> {
    const ticket = ++listTicket
    try {
      const view = await api.history(account, { limit: pageSize, offset: 0 })
      if (ticket !== listTicket) return
      set({ ...ui, status: 'ready', error: null, view, loadingMore: false })
    } catch (error) {
      if (ticket !== listTicket) return
      set({ ...ui, status: 'error', error: codeOf(error), loadingMore: false })
    }
  }

  /** A run was added: the first page is asked for again and merged, keeping what was loaded below. */
  async function refresh(): Promise<void> {
    if (ui.view === null) return load()
    const ticket = ++listTicket
    try {
      const fresh = await api.history(account, { limit: pageSize, offset: 0 })
      if (ticket !== listTicket || ui.view === null) return
      set({ ...ui, view: mergeNewest(ui.view, fresh), loadingMore: false })
    } catch {
      // the list that is shown stays; the next event or "load more" tries again
    }
  }

  async function loadMore(): Promise<void> {
    const view = ui.view
    if (view === null || ui.loadingMore || view.items.length >= view.total) return
    const ticket = listTicket
    set({ ...ui, loadingMore: true })
    try {
      const next = await api.history(account, { limit: pageSize, offset: view.items.length })
      if (ticket !== listTicket || ui.view === null) return
      set({ ...ui, view: appendRuns(ui.view, next), loadingMore: false })
    } catch (error) {
      if (ticket !== listTicket) return
      set({ ...ui, loadingMore: false, error: codeOf(error), status: 'error' })
    }
  }

  async function open(runId: number): Promise<void> {
    set({ ...ui, detail: { runId, status: 'loading', error: null, run: null } })
    try {
      const run = await api.historyRun(account, runId)
      if (ui.detail?.runId !== runId) return
      set({ ...ui, detail: { runId, status: 'ready', error: null, run } })
    } catch (error) {
      if (ui.detail?.runId !== runId) return
      set({ ...ui, detail: { runId, status: 'error', error: codeOf(error), run: null } })
    }
  }

  function back(): void {
    set({ ...ui, detail: null })
  }

  return {
    get state(): HistoryUi {
      return ui
    },
    subscribe(listener: (ui: HistoryUi) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
    refresh,
    loadMore,
    open,
    back,
    dispose(): void {
      disposed = true
      listTicket++
      listeners.clear()
    },
  }
}

export type HistoryList = ReturnType<typeof createHistoryList>
