/**
 * The models the web offers for Anthropic when its own list cannot be read (no network, a server error).
 *
 * THIS IS ONLY A FALLBACK, and only for Anthropic: its ids are the ones this repository uses and that were checked as
 * current. There is none for OpenAI or Gemini on purpose: their ids and retirements change between snapshots and a stale
 * name would fail later, so when their list cannot be read the page shows the error and "Look again", never a made-up list.
 * Review this when Anthropic retires a model; the list from the provider is always better.
 */
import type { ModelOption } from './model-lists.js'

export const FALLBACK_MODELS = {
  anthropic: [
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  ],
} as const satisfies Record<string, readonly ModelOption[]>
