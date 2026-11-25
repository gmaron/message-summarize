import type { Answerer } from '../../application/ports/answerer.js'
import type { Summarizer } from '../../application/ports/summarizer.js'
import {
  AnthropicSummarizer,
  ClaudeCliSummarizer,
  composeAnswerer,
  composeSummarizer,
  DisabledCliSummarizer,
  GeminiSummarizer,
  GenericCliSummarizer,
  isOpenAiHost,
  OllamaSummarizer,
  OpenAiCompatibleSummarizer,
} from '../../infrastructure/llm/index.js'
import { type KeyProvider, resolveApiKey } from '../../infrastructure/secrets/index.js'
import type { AccountLayout } from '../installation/paths.js'
import type { AppConfig, ProviderKind } from './config.js'

/**
 * Which stored key the `openai` provider uses: the real `openai` key only when the origin of `baseUrl` is exactly
 * https://api.openai.com, and `openai-compatible` for any other server, so a compatible server never receives the
 * OpenAI key (files and environment alike).
 */
export const openAiKeyProvider = (baseUrl: string): KeyProvider =>
  isOpenAiHost(baseUrl) ? 'openai' : 'openai-compatible'

/** Where the API keys of a runtime are looked up besides the environment (see `msum secret`). */
export type SecretFiles = Pick<AccountLayout, 'secretsFile' | 'installationSecretsFile'>

/** Other hosts for the providers that have a fixed one. For tests: the product contacts the real hosts only (RNF-01). */
export interface ProviderBaseUrls {
  readonly anthropic?: string
  readonly gemini?: string
}

/**
 * One provider of the configuration, ready to use. Nothing is contacted here, and API keys are looked up at the time of
 * each call (see `resolveApiKey`), so a key saved with `msum secret set` works in a daemon that is already running.
 * Each adapter names itself as the provider of a successful answer (RF-74).
 */
export function buildProvider(
  kind: ProviderKind,
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  secrets?: SecretFiles,
  baseUrls: ProviderBaseUrls = {},
): Summarizer & Answerer {
  const { provider } = config
  const keyOf = (name: KeyProvider) => (): string | undefined =>
    resolveApiKey(name, {
      env,
      accountFile: secrets?.secretsFile,
      file: secrets?.installationSecretsFile ?? '',
    })?.key
  const retry = {
    maxRetries: provider.retry.maxRetries,
    maxTotalWaitMs: provider.retry.maxWaitMs,
    maxTotalMs: provider.retry.maxTotalMs,
  }
  switch (kind) {
    case 'ollama':
      return new OllamaSummarizer({
        model: provider.ollama.model ?? '',
        baseUrl: provider.ollama.baseUrl,
        timeoutMs: provider.ollama.timeoutMs,
        numCtx: provider.ollama.numCtx,
        keepAlive: provider.ollama.keepAlive,
      })
    case 'openai':
      return new OpenAiCompatibleSummarizer({
        model: provider.openai.model ?? '',
        baseUrl: provider.openai.baseUrl,
        timeoutMs: provider.openai.timeoutMs,
        structuredOutput: provider.openai.structuredOutput,
        apiKey: keyOf(openAiKeyProvider(provider.openai.baseUrl)),
        retry,
      })
    case 'anthropic':
      return new AnthropicSummarizer({
        model: provider.anthropic.model ?? '',
        timeoutMs: provider.anthropic.timeoutMs,
        maxTokens: provider.anthropic.maxTokens,
        ...(provider.anthropic.effort === null ? {} : { effort: provider.anthropic.effort }),
        ...(baseUrls.anthropic === undefined ? {} : { baseUrl: baseUrls.anthropic }),
        apiKey: keyOf('anthropic'),
        retry,
      })
    case 'gemini':
      return new GeminiSummarizer({
        model: provider.gemini.model ?? '',
        timeoutMs: provider.gemini.timeoutMs,
        ...(baseUrls.gemini === undefined ? {} : { baseUrl: baseUrls.gemini }),
        apiKey: keyOf('gemini'),
        retry,
      })
    case 'claude-cli':
      return new ClaudeCliSummarizer({
        command: provider.claudeCli.command,
        model: provider.claudeCli.model,
        timeoutMs: provider.claudeCli.timeoutMs,
        env,
        // RF-49: the CLI is only run once `--help` shows that this version has every flag that turns the tools off.
        verify: true,
      })
    // Shipped disabled (RF-49): see `DISABLED_PRESETS`. Every call fails at once, nothing is run.
    case 'gemini-cli':
    case 'codex-cli':
      return new DisabledCliSummarizer(kind)
    // External too: we cannot know where a generic command sends the chat (RF-43).
    case 'generic-cli':
      return new GenericCliSummarizer({
        command: provider.genericCli.command ?? [],
        acknowledgeRisk: provider.genericCli.acknowledgeRisk,
        timeoutMs: provider.genericCli.timeoutMs,
        env,
      })
  }
}

/**
 * Builds the summarizer of the configuration: the primary provider, the backup (RF-42) and the local one for
 * "local only" conversations (RF-43), wired by `composeSummarizer` so a local-only chat never reaches an external
 * provider. Only Ollama is local: OpenAI, Anthropic, Gemini, the CLIs and a compatible server (even on localhost, which
 * cannot be verified to stay there) are external. Null when no provider was chosen (RF-41: there is no default).
 */
export function buildSummarizer(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  secrets?: SecretFiles,
  /** The local-only patterns in force when each conversation is summarized (default: the ones of `config`). */
  localOnlyPatterns: () => readonly string[] = () => config.localOnlyPatterns,
): Summarizer | null {
  const { provider } = config
  if (provider.primary === null) return null
  const usesOllama = provider.primary === 'ollama' || provider.backup === 'ollama'
  // Also when a model is set and no chat is marked yet: a mark made while a digest runs must find the local provider.
  const local =
    usesOllama || config.localOnlyPatterns.length > 0 || provider.ollama.model !== null
      ? buildProvider('ollama', config, env)
      : undefined
  return composeSummarizer({
    primary: buildProvider(provider.primary, config, env, secrets),
    ...(provider.backup === null ? {} : { backup: buildProvider(provider.backup, config, env, secrets) }),
    ...(local === undefined ? {} : { local }),
    localOnlyPatterns,
  })
}

/**
 * The answerer of the configuration (the "Ask" tab): the primary provider and the backup (RF-42), the same adapters as the
 * summarizer with their free-text mode. There is no per-conversation routing here: the text of a request mixes chats, so
 * the use case itself keeps the "local only" conversations (RF-43) out unless `local` says the text never leaves the
 * machine (every provider of the chain is Ollama). Null when no provider was chosen.
 */
export function buildAnswerer(config: AppConfig, env: NodeJS.ProcessEnv, secrets?: SecretFiles): Answerer | null {
  const { provider } = config
  if (provider.primary === null) return null
  return composeAnswerer({
    primary: buildProvider(provider.primary, config, env, secrets),
    ...(provider.backup === null ? {} : { backup: buildProvider(provider.backup, config, env, secrets) }),
  })
}
