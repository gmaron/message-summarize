import type { Summarizer } from '../../application/ports/summarizer.js'
import { FallbackSummarizer } from './fallback-summarizer.js'
import { LocalOnlyRouter } from './local-only-router.js'

export interface ComposeSummarizerOptions {
  readonly primary: Summarizer
  readonly backup?: Summarizer
  /** The local provider (Ollama). Required for local-only conversations to be summarized at all. */
  readonly local?: Summarizer
  readonly localOnlyPatterns: readonly string[]
}

/**
 * The only supported way to wire providers. The order is fixed: `LocalOnlyRouter` outside, `FallbackSummarizer`
 * inside it, so a local-only conversation can never reach the primary or the backup (RF-43), even when the local call
 * fails. Wiring the classes by hand in another order could leak chats to an external provider.
 */
export function composeSummarizer(options: ComposeSummarizerOptions): Summarizer {
  const external =
    options.backup === undefined ? options.primary : new FallbackSummarizer(options.primary, options.backup)
  return new LocalOnlyRouter(external, options.local, options.localOnlyPatterns)
}
