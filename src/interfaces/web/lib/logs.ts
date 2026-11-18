import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
import { type Api, ApiError } from './api.js'
import type { LogEntry, LogLevel } from './types.js'

/** How many lines each request asks for. */
export const PAGE_SIZE = 200
/** The most lines kept on the page: older ones beyond this are dropped from memory (they are still asked for on demand). */
export const MAX_KEPT = 2_000
/** The value of the account filter for the lines that belong to no account (the daemon's `account=-`). */
export const INSTALLATION = '-'

export const LEVELS: readonly LogLevel[] = ['info', 'warn', 'error']

/** `key=value` of the fields, in the order the daemon wrote them. Plain text: it goes into the page as a text node. */
export function fieldsText(fields: LogEntry['fields']): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`)
    .join(' ')
}

/** The time of a line in the browser's zone, with seconds. A value that is not a date is shown as it came. */
export function logTime(iso: string, locale: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }).format(ms)
}

export const levelTone = (level: LogLevel): 'ok' | 'warn' | 'error' =>
  level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'ok'

/** What a person reads for the account of a line: its id, or "installation" when it has none. */
export const accountLabel = (account: string | undefined, texts: WebTexts): string =>
  account === undefined ? texts.ui.logs.installation : account

export interface LogsUi {
  readonly status: 'loading' | 'ready' | 'error'
  readonly error: string | null
  readonly level: LogLevel
  /** '' for every account, INSTALLATION for the lines of the installation, else an account id. */
  readonly account: string
  /** Newest first. */
  readonly items: readonly LogEntry[]
  /** The run of the daemon the lines come from; null before the first answer. */
  readonly boot: string | null
  /** The last page asked for was full, so there may be older lines. */
  readonly more: boolean
  readonly loadingOlder: boolean
}

export interface LogsListOptions {
  readonly api: Api
  readonly pageSize?: number
}

/**
 * Lines fetched for the top of the list (a refresh) put over what is shown. A refresh whose lines do not follow what the
 * list has (the daemon restarted and counts from 1 again, or more than a page of new lines came) replaces the list: a
 * mix of both would be out of order.
 */
export function mergeNewest(shown: readonly LogEntry[], fresh: readonly LogEntry[]): readonly LogEntry[] {
  const newest = shown[0]
  const oldestFresh = fresh[fresh.length - 1]
  const newestFresh = fresh[0]
  if (newest === undefined || oldestFresh === undefined || newestFresh === undefined)
    return fresh.length === 0 ? shown : fresh
  if (newestFresh.seq < newest.seq || oldestFresh.seq > newest.seq + 1) return fresh
  return [...fresh, ...shown.filter((entry) => entry.seq < oldestFresh.seq)].slice(0, MAX_KEPT)
}

const codeOf = (error: unknown): string => (error instanceof ApiError ? error.code : 'internal')

/**
 * The state and the actions of the logs view, apart from drawing it: the filters, the first page, "load older" and a
 * refresh when the daemon says that there are new lines. The state is replaced on every step and `subscribe` tells whoever
 * listens. Answers that arrive after `dispose()`, or for filters that are no longer the ones chosen, are ignored.
 */
export function createLogsList(options: LogsListOptions) {
  const { api } = options
  const pageSize = options.pageSize ?? PAGE_SIZE
  let ui: LogsUi = {
    status: 'loading',
    error: null,
    level: 'info',
    account: '',
    items: [],
    boot: null,
    more: false,
    loadingOlder: false,
  }
  const listeners = new Set<(ui: LogsUi) => void>()
  let disposed = false
  let ticket = 0

  const set = (next: LogsUi): void => {
    if (disposed) return
    ui = next
    for (const listener of [...listeners]) listener(ui)
  }
  const query = (extra: { before?: number } = {}) => ({
    level: ui.level,
    ...(ui.account === '' ? {} : { account: ui.account }),
    limit: pageSize,
    ...extra,
  })

  async function load(): Promise<void> {
    const mine = ++ticket
    try {
      const { boot, items } = await api.logs(query())
      if (mine !== ticket) return
      set({ ...ui, status: 'ready', error: null, items, boot, more: items.length >= pageSize, loadingOlder: false })
    } catch (error) {
      if (mine !== ticket) return
      set({ ...ui, status: 'error', error: codeOf(error), loadingOlder: false })
    }
  }

  async function refresh(): Promise<void> {
    if (ui.status !== 'ready') return load()
    const mine = ++ticket
    try {
      const { boot, items: fresh } = await api.logs(query())
      if (mine !== ticket) return
      // Another run of the daemon numbers its lines from 1 again: what is shown is from before, so it is replaced.
      const items = boot !== ui.boot ? fresh : mergeNewest(ui.items, fresh)
      set({ ...ui, items, boot, more: items === fresh ? fresh.length >= pageSize : ui.more, loadingOlder: false })
    } catch {
      // what is shown stays; the next event tries again
    }
  }

  async function loadOlder(): Promise<void> {
    const oldest = ui.items[ui.items.length - 1]
    if (oldest === undefined || ui.loadingOlder || !ui.more) return
    const mine = ticket
    set({ ...ui, loadingOlder: true })
    try {
      const { boot, items: older } = await api.logs(query({ before: oldest.seq }))
      if (mine !== ticket) return
      // The daemon restarted since the list was loaded: `before` meant another run. Start again.
      if (boot !== ui.boot) return void load()
      set({ ...ui, error: null, items: [...ui.items, ...older], more: older.length >= pageSize, loadingOlder: false })
    } catch (error) {
      if (mine !== ticket) return
      set({ ...ui, loadingOlder: false, error: codeOf(error) })
    }
  }

  function setFilters(filters: { level?: LogLevel; account?: string }): void {
    ticket++
    set({
      ...ui,
      level: filters.level ?? ui.level,
      account: filters.account ?? ui.account,
      status: 'loading',
      error: null,
      items: [],
      more: false,
      loadingOlder: false,
    })
    void load()
  }

  return {
    get state(): LogsUi {
      return ui
    },
    subscribe(listener: (ui: LogsUi) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
    refresh,
    loadOlder,
    setFilters,
    dispose(): void {
      disposed = true
      ticket++
      listeners.clear()
    },
  }
}

export type LogsList = ReturnType<typeof createLogsList>
