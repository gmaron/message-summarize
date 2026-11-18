import type { SummarizeRequest, SummarizeResult, Summarizer } from '../../../application/ports/summarizer.js'
import { err, ok } from '../../../domain/result.js'
import { STRICT_SUMMARY_JSON_SCHEMA } from '../summary-schema.js'
import { type ApiCommonOptions, runApiCall } from './api-call.js'
import { parseRetryInfoDelay } from './rate-limit-retry.js'

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'

export interface GeminiOptions extends ApiCommonOptions {
  /** Default https://generativelanguage.googleapis.com. It exists for tests; the product contacts that host only (RNF-01). */
  readonly baseUrl?: string
  /** Default `v1beta`. */
  readonly apiVersion?: string
}

/**
 * Summarizes with the Gemini `generateContent` API (RF-40). The answer is forced to JSON with
 * `generationConfig.responseMimeType` and `responseJsonSchema` (the documented JSON Schema field; `responseSchema` is
 * the older OpenAPI-subset one). The key goes in the `x-goog-api-key` header, never in the URL, so it cannot end up in
 * a log or an error message. A rate limit says how long to wait in `RetryInfo` (RF-46).
 */
export class GeminiSummarizer implements Summarizer {
  constructor(private readonly options: GeminiOptions) {}

  summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const baseUrl = (this.options.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, '')
    const version = this.options.apiVersion ?? 'v1beta'
    return runApiCall({
      provider: 'gemini',
      options: this.options,
      keyRequired: true,
      summarizeRequest: request,
      build: (key, prompt) => ({
        url: `${baseUrl}/${version}/models/${encodeURIComponent(this.options.model)}:generateContent`,
        headers: { 'x-goog-api-key': key ?? '' },
        body: {
          systemInstruction: { parts: [{ text: prompt.system }] },
          contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: STRICT_SUMMARY_JSON_SCHEMA },
        },
      }),
      retryDelayFromBody: parseRetryInfoDelay,
      extract: (body) => {
        const { candidates, promptFeedback } = (body ?? {}) as {
          candidates?: { content?: { parts?: { text?: unknown; thought?: unknown }[] }; finishReason?: unknown }[]
          promptFeedback?: { blockReason?: unknown }
        }
        const blocked = promptFeedback?.blockReason
        if (typeof blocked === 'string') return err(`gemini blocked the prompt (${blocked})`)
        const candidate = candidates?.[0]
        // Parts with `thought: true` are the model's reasoning summary, not the answer.
        const text = (candidate?.content?.parts ?? [])
          .filter((part) => part?.thought !== true)
          .map((part) => (typeof part?.text === 'string' ? part.text : ''))
          .join('')
        if (text === '') {
          const finish = typeof candidate?.finishReason === 'string' ? ` (${candidate.finishReason})` : ''
          return err(`gemini returned no text${finish}`)
        }
        return ok(text)
      },
    })
  }
}
