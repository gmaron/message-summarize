import type { FetchFn, HttpInit } from '../../../src/interfaces/web/lib/api.js'
import type { EventSourceLike } from '../../../src/interfaces/web/lib/sse.js'
import type { AccountView } from '../../../src/interfaces/web/lib/types.js'

export const account = (over: Partial<AccountView> = {}): AccountView => ({
  id: 'alpha',
  state: 'connected',
  since: 1,
  blockedReason: null,
  blockedAt: null,
  retryAfter: null,
  fix: null,
  maskedNumber: '+54*******0009',
  lastDigest: null,
  nextRun: null,
  timezone: 'America/Argentina/Buenos_Aires',
  language: 'en',
  configValid: true,
  ...over,
})

export interface Call {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

type Answer = { status?: number; body?: unknown }

/** A fake daemon: answers by "METHOD path" with a status and a body, and records what was asked. */
export function fakeFetch(answers: Record<string, Answer | (() => Answer)>) {
  const calls: Call[] = []
  const fetchFn: FetchFn = async (input: string, init?: HttpInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, path: input, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    const given = answers[`${method} ${input}`]
    const answer: Answer =
      typeof given === 'function' ? given() : (given ?? { status: 404, body: { error: 'notFound' } })
    const status = answer.status ?? 200
    return { status, ok: status >= 200 && status < 300, json: async () => answer.body ?? {} }
  }
  return { fetchFn, calls }
}

export class FakeEventSource implements EventSourceLike {
  static all: FakeEventSource[] = []
  static last(): FakeEventSource {
    return FakeEventSource.all[FakeEventSource.all.length - 1] as FakeEventSource
  }
  readyState = 0
  closed = false
  private listeners = new Map<string, ((event: { data?: string }) => void)[]>()
  constructor() {
    FakeEventSource.all.push(this)
  }
  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close(): void {
    this.closed = true
    this.readyState = 2
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(data === undefined ? {} : { data: JSON.stringify(data) })
    }
  }
  /** A block of the stream whose data is not JSON. */
  emitRaw(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}
