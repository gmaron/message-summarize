import type { Answerer, AnswerRequest, AnswerResult } from '../../application/ports/answerer.js'
import type { SummarizeRequest, SummarizeResult, Summarizer } from '../../application/ports/summarizer.js'
import { err } from '../../domain/result.js'
import { excerpt, SUMMARY_JSON_SCHEMA } from './summary-schema.js'

export interface OllamaOptions {
  readonly model: string
  /** Default http://127.0.0.1:11434. It is the only host this adapter contacts (RNF-01). */
  readonly baseUrl?: string
  /** Default 3 minutes. */
  readonly timeoutMs?: number
  /** Context window sent as `options.num_ctx`. Default 16384. */
  readonly numCtx?: number
  /** How long Ollama keeps the model loaded after the call. Default '1m'. */
  readonly keepAlive?: string
  /** One attempt of a free-text answer. Default 10 minutes. */
  readonly answerTimeoutMs?: number
  /** The largest context window an answer may use (the one sent is sized to the text, up to this). Default 65536. */
  readonly answerNumCtx?: number
}

/** What an answer may write, in tokens. */
const ANSWER_NUM_PREDICT = 16_384
/** Room for the template of the chat and the tokens the estimate may miss. */
const CTX_MARGIN = 1_024
/** Characters per token assumed when sizing the window: pessimistic (Spanish and English are nearer 3.5; other scripts, 1-2). */
const CHARS_PER_TOKEN = 2
/** The system prompt and the question that travel with every part. */
const PROMPT_OVERHEAD_CHARS = 10_000

/** The name this adapter reports as the provider of a summary. */
export const OLLAMA_PROVIDER = 'ollama'

/** Summarizes with a local Ollama server (RF-40). The output is forced to the summary schema through `format`. */
export class OllamaSummarizer implements Summarizer, Answerer {
  /** Ollama runs on this machine (the product treats it as the only local provider). */
  readonly local = true
  private readonly endpoint: string
  private readonly timeoutMs: number

  constructor(private readonly options: OllamaOptions) {
    this.endpoint = `${(options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')}/api/chat`
    this.timeoutMs = options.timeoutMs ?? 3 * 60_000
  }

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.options.model,
          stream: false,
          think: false,
          keep_alive: this.options.keepAlive ?? '1m',
          format: SUMMARY_JSON_SCHEMA,
          options: { temperature: 0.2, num_ctx: this.options.numCtx ?? 16384 },
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.transcript },
          ],
        }),
      })
      if (!response.ok) return err(`ollama answered ${response.status}: ${excerpt(await response.text())}`)
      let body: { message?: { content?: unknown } }
      try {
        body = (await response.json()) as { message?: { content?: unknown } }
      } catch {
        return err('ollama returned a body that is not JSON')
      }
      const content = body?.message?.content
      if (typeof content !== 'string') return err('ollama returned no message content')
      try {
        return { ok: true, value: JSON.parse(content), provider: OLLAMA_PROVIDER }
      } catch {
        return err('ollama returned content that is not JSON')
      }
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      if (name === 'TimeoutError') return err(`ollama timed out after ${this.timeoutMs / 1000}s`)
      return err(`could not reach ollama: ${e instanceof Error ? excerpt(e.message) : 'error'}`)
    }
  }

  /** Free text: no `format`, a larger context window and room for a long answer. */
  /** Chat text per call that fits the largest window with room for the answer: Ollama would cut the prompt silently past it. */
  get maxPartChars(): number {
    const room = (this.options.answerNumCtx ?? 65_536) - ANSWER_NUM_PREDICT - CTX_MARGIN
    return Math.max(1_000, room * CHARS_PER_TOKEN - PROMPT_OVERHEAD_CHARS)
  }

  async answer(request: AnswerRequest): Promise<AnswerResult> {
    const timeoutMs = this.options.answerTimeoutMs ?? 10 * 60_000
    // The window is sized to this text; if even the largest does not hold it and the answer, it fails: never a silent cut.
    const maxCtx = this.options.answerNumCtx ?? 65_536
    const estimated = Math.ceil((request.systemPrompt.length + request.input.length) / CHARS_PER_TOKEN)
    const needed = estimated + ANSWER_NUM_PREDICT + CTX_MARGIN
    if (needed > maxCtx) return { ok: false, error: 'ollama: the text does not fit the context window' }
    const numCtx = Math.min(maxCtx, Math.max(8_192, Math.ceil(needed / 1_024) * 1_024))
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: this.options.model,
          stream: false,
          think: false,
          keep_alive: this.options.keepAlive ?? '1m',
          options: { temperature: 0.2, num_ctx: numCtx, num_predict: ANSWER_NUM_PREDICT },
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.input },
          ],
        }),
      })
      if (!response.ok)
        return { ok: false, error: `ollama answered ${response.status}: ${excerpt(await response.text())}` }
      let body: { message?: { content?: unknown }; prompt_eval_count?: unknown }
      try {
        body = (await response.json()) as typeof body
      } catch {
        return { ok: false, error: 'ollama returned a body that is not JSON' }
      }
      // What Ollama really counted: if the prompt and the answer could not both fit, the prompt may have been cut.
      if (typeof body?.prompt_eval_count === 'number' && body.prompt_eval_count + ANSWER_NUM_PREDICT > numCtx) {
        return { ok: false, error: 'ollama: the text did not fit the context window' }
      }
      const content = body?.message?.content
      if (typeof content !== 'string' || content.trim() === '')
        return { ok: false, error: 'ollama returned no message content' }
      return { ok: true, text: content, provider: OLLAMA_PROVIDER }
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      if (name === 'TimeoutError') return { ok: false, error: `ollama timed out after ${timeoutMs / 1000}s` }
      return { ok: false, error: `could not reach ollama: ${e instanceof Error ? excerpt(e.message) : 'error'}` }
    }
  }
}
