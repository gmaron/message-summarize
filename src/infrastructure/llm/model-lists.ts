import { err, ok, type Result } from '../../domain/result.js'
import { ANTHROPIC_BASE_URL, ANTHROPIC_VERSION } from './api/anthropic-summarizer.js'
import { GEMINI_BASE_URL } from './api/gemini-summarizer.js'
import { isOpenAiHost, OPENAI_BASE_URL } from './api/openai-compatible-summarizer.js'
import { readTextCapped } from './read-capped.js'

/**
 * The list of models a provider says it has, to let the user choose one instead of typing it. These are the only calls of
 * "list models": one GET to the host already declared for the provider (RNF-01), with the key it already has, no chat text,
 * a timeout, no redirects and no retries. The key goes in the request headers only (RNF-04): it is never part of a URL,
 * an error or a log, and a failure is reduced to a code.
 */

export interface ModelOption {
  readonly id: string
  /** A friendly name, when the provider gives one. */
  readonly name?: string
}

export type ModelListError = 'noKey' | 'rejected' | 'unreachable' | 'failed'

/** The aliases Claude Code accepts for `--model`: a fixed list, nothing to ask anywhere. */
export const CLAUDE_CLI_MODELS: readonly ModelOption[] = [
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'opus', name: 'Opus' },
  { id: 'haiku', name: 'Haiku' },
]

export const MODEL_LIST_TIMEOUT_MS = 8_000
/** A list of models is a few tens of kilobytes; more than this is not one (the stream is cut when it passes it). */
export const MAX_BODY_BYTES = 2_000_000

export type ListedProvider = 'openai' | 'anthropic' | 'gemini'

export interface ListOptions {
  /** The key, when there is one. OpenAI and the others need it; a compatible server may not. */
  readonly key?: string
  /** The address of OpenAI, or of a compatible server. The other providers have a fixed host. */
  readonly baseUrl?: string
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** OpenAI ids that can write text: the chat families, without the models of other jobs. */
const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-)/
const OPENAI_NOT_TEXT =
  /(embedding|tts|whisper|dall-e|image|moderation|realtime|audio|transcribe|search|instruct|davinci|babbage|-pro|deep-research|codex|computer-use)/

export function openAiModels(body: unknown, official: boolean): ModelOption[] {
  const data = asRecord(body)?.data
  if (!Array.isArray(data)) return []
  const rows: { id: string; created: number }[] = []
  for (const entry of data) {
    const row = asRecord(entry)
    const id = text(row?.id)
    if (id === undefined) continue
    // A compatible server names its models as it likes: nothing is filtered there (it cannot be known what each one does).
    if (official && (!OPENAI_CHAT.test(id) || OPENAI_NOT_TEXT.test(id))) continue
    rows.push({ id, created: typeof row?.created === 'number' ? row.created : 0 })
  }
  // The newest first; the same date (or none, as most compatible servers) by name.
  rows.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
  return rows.map(({ id }) => ({ id }))
}

export function anthropicModels(body: unknown): ModelOption[] {
  const data = asRecord(body)?.data
  if (!Array.isArray(data)) return []
  const rows: { id: string; name?: string; at: number }[] = []
  for (const entry of data) {
    const row = asRecord(entry)
    const id = text(row?.id)
    if (id === undefined) continue
    const name = text(row?.display_name)
    const at = Date.parse(text(row?.created_at) ?? '')
    rows.push({ id, ...(name === undefined ? {} : { name }), at: Number.isNaN(at) ? 0 : at })
  }
  rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
  return rows.map(({ id, name }) => ({ id, ...(name === undefined ? {} : { name }) }))
}

const GEMINI_NOT_TEXT = /(embed|imagen|veo|aqa|tts|image|live|native-audio)/

export function geminiModels(body: unknown): ModelOption[] {
  const models = asRecord(body)?.models
  if (!Array.isArray(models)) return []
  const rows: ModelOption[] = []
  for (const entry of models) {
    const row = asRecord(entry)
    const full = text(row?.name)
    if (full === undefined) continue
    const methods = row?.supportedGenerationMethods
    if (!Array.isArray(methods) || !methods.includes('generateContent')) continue
    const id = full.replace(/^models\//, '')
    if (GEMINI_NOT_TEXT.test(id)) continue
    const name = text(row?.displayName)
    rows.push({ id, ...(name === undefined ? {} : { name }) })
  }
  // Gemini gives no date: the highest version first ("gemini-2.5-pro" before "gemini-2.0-flash").
  rows.sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }))
  return rows
}

/** The request for the list of a provider: the URL and the headers (the key only in these). */
function requestFor(
  provider: ListedProvider,
  options: ListOptions,
  baseUrls: { anthropic?: string; gemini?: string },
): { url: string; headers: Record<string, string>; official: boolean } {
  const key = options.key
  switch (provider) {
    case 'openai': {
      const base = (options.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '')
      return {
        url: `${base}/models`,
        headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
        official: isOpenAiHost(base),
      }
    }
    case 'anthropic':
      return {
        url: `${(baseUrls.anthropic ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '')}/v1/models?limit=1000`,
        headers: { 'x-api-key': key ?? '', 'anthropic-version': ANTHROPIC_VERSION },
        official: true,
      }
    case 'gemini':
      return {
        url: `${(baseUrls.gemini ?? GEMINI_BASE_URL).replace(/\/+$/, '')}/v1beta/models?pageSize=1000`,
        headers: { 'x-goog-api-key': key ?? '' },
        official: true,
      }
  }
}

/**
 * The models of `provider` that can write the summaries, newest or most relevant first. The error is a code only. A
 * provider that needs a key and has none is `noKey` without any request.
 */
export async function listProviderModels(
  provider: ListedProvider,
  options: ListOptions & { readonly baseUrls?: { anthropic?: string; gemini?: string } } = {},
): Promise<Result<ModelOption[], ModelListError>> {
  const { url, headers, official } = requestFor(provider, options, options.baseUrls ?? {})
  const needsKey = provider !== 'openai' || official
  if (needsKey && (options.key === undefined || options.key === '')) return err('noKey')
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: 'GET',
      headers,
      // These APIs never redirect. Following one would send the key to a host nobody declared (RNF-01).
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS),
    })
    if (response.status === 401 || response.status === 403) return err('rejected')
    if (!response.ok) return err('failed')
    const raw = await readTextCapped(response, MAX_BODY_BYTES)
    if (raw === null) return err('failed')
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return err('failed')
    }
    const models =
      provider === 'openai'
        ? openAiModels(body, official)
        : provider === 'anthropic'
          ? anthropicModels(body)
          : geminiModels(body)
    // A server that answers with something that is not a list of models: the caller falls back, it is not an empty list.
    return models.length === 0 ? err('failed') : ok(models)
  } catch {
    return err('unreachable')
  }
}
