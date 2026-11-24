import type { Answerer, AnswerRequest, AnswerResult } from '../../../application/ports/answerer.js'
import type { SummarizeRequest, SummarizeResult, Summarizer } from '../../../application/ports/summarizer.js'
import { err, ok } from '../../../domain/result.js'
import { STRICT_SUMMARY_JSON_SCHEMA } from '../summary-schema.js'
import { type ApiCall, type ApiCommonOptions, runApiAnswer, runApiCall, withSchemaInPrompt } from './api-call.js'

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

/**
 * How the answer is forced into the summary schema. `json_schema` (strict structured outputs) is what OpenAI offers;
 * servers that are only compatible may lack it: `json_object` asks for any JSON object and puts the schema in the
 * prompt, `prompt` only puts the schema in the prompt. The answer is validated in every mode.
 */
export type StructuredOutputMode = 'json_schema' | 'json_object' | 'prompt'

export interface OpenAiCompatibleOptions extends ApiCommonOptions {
  /** Default https://api.openai.com/v1. Any server with the Chat Completions API works (LM Studio, OpenRouter...). */
  readonly baseUrl?: string
  /** Default `json_schema`. */
  readonly structuredOutput?: StructuredOutputMode
}

/**
 * True only for the OpenAI API itself: the origin is exactly https://api.openai.com. There a key is required, and the
 * `openai` key is used. Any other server (even http://api.openai.com) may need none and gets the `openai-compatible` key.
 */
export function isOpenAiHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).origin === 'https://api.openai.com'
  } catch {
    return false
  }
}

/**
 * Summarizes with the Chat Completions API of OpenAI or of a compatible server (RF-40). The only host contacted is the
 * one in `baseUrl` (RNF-01); the key goes in the Authorization header, and only when there is one.
 */
export class OpenAiCompatibleSummarizer implements Summarizer, Answerer {
  readonly local = false
  private readonly baseUrl: string

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.baseUrl = (options.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '')
  }

  summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    return runApiCall(this.call(request, false))
  }

  /** Free text: plain Chat Completions, with no response format and no schema in the prompt. */
  answer(request: AnswerRequest): Promise<AnswerResult> {
    return runApiAnswer(this.call({ systemPrompt: request.systemPrompt, transcript: request.input }, true))
  }

  private call(request: Pick<SummarizeRequest, 'systemPrompt' | 'transcript'>, free: boolean): ApiCall {
    const mode = this.options.structuredOutput ?? 'json_schema'
    return {
      provider: 'openai',
      reportedAs: isOpenAiHost(this.baseUrl) ? 'openai' : 'openai-compatible',
      options: this.options,
      keyRequired: isOpenAiHost(this.baseUrl),
      summarizeRequest: request,
      free,
      build: (key, prompt) => ({
        url: `${this.baseUrl}/chat/completions`,
        headers: key === undefined ? ({} as Record<string, string>) : { authorization: `Bearer ${key}` },
        body: {
          model: this.options.model,
          messages: [
            {
              role: 'system',
              content: free || mode === 'json_schema' ? prompt.system : withSchemaInPrompt(prompt.system),
            },
            { role: 'user', content: prompt.user },
          ],
          ...(free
            ? {}
            : mode === 'json_schema'
              ? {
                  response_format: {
                    type: 'json_schema',
                    json_schema: { name: 'chat_summary', strict: true, schema: STRICT_SUMMARY_JSON_SCHEMA },
                  },
                }
              : mode === 'json_object'
                ? { response_format: { type: 'json_object' } }
                : {}),
        },
      }),
      extract: (body) => {
        const message = (body as { choices?: { message?: { content?: unknown; refusal?: unknown } }[] } | null)
          ?.choices?.[0]?.message
        if (typeof message?.refusal === 'string' && message.refusal !== '') return err('openai refused to answer')
        if (typeof message?.content !== 'string') return err('openai returned no message content')
        return ok(message.content)
      },
    }
  }
}
