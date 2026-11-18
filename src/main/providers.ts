import type { Summarizer } from '../application/ports/summarizer.js'
import { ClaudeCliSummarizer, composeSummarizer, OllamaSummarizer } from '../infrastructure/llm/index.js'
import type { AppConfig, ProviderKind } from './config.js'

/**
 * Builds the summarizer of the configuration: the primary provider, the backup (RF-42) and the local one for
 * "local only" conversations (RF-43), wired by `composeSummarizer` so a local-only chat never reaches an external
 * provider. Null when no provider was chosen (RF-41: there is no default). Nothing is contacted here.
 */
export function buildSummarizer(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  /** The local-only patterns in force when each conversation is summarized (default: the ones of `config`). */
  localOnlyPatterns: () => readonly string[] = () => config.localOnlyPatterns,
): Summarizer | null {
  const { provider } = config
  if (provider.primary === null) return null

  const ollama = (): Summarizer =>
    new OllamaSummarizer({
      model: provider.ollama.model ?? '',
      baseUrl: provider.ollama.baseUrl,
      timeoutMs: provider.ollama.timeoutMs,
      numCtx: provider.ollama.numCtx,
      keepAlive: provider.ollama.keepAlive,
    })
  const make = (kind: ProviderKind): Summarizer =>
    kind === 'ollama'
      ? ollama()
      : new ClaudeCliSummarizer({
          command: provider.claudeCli.command,
          model: provider.claudeCli.model,
          timeoutMs: provider.claudeCli.timeoutMs,
          env,
        })

  const usesOllama = provider.primary === 'ollama' || provider.backup === 'ollama'
  // Also when a model is set and no chat is marked yet: a mark made while a digest runs must find the local provider.
  const local =
    usesOllama || config.localOnlyPatterns.length > 0 || provider.ollama.model !== null ? ollama() : undefined
  return composeSummarizer({
    primary: make(provider.primary),
    ...(provider.backup === null ? {} : { backup: make(provider.backup) }),
    ...(local === undefined ? {} : { local }),
    localOnlyPatterns,
  })
}
