import type { SummarizeRequest, Summarizer } from '../../application/ports/summarizer.js'
import { err, ok, type Result } from '../../domain/result.js'
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
}

/** Summarizes with a local Ollama server (RF-40). The output is forced to the summary schema through `format`. */
export class OllamaSummarizer implements Summarizer {
  private readonly endpoint: string
  private readonly timeoutMs: number

  constructor(private readonly options: OllamaOptions) {
    this.endpoint = `${(options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')}/api/chat`
    this.timeoutMs = options.timeoutMs ?? 3 * 60_000
  }

  async summarize(request: SummarizeRequest): Promise<Result<unknown, string>> {
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
        return ok(JSON.parse(content))
      } catch {
        return err('ollama returned content that is not JSON')
      }
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      if (name === 'TimeoutError') return err(`ollama timed out after ${this.timeoutMs / 1000}s`)
      return err(`could not reach ollama: ${e instanceof Error ? excerpt(e.message) : 'error'}`)
    }
  }
}
