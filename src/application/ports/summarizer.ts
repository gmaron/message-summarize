export interface SummarizeRequest {
  /** Which conversation it is, so wrappers (local-only routing, fallback, retries) can decide without the use case. */
  readonly conversation: { readonly id: string; readonly name: string; readonly isGroup: boolean }
  /** Already rendered (RF-38). */
  readonly systemPrompt: string
  /** The text of one conversation, already rendered and truncated. Untrusted input. */
  readonly transcript: string
}

/**
 * The answer of a summarizer. `provider` names who produced a successful answer (for example `claude-cli`, `ollama`),
 * so the history can say which provider summarized each conversation (RF-74). Optional: a Summarizer that does not
 * set it is counted as `unknown`. Wrappers (fallback, local-only routing) must pass it through untouched.
 */
export type SummarizeResult =
  | { readonly ok: true; readonly value: unknown; readonly provider?: string }
  | { readonly ok: false; readonly error: string }

/**
 * Summarizes one conversation with an LLM. Retries and fallback between providers (RF-42, RF-48) live in the adapter
 * or in a wrapper around it; a wrapper may validate with `parseSummaryResponse` itself to retry on a schema error.
 * It returns the parsed JSON as is and the use case validates it again, so a schema failure is a failure of that
 * conversation. The error is an internal reason for logs and reports, never shown in the digest.
 */
export interface Summarizer {
  summarize(request: SummarizeRequest): Promise<SummarizeResult>
}
