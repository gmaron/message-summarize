import type {
  AccountView,
  ConversationsView,
  HistoryDetail,
  HistoryView,
  LinkSnapshot,
  LogLevel,
  LogsPage,
  MarksResult,
  PreviewView,
  PromptView,
  SchedulesView,
  ScheduleView,
  SettingsIssue,
  SettingsView,
} from './types.js'

/** What the page needs of a response: the browser's `fetch` gives more. */
export interface HttpResponse {
  readonly status: number
  readonly ok: boolean
  json(): Promise<unknown>
}

export interface HttpInit {
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
}

export type FetchFn = (input: string, init?: HttpInit) => Promise<HttpResponse>

/** An answer of the API that is not a success: the status and the codes (`error`, and `issue` for a schedule). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly issue?: string,
    /** For a 422 `invalidConfig`: what is wrong with each option. */
    readonly issues?: readonly SettingsIssue[],
    /** For a 409 `confirmRequired`: how many stored messages the exclusion would delete. */
    readonly messages?: number,
    /** For a 422 `unknownVariable`: the placeholders that are not variables. */
    readonly variables?: readonly string[],
    /** For a 422 `promptTooLong`: the limit. */
    readonly maxLength?: number,
  ) {
    super(code)
    this.name = 'ApiError'
  }
}

export interface ScheduleInput {
  readonly days: readonly number[]
  readonly time: string
}

const enc = encodeURIComponent

/**
 * The calls of the page to the daemon. The cookie of the session travels by itself (same origin). Every 401 calls
 * `onUnauthorized`, which is how the page learns that it must be opened again with `msum open`.
 */
export function createApi(fetchFn: FetchFn, onUnauthorized: () => void = () => {}) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const reply = await fetchFn(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    if (reply.status === 204) return undefined as T
    const data = (await reply.json().catch(() => ({}))) as {
      error?: unknown
      issue?: unknown
      issues?: unknown
      messages?: unknown
      variables?: unknown
      maxLength?: unknown
    }
    if (!reply.ok) {
      if (reply.status === 401) onUnauthorized()
      throw new ApiError(
        reply.status,
        typeof data.error === 'string' ? data.error : 'internal',
        typeof data.issue === 'string' ? data.issue : undefined,
        Array.isArray(data.issues) ? (data.issues as SettingsIssue[]) : undefined,
        typeof data.messages === 'number' ? data.messages : undefined,
        Array.isArray(data.variables) ? data.variables.filter((v): v is string => typeof v === 'string') : undefined,
        typeof data.maxLength === 'number' ? data.maxLength : undefined,
      )
    }
    return data as T
  }
  const account = (id: string) => `/api/accounts/${enc(id)}`
  return {
    info: () => request<{ language?: unknown }>('GET', '/api/info'),
    accounts: async () => (await request<{ accounts: AccountView[] }>('GET', '/api/accounts')).accounts,
    createAccount: (id: string) => request<{ id: string }>('POST', '/api/accounts', { id }),
    startLink: (id: string) => request<{ state: string }>('POST', `${account(id)}/link`),
    linkSnapshot: (id: string) => request<LinkSnapshot>('GET', `${account(id)}/link`),
    cancelLink: (id: string) => request<{ ok: boolean }>('DELETE', `${account(id)}/link`),
    retry: (id: string) => request<{ ok: boolean }>('POST', `${account(id)}/retry`),
    digestNow: (id: string) => request<{ state: 'started' | 'deferred' }>('POST', `${account(id)}/digest`),
    startPreview: (id: string) => request<{ state: string }>('POST', `${account(id)}/preview`),
    preview: (id: string) => request<PreviewView>('GET', `${account(id)}/preview`),
    schedules: (id: string) => request<SchedulesView>('GET', `${account(id)}/schedules`),
    addSchedule: (id: string, input: ScheduleInput) =>
      request<ScheduleView>('POST', `${account(id)}/schedules`, { days: input.days, time: input.time }),
    updateSchedule: (id: string, scheduleId: number, input: ScheduleInput) =>
      request<ScheduleView>('PUT', `${account(id)}/schedules/${scheduleId}`, { days: input.days, time: input.time }),
    deleteSchedule: (id: string, scheduleId: number) =>
      request<undefined>('DELETE', `${account(id)}/schedules/${scheduleId}`),
    settings: (id: string) => request<SettingsView>('GET', `${account(id)}/settings`),
    /** `patch` has only the options to change, nested as in config.json; `null` removes the account's own value. */
    saveSettings: (id: string, patch: Record<string, unknown>) =>
      request<SettingsView>('PUT', `${account(id)}/settings`, patch),
    prompt: (id: string) => request<PromptView>('GET', `${account(id)}/prompt`),
    savePrompt: (id: string, text: string) => request<PromptView>('PUT', `${account(id)}/prompt`, { text }),
    /** Back to the original: the account's own prompt goes away. */
    restorePrompt: (id: string) => request<PromptView>('DELETE', `${account(id)}/prompt`),
    conversations: (id: string, query: { q?: string; limit?: number; offset?: number }) => {
      const params = new URLSearchParams()
      if (query.q !== undefined && query.q.trim() !== '') params.set('q', query.q)
      if (query.limit !== undefined) params.set('limit', String(query.limit))
      if (query.offset !== undefined) params.set('offset', String(query.offset))
      const suffix = params.size === 0 ? '' : `?${params}`
      return request<ConversationsView>('GET', `${account(id)}/conversations${suffix}`)
    },
    setMarks: (
      id: string,
      conversationId: string,
      marks: { excluded?: boolean; localOnly?: boolean; confirmDelete?: boolean },
    ) => request<MarksResult>('PUT', `${account(id)}/conversations/${enc(conversationId)}/marks`, marks),
    history: (id: string, query: { limit?: number; offset?: number }) => {
      const params = new URLSearchParams()
      if (query.limit !== undefined) params.set('limit', String(query.limit))
      if (query.offset !== undefined) params.set('offset', String(query.offset))
      const suffix = params.size === 0 ? '' : `?${params}`
      return request<HistoryView>('GET', `${account(id)}/history${suffix}`)
    },
    /** `account`: an id, or `-` for the lines of the installation itself. Newest first. */
    logs: async (query: { level?: LogLevel; account?: string; limit?: number; before?: number }) => {
      const params = new URLSearchParams()
      if (query.level !== undefined) params.set('level', query.level)
      if (query.account !== undefined && query.account !== '') params.set('account', query.account)
      if (query.limit !== undefined) params.set('limit', String(query.limit))
      if (query.before !== undefined) params.set('before', String(query.before))
      const suffix = params.size === 0 ? '' : `?${params}`
      return request<LogsPage>('GET', `/api/logs${suffix}`)
    },
    historyRun: (id: string, runId: number) => request<HistoryDetail>('GET', `${account(id)}/history/${runId}`),
    /** Where the image of the current QR is. `version` changes on every `qr` event so the browser asks again. */
    qrUrl: (id: string, version: number) => `${account(id)}/link/qr.svg?v=${version}`,
  }
}

export type Api = ReturnType<typeof createApi>
