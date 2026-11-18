import type { SummarizeRequest, SummarizeResult, Summarizer } from '../../application/ports/summarizer.js'
import { err } from '../../domain/result.js'
import { parseSummaryResponse } from '../../domain/summary.js'

/**
 * RF-42: when the primary fails, or answers something that does not pass the summary schema, the same request goes to
 * the fallback. The fallback's answer is returned as is (the use case validates it again).
 * Do not wire this by hand: use `composeSummarizer`. Placing this outside a `LocalOnlyRouter` would send local-only
 * chats to the external fallback.
 */
export class FallbackSummarizer implements Summarizer {
  constructor(
    private readonly primary: Summarizer,
    private readonly fallback: Summarizer,
  ) {}

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const first = await this.primary.summarize(request)
    let reason: string
    if (first.ok) {
      const valid = parseSummaryResponse(first.value)
      if (valid.ok) return first
      reason = `invalid summary: ${valid.error.join(', ')}`
    } else {
      reason = first.error
    }
    const second = await this.fallback.summarize(request)
    return second.ok ? second : err(`${reason}; fallback: ${second.error}`)
  }
}
