import type { SummarizeRequest, SummarizeResult, Summarizer } from '../../../application/ports/summarizer.js'
import { err, ok } from '../../../domain/result.js'
import { STRICT_SUMMARY_JSON_SCHEMA } from '../summary-schema.js'
import { type ApiCommonOptions, runApiCall } from './api-call.js'

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
/** The `anthropic-version` of the documented structured-outputs request. */
export const ANTHROPIC_VERSION = '2026-10-21'
/**
 * 16000, the recommendation for non-streaming requests. Current models think by default (on some, thinking cannot be
 * turned off) and thinking tokens count against `max_tokens`: a small limit can end in `stop_reason: max_tokens` and a
 * failed conversation even though the summary itself is short.
 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 16_000

export const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number]

export interface AnthropicOptions extends ApiCommonOptions {
  /** Default 16000 (see `DEFAULT_ANTHROPIC_MAX_TOKENS`). */
  readonly maxTokens?: number
  /** Sent as `output_config.effort` when set. Unset: the model default applies. */
  readonly effort?: AnthropicEffort
  /** Default https://api.anthropic.com. It exists for tests; the product contacts that host only (RNF-01). */
  readonly baseUrl?: string
}

/**
 * Summarizes with the Anthropic Messages API (RF-40). The schema is forced with `output_config.format` (JSON outputs):
 * forcing a single tool through `tool_choice` is refused by the current models, so it is not used. The JSON is in the
 * text block of the answer. The key goes in the `x-api-key` header.
 */
export class AnthropicSummarizer implements Summarizer {
  constructor(private readonly options: AnthropicOptions) {}

  summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const baseUrl = (this.options.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '')
    return runApiCall({
      provider: 'anthropic',
      options: this.options,
      keyRequired: true,
      summarizeRequest: request,
      build: (key, prompt) => ({
        url: `${baseUrl}/v1/messages`,
        headers: { 'x-api-key': key ?? '', 'anthropic-version': ANTHROPIC_VERSION },
        body: {
          model: this.options.model,
          max_tokens: this.options.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
          output_config: {
            format: { type: 'json_schema', schema: STRICT_SUMMARY_JSON_SCHEMA },
            ...(this.options.effort === undefined ? {} : { effort: this.options.effort }),
          },
        },
      }),
      extract: (body) => {
        const { content, stop_reason: stopReason } = (body ?? {}) as {
          content?: { type?: unknown; text?: unknown }[]
          stop_reason?: unknown
        }
        if (stopReason === 'refusal') return err('anthropic refused to answer')
        if (stopReason === 'max_tokens') return err('anthropic cut the answer at max_tokens')
        const block = Array.isArray(content) ? content.find((b) => b?.type === 'text') : undefined
        if (typeof block?.text !== 'string') return err('anthropic returned no text content')
        return ok(block.text)
      },
    })
  }
}
