import { isAccountIdValid } from './accounts.js'
import { type Api, ApiError } from './api.js'
import { OPENAI_BASE_URL } from './api-providers.js'
import { tokenFromInput } from './auth.js'
import { languageFromBrowser, pickLanguage } from './i18n.js'
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
import type { Language, SetupView } from './types.js'

export interface ControllerOptions {
  readonly api: Api
  readonly createEventSource: () => EventSourceLike
  /** `navigator.language`. Used with `browserLanguages` only on a fresh install and on the page that has no access. */
  readonly browserLanguage?: string | undefined
  /** `navigator.languages`: the order of preference of the user. */
  readonly browserLanguages?: readonly string[] | undefined
  readonly retryMs?: number
}

export type AddAccountResult = { readonly ok: true } | { readonly ok: false; readonly code: string }

/** What the page assumes when the daemon cannot say where the wizard is: it is over, so the panel opens. */
const FALLBACK_SETUP: SetupView = {
  completed: true,
  step: 'you',
  account: null,
  linked: false,
  language: 'es',
  freshInstall: false,
  consents: [],
  openaiBaseUrl: OPENAI_BASE_URL,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
}

export type SetupResult = { readonly ok: true } | { readonly ok: false; readonly error: ApiError | null }

const codeOf = (error: unknown): string => (error instanceof ApiError ? error.code : 'internal')

/**
 * Everything the page does besides drawing: it loads, listens to the daemon, keeps the state and sends what the user asks.
 * The components only show `state` and call the actions. The state is replaced (never changed) on every step and
 * `subscribe` tells whoever listens.
 */
export function createController(options: ControllerOptions) {
  const { api } = options
  // Spanish until something says otherwise (the first render, before the daemon answers).
  let state: AppState = initialState(pickLanguage(undefined))
  /** The user chose a language with the switch: nothing the browser says changes it any more. */
  let languageChosen = false
  const fromBrowser = () => languageFromBrowser(options.browserLanguages, options.browserLanguage)
  const listeners = new Set<(state: AppState) => void>()
  const historyListeners = new Set<(account: string) => void>()
  const logListeners = new Set<() => void>()
  let stream: { close(): void } | null = null

  const set = (next: AppState): void => {
    if (next === state) return
    state = next
    for (const listener of [...listeners]) listener(state)
  }
  const update = (change: (current: AppState) => AppState): void => set(change(state))
  /**
   * The session is not valid (any more: it expired after 30 days, or the token or the session secret was replaced). The
   * stream is closed for good: retrying it with a cookie the daemon does not accept would never end.
   */
  const unauthorized = (): void => {
    stream?.close()
    stream = null
    // The page that has no access has no installation language to show: it follows the browser (Spanish when it says nothing).
    update((s) =>
      s.unauthorized ? s : { ...s, unauthorized: true, language: languageChosen ? s.language : fromBrowser() },
    )
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

  /** The wizard's state. A daemon that cannot say never keeps the panel away: the setup counts as over. */
  const loadSetup = async (): Promise<void> => {
    try {
      const setup = await api.setup()
      // A fresh install has no language of its own yet: the wizard speaks the browser's from its first screen.
      update((s) => ({
        ...s,
        setup,
        language: setup.freshInstall && !setup.completed && !languageChosen ? fromBrowser() : s.language,
      }))
    } catch (error) {
      failed(error)
      update((s) => (s.setup === null ? { ...s, setup: { ...FALLBACK_SETUP, language: s.language } } : s))
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
    /**
     * The "no access" screen: exchanges what the person pasted (the token or the whole link) for a session, like the link
     * does, and loads the app. The token is never kept: it goes in one request. `invalid` is a text that cannot be a token.
     */
    async signIn(pasted: string): Promise<'ok' | 'invalid' | 'rejected' | 'failed'> {
      const token = tokenFromInput(pasted)
      if (token === null) return 'invalid'
      try {
        await api.openSession(token)
      } catch (error) {
        return error instanceof ApiError && error.status === 401 ? 'rejected' : 'failed'
      }
      update((s) => ({ ...s, unauthorized: false, accounts: null, setup: null, loadError: null }))
      await this.start()
      // The session was accepted but the next calls still say no (the browser refused the cookie): not a success.
      return state.unauthorized ? 'failed' : 'ok'
    },
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

    /**
     * Calls `listener` when the daemon says it logged new lines (the event carries no lines: the open view asks for them)
     * and when the stream comes back after a break. Returns the way to stop listening.
     */
    onLog(listener: () => void): () => void {
      logListeners.add(listener)
      return () => logListeners.delete(listener)
    },

    /** Asks for the language and the accounts and starts listening. */
    async start(): Promise<void> {
      try {
        const info = await api.info()
        update((s) => ({ ...s, language: pickLanguage(info.language) }))
      } catch (error) {
        failed(error)
      }
      await Promise.all([refreshAccounts(), loadSetup()])
      // Only one stream at a time: a second start (a fast repeated sign-in) replaces the first instead of doubling it.
      stream?.close()
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
            if (name === 'log') for (const listener of [...logListeners]) listener()
          },
          open: (again) => {
            update((s) => ({ ...s, connection: 'online' }))
            // Whatever changed between the first fetch and the stream, or while the stream was down, is asked for again.
            void refreshAccounts()
            if (!again) return
            for (const listener of [...logListeners]) listener()
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
    loadSetup,
    restoreLink,

    /** The page's language changes at once (the wizard's first step shows it live); the daemon is told when the step is saved. */
    setLanguage(language: Language): void {
      languageChosen = true
      update((s) => (s.language === language ? s : { ...s, language }))
    },

    /** Saves a step of the wizard (or goes back) and keeps the answer. On a refusal the error is handed back to be shown. */
    async saveSetup(body: Record<string, unknown>): Promise<SetupResult> {
      try {
        const setup = await api.saveSetup(body)
        update((s) => ({ ...s, setup }))
        // A step may have created the account or changed what a card shows.
        if (body.from === 'you' || body.from === 'provider') await refreshAccounts()
        return { ok: true }
      } catch (error) {
        failed(error)
        return { ok: false, error: error instanceof ApiError ? error : null }
      }
    },

    async skipSetup(): Promise<SetupResult> {
      try {
        const setup = await api.skipSetup()
        update((s) => ({ ...s, setup }))
        return { ok: true }
      } catch (error) {
        failed(error)
        return { ok: false, error: error instanceof ApiError ? error : null }
      }
    },
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
