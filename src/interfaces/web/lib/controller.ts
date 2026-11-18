import { isAccountIdValid } from './accounts.js'
import { type Api, ApiError } from './api.js'
import { pickLanguage } from './i18n.js'
import { connectEvents, type EventSourceLike } from './sse.js'
import {
  type AppState,
  applyServerEvent,
  EMPTY_LINK,
  initialState,
  linkFromSnapshot,
  previewFromView,
  withDigest,
  withLink,
  withPreview,
} from './state.js'

export interface ControllerOptions {
  readonly api: Api
  readonly createEventSource: () => EventSourceLike
  /** `navigator.language`, for when the daemon does not say. */
  readonly browserLanguage: string | undefined
  readonly retryMs?: number
}

export type AddAccountResult = { readonly ok: true } | { readonly ok: false; readonly code: string }

const codeOf = (error: unknown): string => (error instanceof ApiError ? error.code : 'internal')

/**
 * Everything the page does besides drawing: it loads, listens to the daemon, keeps the state and sends what the user asks.
 * The components only show `state` and call the actions. The state is replaced (never changed) on every step and
 * `subscribe` tells whoever listens.
 */
export function createController(options: ControllerOptions) {
  const { api } = options
  let state: AppState = initialState(pickLanguage(undefined, options.browserLanguage))
  const listeners = new Set<(state: AppState) => void>()
  const historyListeners = new Set<(account: string) => void>()
  let stream: { close(): void } | null = null

  const set = (next: AppState): void => {
    if (next === state) return
    state = next
    for (const listener of [...listeners]) listener(state)
  }
  const update = (change: (current: AppState) => AppState): void => set(change(state))
  /**
   * The session is not valid (any more: the daemon restarted, sessions live in its memory). The stream is closed for good:
   * retrying it with a cookie the daemon does not know would never end.
   */
  const unauthorized = (): void => {
    stream?.close()
    stream = null
    update((s) => (s.unauthorized ? s : { ...s, unauthorized: true }))
  }
  /** A 401 anywhere means the session is not valid. */
  const failed = (error: unknown): void => {
    if (error instanceof ApiError && error.status === 401) unauthorized()
  }

  const refreshAccounts = async (): Promise<void> => {
    try {
      const accounts = await api.accounts()
      update((s) => ({ ...s, accounts, loadError: null }))
    } catch (error) {
      failed(error)
      update((s) => (s.accounts === null ? { ...s, loadError: codeOf(error) } : s))
    }
  }

  const restoreLink = async (id: string): Promise<void> => {
    try {
      const snapshot = await api.linkSnapshot(id)
      update((s) => withLink(s, id, (link) => linkFromSnapshot(link, snapshot)))
    } catch (error) {
      failed(error)
    }
  }

  const loadPreview = async (id: string): Promise<void> => {
    try {
      const view = await api.preview(id)
      update((s) => withPreview(s, id, previewFromView(view)))
    } catch (error) {
      failed(error)
      update((s) => withPreview(s, id, { kind: 'error', code: codeOf(error) }))
    }
  }

  return {
    api,
    /** The daemon did not accept the session (or the token of the address). */
    markUnauthorized: unauthorized,
    get state(): AppState {
      return state
    },
    subscribe(listener: (state: AppState) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** Calls `listener` with the account whenever its history gets a new run. Returns the way to stop listening. */
    onHistory(listener: (account: string) => void): () => void {
      historyListeners.add(listener)
      return () => historyListeners.delete(listener)
    },

    /** Asks for the language and the accounts and starts listening. */
    async start(): Promise<void> {
      try {
        const info = await api.info()
        update((s) => ({ ...s, language: pickLanguage(info.language, options.browserLanguage) }))
      } catch (error) {
        failed(error)
      }
      await refreshAccounts()
      stream = connectEvents(
        options.createEventSource,
        {
          event: (name, data) => {
            update((s) => applyServerEvent(s, name, data))
            // the event says how the preview ended, not what it holds: that is asked for
            const account = (data as { account?: unknown } | null)?.account
            if (name === 'preview' && typeof account === 'string') void loadPreview(account)
            // the event says that the history has a new run, not what it holds: an open history asks for it
            if (name === 'history' && typeof account === 'string') {
              for (const listener of [...historyListeners]) listener(account)
            }
          },
          open: (again) => {
            update((s) => ({ ...s, connection: 'online' }))
            // Whatever changed between the first fetch and the stream, or while the stream was down, is asked for again.
            void refreshAccounts()
            if (!again) return
            for (const [id, link] of Object.entries(state.links)) {
              if (link.phase !== 'idle' && link.phase !== 'done' && link.phase !== 'failed') void restoreLink(id)
            }
            for (const [id, preview] of Object.entries(state.previews)) {
              if (preview.kind === 'running') void loadPreview(id)
            }
          },
          broken: () => {
            update((s) => ({ ...s, connection: 'offline' }))
            // A broken stream may be a daemon that restarted and forgot the session: any call says so (a 401 ends it all).
            api.info().catch(failed)
          },
        },
        options.retryMs,
      )
    },
    stop(): void {
      stream?.close()
      stream = null
    },

    refreshAccounts,
    restoreLink,
    loadPreview,

    /** Creates the account and starts linking it. */
    async addAccount(id: string): Promise<AddAccountResult> {
      if (!isAccountIdValid(id)) return { ok: false, code: 'invalidAccountId' }
      try {
        await api.createAccount(id)
      } catch (error) {
        failed(error)
        return { ok: false, code: codeOf(error) }
      }
      await refreshAccounts()
      return { ok: true }
    },

    async startLink(id: string): Promise<void> {
      update((s) => withLink(s, id, { ...EMPTY_LINK, phase: 'waitingQr' }))
      try {
        await api.startLink(id)
      } catch (error) {
        failed(error)
        // a link that is already in progress is not a failure: its state is what the dialog shows
        if (error instanceof ApiError && error.code === 'alreadyLinking') return restoreLink(id)
        update((s) => withLink(s, id, { ...EMPTY_LINK, phase: 'idle', requestError: codeOf(error) }))
      }
    },

    async cancelLink(id: string): Promise<void> {
      try {
        await api.cancelLink(id)
      } catch (error) {
        failed(error)
        if (!(error instanceof ApiError && error.code === 'notLinking')) {
          update((s) => withLink(s, id, { requestError: codeOf(error) }))
          return
        }
      }
      update((s) => withLink(s, id, EMPTY_LINK))
    },

    async retry(id: string): Promise<string | null> {
      try {
        await api.retry(id)
      } catch (error) {
        failed(error)
        return codeOf(error)
      }
      await refreshAccounts()
      return null
    },

    async digestNow(id: string): Promise<void> {
      update((s) => withDigest(s, id, { kind: 'requesting' }))
      try {
        const reply = await api.digestNow(id)
        // The events may have said more already (started, done): only a state that is still "requesting" is replaced.
        update((s) =>
          s.digests[id]?.kind === 'requesting'
            ? withDigest(s, id, { kind: reply.state === 'deferred' ? 'deferred' : 'started' })
            : s,
        )
      } catch (error) {
        failed(error)
        const code = codeOf(error)
        update((s) => withDigest(s, id, code === 'busy' ? { kind: 'busy' } : { kind: 'error', code }))
      }
    },

    async startPreview(id: string): Promise<void> {
      update((s) => withPreview(s, id, { kind: 'running' }))
      try {
        await api.startPreview(id)
      } catch (error) {
        failed(error)
        // one already running is still a preview to wait for
        if (error instanceof ApiError && error.code === 'busy') return
        update((s) => withPreview(s, id, { kind: 'error', code: codeOf(error) }))
      }
    },
  }
}

export type Controller = ReturnType<typeof createController>
