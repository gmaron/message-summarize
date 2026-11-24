import type { AnswerResult } from '../../../application/ports/answerer.js'
import type { SummarizeRequest, SummarizeResult } from '../../../application/ports/summarizer.js'
import { err, type Result } from '../../../domain/result.js'
import { parseSummaryResponse } from '../../../domain/summary.js'
import { excerpt, SUMMARY_JSON_SCHEMA_TEXT } from '../summary-schema.js'
import {
  type Attempt,
  DEFAULT_MAX_TOTAL_MS,
  DEFAULT_RETRY_BUDGET,
  parseRetryAfter,
  type RetryBudget,
  type RetryClock,
  systemRetryClock,
  withRateLimitRetry,
} from './rate-limit-retry.js'
import { redactSecrets } from './redact.js'

/** What every API adapter accepts besides its own options. */
export interface ApiCommonOptions {
  /** There is no default model for any API provider: model names change, a stale default would fail later. */
  readonly model: string
  /** One attempt. Default 3 minutes. */
  readonly timeoutMs?: number
  /**
   * The API key, or a function that finds it at the time of each call (so `msum secret set` takes effect in a running
   * daemon). It is never part of a URL, a log line or an error message (RNF-04).
   */
  readonly apiKey?: string | (() => string | undefined)
  /** RF-46. Default: 3 retries and 120 s of waiting in total, per call. */
  readonly retry?: RetryBudget
  /** Replaces the real timers and randomness of the retries. For tests. */
  readonly retryClock?: RetryClock
  /** One attempt of a free-text answer (the "Ask" tab), which reads far more text and writes far more than a summary. Default 10 minutes. */
  readonly answerTimeoutMs?: number
}

export const DEFAULT_API_TIMEOUT_MS = 3 * 60_000
export const DEFAULT_ANSWER_TIMEOUT_MS = 10 * 60_000
/** The most an answer may write, in tokens, where a provider asks for a limit. A summary needs a tiny fraction of it. */
export const ANSWER_MAX_TOKENS = 16_000

/** What an adapter asks `runApiCall` to send. */
export interface BuiltRequest {
  readonly url: string
  /** Includes the header that carries the key. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

export interface ApiCall {
  /** Names the provider in error reasons. */
  readonly provider: string
  /**
   * The name a successful answer reports as its provider (RF-74: the history says who summarized). Default: `provider`.
   * `openai-compatible` for a server that is not OpenAI itself.
   */
  readonly reportedAs?: string
  readonly options: ApiCommonOptions
  /** A call with no key fails before any request is made (OpenAI-compatible servers may not need one). */
  readonly keyRequired: boolean
  readonly summarizeRequest: PromptSource
  /**
   * A free-text answer: no schema is forced or validated, the timeout and the total deadline are the longer ones of an
   * answer, and the adapter builds a request that asks for plain text.
   */
  readonly free?: boolean
  /** Builds the request. `key` is undefined only when the key is not required and there is none. */
  build(key: string | undefined, prompt: PromptParts): BuiltRequest
  /** The text of the answer inside the provider's JSON body. */
  extract(body: unknown): Result<string, string>
  /** A wait the provider states in an error body (Gemini's RetryInfo). */
  retryDelayFromBody?(text: string): number | null
}

/**
 * The text that goes to the model, built the same way for every API provider: the rendered system prompt and the
 * transcript, with lone surrogates replaced (the truncation of a long chat can split a pair, and providers reject
 * text that is not well formed).
 */
export interface PromptParts {
  readonly system: string
  readonly user: string
}

/** What the prompt parts are made of: a summary request, or an answer request with `input` as `transcript`. */
export type PromptSource = Pick<SummarizeRequest, 'systemPrompt' | 'transcript'>

export function promptParts(request: PromptSource): PromptParts {
  return { system: wellFormed(request.systemPrompt), user: wellFormed(request.transcript) }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Replaces each lone surrogate with U+FFFD (what `String.prototype.toWellFormed` does). */
export const wellFormed = (text: string): string => text.replace(LONE_SURROGATE, '�')

/** For providers or modes that cannot force a schema: the schema goes into the prompt. */
export function withSchemaInPrompt(system: string): string {
  return `${system}\n\nAnswer with only a JSON object, with no other text, that matches this JSON schema: ${SUMMARY_JSON_SCHEMA_TEXT}`
}

const RETRYABLE_STATUS = new Set([429, 503, 529])
/** Words of a 429 that means "out of credit or over a spend limit", not "too many requests right now". */
export const OUT_OF_CREDIT = /insufficient_quota|no credits|credit balance|billing|spend(ing)? limit/i

/** The most of an answer (success or error) that is read: a summary is a few KB, so anything near this is not one. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const RESPONSE_TOO_LARGE = 'response-too-large'

/**
 * Reads a body as text, counting bytes as they arrive. Past `cap` the stream is cancelled and the result is null, so at
 * most `cap` plus one chunk is ever held, however long the server goes on.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  cap: number = MAX_RESPONSE_BYTES,
): Promise<string | null> {
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

function resolveKey(apiKey: ApiCommonOptions['apiKey']): string | undefined {
  const key = typeof apiKey === 'function' ? apiKey() : apiKey
  return key === undefined || key === '' ? undefined : key
}

/** The message a provider put in its error body, or the start of the body. Redacted by the caller. */
function errorText(text: string): string {
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } } | null)?.error?.message
    if (typeof message === 'string') return excerpt(message)
  } catch {
    // not JSON: the start of the text
  }
  return excerpt(text)
}

/** Models sometimes wrap the JSON in a Markdown code fence when they are only asked for it in the prompt. */
function unfence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim())
  return match?.[1] ?? text
}

/**
 * One summarization over an HTTP API: finds the key, sends the request, retries rate limits and network errors within
 * the budget (RF-46), takes the text out of the answer, parses it and validates it against the summary schema (RF-30:
 * an invalid answer is a failed call, so the fallback of RF-42 applies). Every error reason has the key and anything
 * shaped like one removed (RNF-04), and never quotes the transcript.
 */
export async function runApiCall(call: ApiCall): Promise<SummarizeResult> {
  const text = await runApiText(call)
  if (!text.ok) return text
  const fail = (reason: string): SummarizeResult => err(redactSecrets(reason, [resolveKey(call.options.apiKey)]))
  let parsed: unknown
  try {
    parsed = JSON.parse(unfence(text.value))
  } catch {
    return fail(`${call.provider} returned content that is not JSON`)
  }
  const valid = parseSummaryResponse(parsed)
  if (!valid.ok) return fail(`${call.provider} returned an invalid summary: ${valid.error.join(', ')}`)
  return { ok: true, value: parsed, provider: call.reportedAs ?? call.provider }
}

/** One free-text answer over an HTTP API: the same key, retries, caps and redaction as a summary, without a schema. */
export async function runApiAnswer(call: ApiCall): Promise<AnswerResult> {
  const text = await runApiText({ ...call, free: true })
  if (!text.ok) return text
  if (text.value.trim() === '') return { ok: false, error: `${call.provider} returned an empty answer` }
  return { ok: true, text: text.value, provider: call.reportedAs ?? call.provider }
}

/** The text a provider answered, after the key, the request, the retries and the caps; not yet interpreted. */
async function runApiText(call: ApiCall): Promise<Result<string, string>> {
  const key = resolveKey(call.options.apiKey)
  const secrets = [key]
  const fail = (reason: string): Result<string, string> => err(redactSecrets(reason, secrets))
  if (key === undefined && call.keyRequired) {
    return fail(`no API key for ${call.provider}: set it with "msum secret set ${call.provider}"`)
  }
  const timeoutMs =
    call.free === true
      ? (call.options.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS)
      : (call.options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS)
  const retryBudget = ((): RetryBudget => {
    const budget = call.options.retry ?? DEFAULT_RETRY_BUDGET
    // An answer may take several attempts' worth of time: the deadline of the call must not cut the first attempt short.
    return call.free === true
      ? { ...budget, maxTotalMs: Math.max(budget.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS, timeoutMs * 2) }
      : budget
  })()
  const clock = call.options.retryClock ?? systemRetryClock

  try {
    const request = call.build(key, promptParts(call.summarizeRequest))
    const attempt = async (remainingMs: number): Promise<Attempt<string>> => {
      // The attempt never outlives the total deadline of the call.
      const limitMs = Math.min(timeoutMs, remainingMs)
      try {
        const response = await fetch(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...request.headers },
          // These APIs never redirect. Following one would resend the transcript and the key to a host nobody declared (RNF-01).
          redirect: 'error',
          signal: AbortSignal.timeout(limitMs),
          body: JSON.stringify(request.body),
        })
        const text = await readBodyCapped(response.body)
        if (text === null) return { kind: 'fail', reason: `${call.provider}: ${RESPONSE_TOO_LARGE}` }
        if (!response.ok) {
          const reason = `${call.provider} answered ${response.status}: ${errorText(text)}`
          if (!RETRYABLE_STATUS.has(response.status)) return { kind: 'fail', reason }
          // A 429 for an account with no credit (OpenAI `insufficient_quota`, a billing or spend limit) is not a rate
          // limit: waiting does not fix it, so it is not retried.
          if (response.status === 429 && OUT_OF_CREDIT.test(text)) return { kind: 'fail', reason }
          const hintMs = retryAfterMs(response.headers) ?? call.retryDelayFromBody?.(text) ?? undefined
          return { kind: 'retry', reason, hintMs }
        }
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          return { kind: 'fail', reason: `${call.provider} returned a body that is not JSON` }
        }
        const extracted = call.extract(body)
        return extracted.ok ? { kind: 'done', value: extracted.value } : { kind: 'fail', reason: extracted.error }
      } catch (e) {
        if (e instanceof Error && e.name === 'TimeoutError') {
          return limitMs < timeoutMs
            ? { kind: 'fail', reason: `${call.provider}: the total time limit of the call was reached` }
            : { kind: 'fail', reason: `${call.provider} timed out after ${timeoutMs / 1000}s` }
        }
        if (/redirect/i.test(`${(e as { cause?: { message?: unknown } } | null)?.cause?.message ?? ''}`)) {
          return { kind: 'fail', reason: `${call.provider} answered with a redirect, which is not followed` }
        }
        // The network failed (DNS, refused, reset): worth another try within the budget.
        return {
          kind: 'retry',
          reason: `could not reach ${call.provider}: ${e instanceof Error ? excerpt(e.message) : 'error'}`,
        }
      }
    }
    const result = await withRateLimitRetry(attempt, retryBudget, clock)
    return result.ok ? result : fail(result.error)
  } catch (e) {
    // Nothing here should throw; if it does, the reason still goes through the redaction.
    return fail(`${call.provider} call failed: ${e instanceof Error ? excerpt(e.message) : 'error'}`)
  }
}

function retryAfterMs(headers: Headers): number | null {
  const millis = headers.get('retry-after-ms')
  if (millis !== null && /^\d+(\.\d+)?$/.test(millis.trim())) return Math.round(Number(millis))
  return parseRetryAfter(headers.get('retry-after'), Date.now())
}
