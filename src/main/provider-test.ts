import { parseSummaryResponse } from '../domain/summary.js'
import type { ProviderTestErrorCode } from '../infrastructure/i18n/index.js'
import type { AppConfig, ProviderKind } from './config.js'
import { buildSummarizer, type SecretFiles } from './providers.js'

/** Why a test of a provider failed: codes, never the text the provider answered with (it could echo what was sent). */
export type ProviderTestError = ProviderTestErrorCode

export type ProviderTestResult =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly error: ProviderTestError }

/** The most a test may take (RF-41), by provider. The test never waits for the (longer) timeout of the configuration. */
export const TEST_TIMEOUT_MS: Readonly<Record<ProviderKind, number>> = {
  'claude-cli': 90_000,
  ollama: 60_000,
  openai: 60_000,
  anthropic: 60_000,
  gemini: 60_000,
  'generic-cli': 90_000,
  // Shipped disabled: they fail at once and run nothing.
  'gemini-cli': 5_000,
  'codex-cli': 5_000,
}

/**
 * What the test summarizes: a made-up chat, fixed in the program. No name, number or text of the user goes into the
 * test, only this (RF-41, RNF-02).
 */
export const TEST_CONVERSATION = { id: 'setup-test', name: 'Test chat', isGroup: false } as const
export const TEST_SYSTEM_PROMPT =
  'You summarize one chat for its owner. Answer only with the JSON object that matches the schema: ' +
  'resumen (a short summary), pendientes (list of pending tasks), necesita_respuesta (true or false), ' +
  'prioridad (alta, media or baja).'
export const TEST_TRANSCRIPT = [
  'Chat con: Test chat',
  '',
  'Test Person A: Hello! This is a made-up message to test the connection.',
  'Test Person B: Hi, nothing to do here. Just checking that everything works.',
].join('\n')

/**
 * The adapters report errors as text (the `Summarizer` port has no error codes). This reads the few fixed phrases they use
 * and nothing else of the text: an unknown reason is `failed`.
 */
export function classifyProviderError(reason: string): ProviderTestError {
  // `${label} was not found`: the CLI is checked with `--help` before it runs (RF-49), so a missing program says it so.
  if (/^could not run .*: (ENOENT|EACCES|ENOTDIR|EPERM)\b/.test(reason) || /^\S+ was not found$/.test(reason)) {
    return 'notFound'
  }
  if (/timed out after/.test(reason)) return 'timeout'
  if (/^could not reach ollama/.test(reason)) return 'unreachable'
  if (
    /invalid summary|returned no structured output|not JSON|returned no message content|exited with code 0\b/.test(
      reason,
    )
  ) {
    return 'invalidSummary'
  }
  return 'failed'
}

/**
 * The real call of RF-41: the summarizer is built exactly as the daemon builds it (`buildSummarizer`: same adapters,
 * same flags without tools in an empty directory, RF-49), over the configuration given, and summarizes the made-up chat.
 * `config` must already have the provider to test as the primary one.
 */
export async function testProvider(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  now: () => number = Date.now,
  /** Where the stored API keys are looked up (see `msum secret`), for the providers that need one. */
  secrets?: SecretFiles,
): Promise<ProviderTestResult> {
  // No backup, whatever the installation says: a backup would run without its consent and could make a failed test of this
  // provider report ok. Done here so no caller can forget it.
  const summarizer = buildSummarizer(
    { ...config, localOnlyPatterns: [], provider: { ...config.provider, backup: null } },
    env,
    secrets,
    () => [],
  )
  if (summarizer === null) return { ok: false, error: 'failed' }
  const started = now()
  let result: Awaited<ReturnType<typeof summarizer.summarize>>
  try {
    result = await summarizer.summarize({
      conversation: TEST_CONVERSATION,
      systemPrompt: TEST_SYSTEM_PROMPT,
      transcript: TEST_TRANSCRIPT,
    })
  } catch {
    return { ok: false, error: 'failed' }
  }
  if (!result.ok) return { ok: false, error: classifyProviderError(result.error) }
  // The adapters return the JSON as is: the use case validates it, and so does the test.
  if (!parseSummaryResponse(result.value).ok) return { ok: false, error: 'invalidSummary' }
  return { ok: true, ms: Math.max(0, now() - started) }
}
