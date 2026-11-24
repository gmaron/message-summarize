export interface AnswerRequest {
  /** The instructions of the owner's assistant, already rendered. Trusted text. */
  readonly systemPrompt: string
  /** The request and the chat text it is about. The chat text is written by third parties: untrusted input. */
  readonly input: string
}

/**
 * The answer of an answerer. `provider` names who wrote a successful answer. The error is an internal reason for logs
 * and reports, never quoting the input and never shown as is.
 */
export type AnswerResult =
  | { readonly ok: true; readonly text: string; readonly provider: string }
  | { readonly ok: false; readonly error: string }

/**
 * Answers a free request with free text (the "Ask" tab), unlike the `Summarizer`, which only returns the structured
 * summary of one conversation. Every enabled provider adapter implements it with the same plumbing (consent, caps,
 * redaction, rate-limit retries, and the sandbox of the CLIs, RF-49).
 */
export interface Answerer {
  /**
   * True only when the text never leaves the machine (Ollama): the use case includes the conversations marked "local
   * only" (RF-43) only then. A fallback is local only if both of its providers are.
   */
  readonly local: boolean
  /**
   * The most characters of chat text one call can take without failing or being cut silently (a context window, the size
   * of an argument). Absent: no limit of its own. The use case splits the text into parts of at most this size.
   */
  readonly maxPartChars?: number
  answer(request: AnswerRequest): Promise<AnswerResult>
}
