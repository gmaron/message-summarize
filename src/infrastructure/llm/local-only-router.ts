import type { SummarizeRequest, SummarizeResult, Summarizer } from '../../application/ports/summarizer.js'
import { isExcluded } from '../../domain/exclusion.js'
import { err } from '../../domain/result.js'

export const LOCAL_ONLY_UNAVAILABLE = 'localOnlyUnavailable'

/**
 * RF-43: conversations that match the local-only patterns (same matcher as exclusions: case-insensitive substring of
 * "<id> <name>") are summarized by the local summarizer only. If there is none, they fail with
 * `localOnlyUnavailable`. They never reach `external`, not even when the local one fails.
 * Do not wire this by hand: use `composeSummarizer`, which fixes the safe order (this router outside any fallback).
 */
export class LocalOnlyRouter implements Summarizer {
  constructor(
    private readonly external: Summarizer,
    private readonly local: Summarizer | undefined,
    private readonly localOnlyPatterns: readonly string[] | (() => readonly string[]),
  ) {}

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const { id, name } = request.conversation
    const patterns = typeof this.localOnlyPatterns === 'function' ? this.localOnlyPatterns() : this.localOnlyPatterns
    if (!isExcluded(patterns, id, name)) return this.external.summarize(request)
    if (this.local === undefined) return err(LOCAL_ONLY_UNAVAILABLE)
    return this.local.summarize(request)
  }
}
