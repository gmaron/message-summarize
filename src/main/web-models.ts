import { createHash } from 'node:crypto'
import { consentKeyFor } from '../domain/setup.js'
import {
  CLAUDE_CLI_MODELS,
  FALLBACK_MODELS,
  type ListedProvider,
  listOllamaModels,
  listProviderModels,
  type ModelListError,
  type ModelOption,
} from '../infrastructure/llm/index.js'
import { resolveApiKey } from '../infrastructure/secrets/index.js'
import { HttpError, type Route } from '../interfaces/http/router.js'
import { type AppConfig, isObject, loadEffectiveConfig } from './config.js'
import { updateAccountConfig } from './config-writer.js'
import { consentStateOfKey } from './consent.js'
import type { CommandContext } from './context.js'
import { accountLayoutOf } from './paths.js'
import { openAiKeyProvider } from './providers.js'
import { type AccountRoutesSource, knownAccount } from './web-routes.js'

export interface ModelsRoutesSource extends AccountRoutesSource {
  readonly ctx: Pick<CommandContext, 'layout' | 'env' | 'providerBaseUrls'>
}

/** The providers whose model is chosen from a list. */
export const MODEL_PROVIDERS = ['claude-cli', 'ollama', 'openai', 'anthropic', 'gemini'] as const
export type ModelProvider = (typeof MODEL_PROVIDERS)[number]
const isModelProvider = (value: string): value is ModelProvider =>
  (MODEL_PROVIDERS as readonly string[]).includes(value)

/** The option of the configuration that holds the model of each provider. */
export const MODEL_OPTIONS: Readonly<Record<ModelProvider, string>> = {
  'claude-cli': 'provider.claudeCli.model',
  ollama: 'provider.ollama.model',
  openai: 'provider.openai.model',
  anthropic: 'provider.anthropic.model',
  gemini: 'provider.gemini.model',
}

/** `GET /api/accounts/:id/models/:provider`. Names and codes only: never a key, a message of the provider or a path. */
export interface ModelsView {
  readonly provider: ModelProvider
  /** `static`: a fixed list; `live`: what the provider answered; `fallback`: the known models, the live list failed. */
  readonly source: 'static' | 'live' | 'fallback'
  readonly models: readonly ModelOption[]
  /** Why there is no live list. `empty`: the server answered and has no models. */
  readonly error?: ModelListError | 'empty' | 'invalidAddress' | 'consentRequired'
  /** The origin the list was asked at (OpenAI, Ollama), so the page can name it. */
  readonly origin?: string
  /** A typed name is allowed: a compatible server that gives no list (the one case where the list cannot be known). */
  readonly typing?: boolean
}

/** A list that was read is kept this long, per provider, address and key. */
export const MODEL_CACHE_MS = 10 * 60_000
/** A failure is kept briefly, so a page that asks again and again does not make the daemon ask the provider again and again. */
export const MODEL_FAILURE_MS = 30_000

type Listed = { ok: true; models: ModelOption[] } | { ok: false; error: ModelListError }
interface Entry {
  readonly at: number
  readonly result: Listed
}

/** What identifies a key without keeping it: a hash, in memory only. */
const fingerprint = (key: string | undefined): string =>
  key === undefined ? '-' : createHash('sha256').update(key).digest('hex').slice(0, 16)

const normalized = (url: string): string => url.trim().replace(/\/+$/, '')

const originOf = (url: string): string | null => {
  try {
    const parsed = new URL(url.trim())
    // An address with credentials in it names a recipient nobody should paste: refused like any invalid one.
    if (parsed.username !== '' || parsed.password !== '') return null
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

/** What the page may ask besides the provider: look again, the Ollama address on screen, and the agreement it ticked. */
export interface ModelsQuery {
  readonly refresh?: boolean
  readonly baseUrl?: string
  /** The consent key the user ticked for a server that is not on this machine (`ollama-remote`). */
  readonly consent?: string
  /** The address field was emptied (the account's own address is being removed): the one the installation gives is meant. */
  readonly inherit?: boolean
}

export interface ModelCatalog {
  readonly routes: Route[]
  /**
   * Whether `model` may be saved for `provider` on this account: false only when the last list known for that provider, at
   * that address and with that key, does not have it (and is not older than the cache). `address` is the one the same save
   * sets (Ollama or OpenAI), which may differ from the one in force; `null` means the same save REMOVES the account's own
   * address, so the one the installation gives is the one that counts. With no list known it is true, and "Test connection"
   * decides.
   */
  accepts(accountId: string, provider: ModelProvider, model: string, address?: string | null): Promise<boolean>
}

/**
 * The models the user may choose (RF-41): the aliases of Claude Code (fixed), the models installed on the user's Ollama
 * (`/api/tags`), and, for OpenAI, Anthropic and Gemini, the list the provider answers to a GET made HERE with the key the
 * account already has. The key never reaches the page and never appears in an answer, log or error; the only hosts are the
 * ones already declared for the provider (RNF-01). Lists are cached (`MODEL_CACHE_MS`) by provider, full address and key
 * hash, and the same scope and lifetime decide what a save is checked against. Only Anthropic has a fallback list when its
 * own cannot be read; OpenAI and Gemini show the error instead.
 *
 * The route is a POST: it makes a request to another host (and, for Ollama, to an address typed in the page), so it sits
 * behind the same Origin check as every other write and cannot be triggered from another site.
 *
 * `now` and `fetchFn` are for tests.
 */
export function modelCatalog(
  source: ModelsRoutesSource,
  options: { readonly now?: () => number; readonly fetchFn?: typeof fetch } = {},
): ModelCatalog {
  const { ctx } = source
  const now = options.now ?? Date.now
  const cache = new Map<string, Entry>()
  const inFlight = new Map<string, Promise<Listed>>()
  /** The last live list per scope (provider, full address, key hash): what a save is checked against. */
  const known = new Map<string, { readonly at: number; readonly ids: ReadonlySet<string> }>()
  const scopeOf = (provider: ModelProvider, baseUrl: string | undefined, key: string | undefined): string =>
    `${provider}|${baseUrl === undefined ? '-' : normalized(baseUrl)}|${fingerprint(key)}`

  async function configOf(id: string) {
    const loaded = await loadEffectiveConfig(ctx.layout.configFile, accountLayoutOf(ctx.layout, id).configFile)
    if (!loaded.ok) throw new HttpError(422, 'invalidConfig')
    return loaded.value
  }

  const keyOf = (id: string, provider: 'openai' | 'openai-compatible' | 'anthropic' | 'gemini'): string | undefined =>
    resolveApiKey(provider, {
      env: ctx.env,
      accountFile: accountLayoutOf(ctx.layout, id).secretsFile,
      file: ctx.layout.secretsFile,
    })?.key

  function remember(scope: string, models: readonly ModelOption[]): void {
    known.set(scope, { at: now(), ids: new Set(models.map((model) => model.id)) })
  }

  async function listApi(
    provider: ListedProvider,
    baseUrl: string | undefined,
    key: string | undefined,
    refresh: boolean,
  ): Promise<Listed> {
    const scope = scopeOf(provider, baseUrl, key)
    const cached = cache.get(scope)
    if (!refresh && cached !== undefined) {
      const age = now() - cached.at
      if (age < (cached.result.ok ? MODEL_CACHE_MS : MODEL_FAILURE_MS)) return cached.result
    }
    const running = inFlight.get(scope)
    if (running !== undefined) return running
    const work = (async (): Promise<Listed> => {
      const listed = await listProviderModels(provider, {
        ...(key === undefined ? {} : { key }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(ctx.providerBaseUrls === undefined ? {} : { baseUrls: ctx.providerBaseUrls }),
        ...(options.fetchFn === undefined ? {} : { fetch: options.fetchFn }),
      })
      const result: Listed = listed.ok ? { ok: true, models: listed.value } : { ok: false, error: listed.error }
      // No key is not a failure of the provider: nothing was asked, nothing is kept.
      if (!(listed.ok === false && listed.error === 'noKey')) cache.set(scope, { at: now(), result })
      // A list that failed is no list: what was known stays until it expires, it is not replaced by nothing.
      if (result.ok) remember(scope, result.models)
      return result
    })().finally(() => inFlight.delete(scope))
    inFlight.set(scope, work)
    return work
  }

  /**
   * The Ollama address the question is about: the one on screen when there is one, else the one the account uses (the daemon
   * says which, so the page never guesses it). Null when it is not a web address or the account's configuration would not
   * accept it.
   */
  async function ollamaAddress(
    id: string,
    typed: string | undefined,
    inherit = false,
  ): Promise<{ baseUrl: string; origin: string; config: AppConfig } | null> {
    // Emptied in the page: the account's own address goes away, so the installation's (or the default) is the one in force.
    const effective = inherit ? await withoutOwnAddress(id, 'provider.ollama.baseUrl') : await configOf(id)
    const baseUrl = typed ?? effective.provider.ollama.baseUrl
    const origin = originOf(baseUrl)
    if (origin === null) return null
    if (typed === undefined) return { baseUrl, origin, config: effective }
    // The address on screen is validated as a save would (the same rules as the configuration), without saving it.
    const resolved = await updateAccountConfig({
      rootFile: ctx.layout.configFile,
      accountFile: accountLayoutOf(ctx.layout, id).configFile,
      patch: { 'provider.ollama.baseUrl': typed },
      dryRun: true,
    })
    return resolved.ok ? { baseUrl, origin, config: resolved.value } : null
  }

  /** The configuration the account would have if its own value of `option` were removed (what an emptied field gives). */
  async function withoutOwnAddress(id: string, option: string): Promise<AppConfig> {
    const resolved = await updateAccountConfig({
      rootFile: ctx.layout.configFile,
      accountFile: accountLayoutOf(ctx.layout, id).configFile,
      // `undefined` removes the option from the account's file (that is what an emptied field of the page sends).
      patch: { [option]: undefined },
      dryRun: true,
    })
    if (!resolved.ok) throw new HttpError(422, 'invalidConfig')
    return resolved.value
  }

  async function view(id: string, provider: ModelProvider, query: ModelsQuery): Promise<ModelsView> {
    const refresh = query.refresh === true
    if (provider === 'claude-cli') return { provider, source: 'static', models: CLAUDE_CLI_MODELS }
    if (provider === 'ollama') {
      const target = await ollamaAddress(id, query.baseUrl, query.inherit === true)
      if (target === null) return { provider, source: 'live', models: [], error: 'invalidAddress' }
      const { baseUrl, origin, config } = target
      // A server that is not on this machine is asked only after the user agreed to it (the same rule as a save and a test).
      const key = consentKeyFor('ollama', baseUrl, true)
      if (
        key !== null &&
        query.consent !== key &&
        consentStateOfKey(source.installation.setup, id, key, config) === 'missing'
      ) {
        return { provider, source: 'live', models: [], error: 'consentRequired', origin }
      }
      const listed = await listOllamaModels(baseUrl, options.fetchFn === undefined ? {} : { fetch: options.fetchFn })
      if (!listed.ok) return { provider, source: 'live', models: [], error: 'unreachable', origin }
      const models = listed.value.map((name) => ({ id: name }))
      remember(scopeOf('ollama', baseUrl, undefined), models)
      return models.length === 0
        ? { provider, source: 'live', models, error: 'empty', origin }
        : { provider, source: 'live', models, origin }
    }
    const config = await configOf(id)
    if (provider === 'openai') {
      // The address in force: the key only ever goes to the host the account has configured.
      const baseUrl = config.provider.openai.baseUrl
      const origin = originOf(baseUrl) ?? baseUrl
      const compatible = openAiKeyProvider(baseUrl) === 'openai-compatible'
      const key = keyOf(id, compatible ? 'openai-compatible' : 'openai')
      const listed = await listApi('openai', baseUrl, key, refresh)
      if (listed.ok) return { provider, source: 'live', models: listed.models, origin }
      if (listed.error === 'noKey') return { provider, source: 'live', models: [], error: 'noKey', origin }
      // A compatible server cannot be enumerated any other way: there a typed name is allowed. OpenAI itself is not: it
      // shows the error (there is no list of known models to fall back to).
      return compatible
        ? { provider, source: 'live', models: [], error: listed.error, origin, typing: true }
        : { provider, source: 'live', models: [], error: listed.error, origin }
    }
    const listed = await listApi(provider, undefined, keyOf(id, provider), refresh)
    if (listed.ok) return { provider, source: 'live', models: listed.models }
    if (listed.error === 'noKey') return { provider, source: 'live', models: [], error: 'noKey' }
    // Only Anthropic has a short list of known models; Gemini shows the error.
    return provider === 'anthropic'
      ? { provider, source: 'fallback', models: FALLBACK_MODELS.anthropic, error: listed.error }
      : { provider, source: 'live', models: [], error: listed.error }
  }

  const readQuery = (body: unknown): ModelsQuery => {
    if (body === undefined) return {}
    if (!isObject(body)) throw new HttpError(400, 'invalidRequest')
    const { refresh, baseUrl, consent, inherit } = body
    if (inherit !== undefined && typeof inherit !== 'boolean') throw new HttpError(400, 'invalidRequest')
    if (refresh !== undefined && typeof refresh !== 'boolean') throw new HttpError(400, 'invalidRequest')
    if (baseUrl !== undefined && (typeof baseUrl !== 'string' || baseUrl.length > 2048)) {
      throw new HttpError(400, 'invalidRequest')
    }
    if (consent !== undefined && typeof consent !== 'string') throw new HttpError(400, 'invalidRequest')
    const address = typeof baseUrl === 'string' ? baseUrl.trim() : ''
    return {
      ...(refresh === true ? { refresh: true } : {}),
      ...(address === '' ? {} : { baseUrl: address }),
      ...(consent === undefined ? {} : { consent }),
      ...(inherit === true ? { inherit: true } : {}),
    }
  }

  const routes: Route[] = [
    {
      method: 'POST',
      path: '/api/accounts/:id/models/:provider',
      handler: async ({ params, body }) => {
        const id = knownAccount(source, params)
        const provider = params.provider ?? ''
        if (!isModelProvider(provider)) throw new HttpError(404, 'notFound')
        const query = readQuery(body)
        // Only Ollama has an address of its own to ask about; for the others one is not a thing to send.
        if (provider !== 'ollama' && (query.baseUrl !== undefined || query.inherit === true)) {
          throw new HttpError(400, 'invalidRequest')
        }
        return { body: await view(id, provider, query) }
      },
    },
  ]

  return {
    routes,
    async accepts(accountId, provider, model, address) {
      if (provider === 'claude-cli') return CLAUDE_CLI_MODELS.some((one) => one.id === model)
      const config = await configOf(accountId)
      let scope: string
      // `null`: the same save removes the account's own address, so the inherited one counts.
      const inherited = async (option: string): Promise<AppConfig> =>
        address === null ? withoutOwnAddress(accountId, option) : config
      if (provider === 'ollama') {
        const base = (await inherited('provider.ollama.baseUrl')).provider.ollama.baseUrl
        scope = scopeOf(provider, address ?? base, undefined)
      } else if (provider === 'openai') {
        const baseUrl = address ?? (await inherited('provider.openai.baseUrl')).provider.openai.baseUrl
        const compatible = openAiKeyProvider(baseUrl) === 'openai-compatible'
        scope = scopeOf(provider, baseUrl, keyOf(accountId, compatible ? 'openai-compatible' : 'openai'))
      } else scope = scopeOf(provider, undefined, keyOf(accountId, provider))
      const list = known.get(scope)
      if (list === undefined) return true
      if (now() - list.at >= MODEL_CACHE_MS) {
        known.delete(scope)
        return true
      }
      if (provider === 'ollama') return list.ids.has(model) || list.ids.has(`${model}:latest`)
      return list.ids.has(model)
    },
  }
}

const valueAt = (values: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | null | undefined)?.[key], values)

/**
 * The option of a patch whose model is not in the last list known for its provider, or null. A model the account already
 * holds is not checked (it may have been set by hand or with the command line): only a change is. `held` are the current
 * values of the account's settings, when they could be read. The address the same patch sets (Ollama, OpenAI) is the one
 * the model is checked at, so changing the address and the model in one save is not refused.
 */
export async function unknownModelIn(
  source: { readonly models?: ModelCatalog },
  accountId: string,
  patch: Readonly<Record<string, unknown>>,
  held: unknown,
): Promise<string | null> {
  if (source.models === undefined) return null
  /** The address the same patch sets, `null` when it clears it (the inherited one counts), undefined when it does not touch it. */
  const address = (option: string): string | null | undefined => {
    if (!(option in patch)) return undefined
    const value = patch[option]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }
  for (const provider of MODEL_PROVIDERS) {
    const option = MODEL_OPTIONS[provider]
    const chosen = patch[option]
    // An empty or null model removes the account's own value: nothing to check.
    if (typeof chosen !== 'string' || chosen.trim() === '') continue
    if (chosen === valueAt(held, option)) continue
    const at =
      provider === 'ollama'
        ? address('provider.ollama.baseUrl')
        : provider === 'openai'
          ? address('provider.openai.baseUrl')
          : undefined
    if (!(await source.models.accepts(accountId, provider, chosen.trim(), at))) return option
  }
  return null
}
