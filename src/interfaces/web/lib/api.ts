import type { AccountView, LinkSnapshot, PreviewView, SchedulesView, ScheduleView } from './types.js'

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
    const data = (await reply.json().catch(() => ({}))) as { error?: unknown; issue?: unknown }
    if (!reply.ok) {
      if (reply.status === 401) onUnauthorized()
      throw new ApiError(
        reply.status,
        typeof data.error === 'string' ? data.error : 'internal',
        typeof data.issue === 'string' ? data.issue : undefined,
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
    /** Where the image of the current QR is. `version` changes on every `qr` event so the browser asks again. */
    qrUrl: (id: string, version: number) => `${account(id)}/link/qr.svg?v=${version}`,
  }
}

export type Api = ReturnType<typeof createApi>
