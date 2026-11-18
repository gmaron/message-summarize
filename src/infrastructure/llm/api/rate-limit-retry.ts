import { err, ok, type Result } from '../../../domain/result.js'

/** RF-46: how much one call may wait for a provider that says "later". It is per call (per conversation). */
export interface RetryBudget {
  /** Retries after the first attempt. 0 turns retrying off. */
  readonly maxRetries: number
  /** The most time spent waiting between attempts, in total. */
  readonly maxTotalWaitMs: number
  /** The deadline of the whole call, attempts and waits together. Default `DEFAULT_MAX_TOTAL_MS`. */
  readonly maxTotalMs?: number
}

export const DEFAULT_MAX_TOTAL_MS = 300_000
export const DEFAULT_RETRY_BUDGET: RetryBudget = {
  maxRetries: 3,
  maxTotalWaitMs: 120_000,
  maxTotalMs: DEFAULT_MAX_TOTAL_MS,
}

/** What one attempt came to. `retry` is for a rate limit, an overloaded server or a network error. */
export type Attempt<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'retry'; readonly reason: string; readonly hintMs?: number | undefined }
  | { readonly kind: 'fail'; readonly reason: string }

/** The outside world of the retry loop. Tests replace it, so no test waits for real. */
export interface RetryClock {
  sleep(ms: number): Promise<void>
  /** In [0, 1). */
  random(): number
  /** Milliseconds, for the total deadline. Default `Date.now`. */
  now?(): number
}

export const systemRetryClock: RetryClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  now: Date.now,
}

const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 30_000

/** Exponential backoff with jitter (between 50% and 100% of the step), used when the provider gives no hint. */
export function backoffMs(retryIndex: number, random: number): number {
  const step = Math.min(BACKOFF_BASE_MS * 2 ** retryIndex, BACKOFF_CAP_MS)
  return Math.round(step * (0.5 + random * 0.5))
}

/**
 * Runs `attempt` until it is done or fails, retrying only what it marks as `retry`. The wait is the provider's hint
 * when there is one, else exponential backoff with jitter. If the next wait does not fit in what is left of the
 * budget, or the retries are used up, the call fails with the last reason: the fallback provider (RF-42) and the
 * "conversations that failed" report take over. Waiting for a hint that would never fit is pointless, so it fails at once.
 * A total deadline (`maxTotalMs`) covers attempts and waits together: each attempt is told how much time is left, so
 * its own timeout never reaches past the deadline, and no wait starts that would end after it.
 */
export async function withRateLimitRetry<T>(
  attempt: (remainingMs: number) => Promise<Attempt<T>>,
  budget: RetryBudget,
  clock: RetryClock = systemRetryClock,
): Promise<Result<T, string>> {
  const now = (): number => clock.now?.() ?? Date.now()
  const deadline = now() + (budget.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS)
  let waited = 0
  for (let retries = 0; ; retries++) {
    const remaining = deadline - now()
    if (remaining <= 0) return err('the total time limit of the call was reached')
    const outcome = await attempt(remaining)
    if (outcome.kind === 'done') return ok(outcome.value)
    if (outcome.kind === 'fail') return err(outcome.reason)
    if (retries >= budget.maxRetries) {
      return err(budget.maxRetries === 0 ? outcome.reason : `${outcome.reason} (gave up after ${retries} retries)`)
    }
    const delay = Math.max(0, outcome.hintMs ?? backoffMs(retries, clock.random()))
    if (waited + delay > budget.maxTotalWaitMs) {
      return err(`${outcome.reason} (the wait of ${Math.ceil(delay / 1000)}s is over the budget)`)
    }
    if (now() + delay >= deadline) {
      return err(`${outcome.reason} (the total time limit of the call was reached)`)
    }
    waited += delay
    await clock.sleep(delay)
  }
}

/** `Retry-After`: a number of seconds, or an HTTP date. Null when it is neither. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined) return null
  const text = value.trim()
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000)
  const date = Date.parse(text)
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs)
}

/**
 * Gemini says how long to wait in the error body: `error.details[]` has an entry of type `google.rpc.RetryInfo`
 * whose `retryDelay` is a duration string such as "37s" or "0.5s". Null when the body has none.
 */
export function parseRetryInfoDelay(bodyText: string): number | null {
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return null
  }
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details
  if (!Array.isArray(details)) return null
  for (const detail of details) {
    const { '@type': type, retryDelay } = (detail ?? {}) as { '@type'?: unknown; retryDelay?: unknown }
    if (typeof type !== 'string' || !type.endsWith('RetryInfo') || typeof retryDelay !== 'string') continue
    const match = /^(\d+(?:\.\d+)?)s$/.exec(retryDelay.trim())
    if (match !== null) return Math.round(Number(match[1]) * 1000)
  }
  return null
}
