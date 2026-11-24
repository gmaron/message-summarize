import type { Answerer, AnswerRequest, AnswerResult } from '../../application/ports/answerer.js'

/**
 * The provider fallback of an answer (RF-42): when the primary fails, the same request goes to the backup. It is local
 * only when both are, so a use case that keeps "local only" conversations (RF-43) out of external text can rely on it.
 */
export class FallbackAnswerer implements Answerer {
  readonly local: boolean
  readonly maxPartChars?: number

  constructor(
    private readonly primary: Answerer,
    private readonly backup: Answerer,
  ) {
    this.local = primary.local && backup.local
    // The same text goes to either one, so a part must fit the smaller of the two.
    const limits = [primary.maxPartChars, backup.maxPartChars].filter((n): n is number => n !== undefined)
    if (limits.length > 0) this.maxPartChars = Math.min(...limits)
  }

  async answer(request: AnswerRequest): Promise<AnswerResult> {
    const first = await this.primary.answer(request)
    if (first.ok) return first
    const second = await this.backup.answer(request)
    return second.ok ? second : { ok: false, error: `${first.error}; fallback: ${second.error}` }
  }
}

/** Primary, then backup when there is one. */
export function composeAnswerer(options: { readonly primary: Answerer; readonly backup?: Answerer }): Answerer {
  return options.backup === undefined ? options.primary : new FallbackAnswerer(options.primary, options.backup)
}
