import { consentKeyFor } from '../../domain/setup.js'
import { LANGUAGES, type Language } from '../../infrastructure/i18n/index.js'
import { isOpenAiHost } from '../../infrastructure/llm/index.js'
import { HttpError, type Route } from '../../interfaces/http/router.js'
import {
  type AppConfig,
  type ConfigIssue,
  type ConfigIssueCode,
  isObject,
  isSetIn,
  type Obj,
  PROVIDERS,
  type ProviderKind,
  readConfigObject,
  validateEffective,
} from '../config/config.js'
import { updateAccountConfig } from '../config/config-writer.js'
import { consentRequiredBody, consentStateOfKey } from '../config/consent.js'
import type { CommandContext } from '../context.js'
import type { DaemonHost } from '../daemon/host.js'
import { accountLayoutOf, unsafeAccountPath } from '../installation/paths.js'
import { type ModelCatalog, unknownModelIn } from './models.js'
import { type AccountRoutesSource, knownAccount } from './routes.js'

export interface SettingsRoutesSource extends AccountRoutesSource {
  readonly ctx: Pick<CommandContext, 'layout'>
  readonly host: DaemonHost
  /** The models the user may choose: a model that is not in the last list known is refused (see `ModelCatalog.accepts`). */
  readonly models?: ModelCatalog
}

type Kind = 'string' | 'boolean' | 'number'

/**
 * The options the web edits (RF-73), by their dotted name in config.json. NOT here: the privacy lists (they are changed
 * through the conversations and can only grow), `promptFile`, `schedules` (legacy: they live in the database) and `web`
 * (the installation's alone). `nullable`: `null` is a value of its own (no provider chosen); for every other option
 * `null` means "remove my value", and the account inherits again.
 */
const EDITABLE: Readonly<Record<string, { readonly kind: Kind; readonly nullable?: true }>> = {
  language: { kind: 'string' },
  timezone: { kind: 'string' },
  ownerName: { kind: 'string' },
  unreadOnly: { kind: 'boolean' },
  flagUnsaved: { kind: 'boolean' },
  hideRest: { kind: 'boolean' },
  maxCharsPerConversation: { kind: 'number' },
  defaultWindowHours: { kind: 'number' },
  concurrency: { kind: 'number' },
  'provider.primary': { kind: 'string', nullable: true },
  'provider.backup': { kind: 'string', nullable: true },
  'provider.claudeCli.model': { kind: 'string' },
  'provider.claudeCli.timeoutMs': { kind: 'number' },
  'provider.ollama.baseUrl': { kind: 'string' },
  'provider.ollama.model': { kind: 'string' },
  'provider.openai.model': { kind: 'string' },
  'provider.openai.baseUrl': { kind: 'string' },
  'provider.anthropic.model': { kind: 'string' },
  'provider.gemini.model': { kind: 'string' },
}

/**
 * The providers the web can choose: the ones whose whole setup is a model, an address and, for the APIs, a key that the
 * web stores (`PUT /api/accounts/:id/keys/:provider`). The rest of the table in `provider-info` (the generic CLI and the presets
 * shipped disabled) needs a command that the web has no field for: they are chosen with `msum provider use`, which also
 * records the consent for what they disclose. A provider the file already holds stays visible (and keeps working).
 * `baseUrl` is only an option of `openai` (LM Studio, OpenRouter...): Anthropic and Gemini have fixed hosts.
 */
export const WEB_PROVIDERS = [
  'claude-cli',
  'ollama',
  'openai',
  'anthropic',
  'gemini',
] as const satisfies readonly ProviderKind[]

const providersOffered = (config: AppConfig): ProviderKind[] => {
  const offered: ProviderKind[] = [...WEB_PROVIDERS]
  for (const held of [config.provider.primary, config.provider.backup]) {
    if (held !== null && !offered.includes(held)) offered.push(held)
  }
  return offered
}

export type SettingSource = 'account' | 'installation' | 'default'

/** An issue as the API gives it: the option and a code (the page translates it), never the file. */
export interface SettingsIssueView {
  readonly option: string
  readonly code: ConfigIssueCode
  readonly allowed?: readonly string[]
}

/** The effective values of the editable options, nested as in config.json. */
export interface SettingsValues {
  readonly language: Language
  readonly timezone: string
  readonly ownerName: string | null
  readonly unreadOnly: boolean
  readonly flagUnsaved: boolean
  readonly hideRest: boolean
  readonly maxCharsPerConversation: number
  readonly defaultWindowHours: number
  readonly concurrency: number
  readonly provider: {
    readonly primary: ProviderKind | null
    readonly backup: ProviderKind | null
    readonly claudeCli: { readonly model: string; readonly timeoutMs: number }
    readonly ollama: { readonly baseUrl: string; readonly model: string | null }
    readonly openai: { readonly baseUrl: string; readonly model: string | null }
    readonly anthropic: { readonly model: string | null }
    readonly gemini: { readonly model: string | null }
  }
}

/** `GET /api/accounts/:id/settings` (and what a successful PUT answers). */
export interface SettingsView {
  readonly values: SettingsValues
  /** Where each value comes from, by dotted option name: the account's file, the installation's, or the default. */
  readonly sources: Readonly<Record<string, SettingSource>>
  readonly options: { readonly providers: readonly ProviderKind[]; readonly languages: readonly Language[] }
}

export const issueViews = (issues: readonly ConfigIssue[]): SettingsIssueView[] =>
  issues.map((issue) => ({
    option: issue.option,
    code: issue.code,
    ...(issue.allowed === undefined ? {} : { allowed: issue.allowed }),
  }))

const valuesOf = (config: AppConfig): SettingsValues => ({
  language: config.language,
  timezone: config.timezone,
  ownerName: config.digest.ownerName,
  unreadOnly: config.digest.unreadOnly,
  flagUnsaved: config.digest.flagUnsaved,
  hideRest: config.digest.hideRest,
  maxCharsPerConversation: config.digest.maxCharsPerConversation,
  defaultWindowHours: config.digest.defaultWindowHours,
  concurrency: config.concurrency,
  provider: {
    primary: config.provider.primary,
    backup: config.provider.backup,
    claudeCli: { model: config.provider.claudeCli.model, timeoutMs: config.provider.claudeCli.timeoutMs },
    ollama: { baseUrl: config.provider.ollama.baseUrl, model: config.provider.ollama.model },
    openai: { baseUrl: config.provider.openai.baseUrl, model: config.provider.openai.model },
    anthropic: { model: config.provider.anthropic.model },
    gemini: { model: config.provider.gemini.model },
  },
})

/** Reads a value of the raw body at a dotted path: undefined when a section on the way is missing. */
function readPath(body: Obj, path: string): unknown {
  let node: unknown = body
  for (const key of path.split('.')) {
    if (!isObject(node)) return undefined
    node = node[key]
  }
  return node
}

/**
 * The patch a body asks for, by dotted option name. 400 `invalidRequest` for a body that is not an object, a key that is
 * not an editable option (the privacy lists included) or a value of the wrong JSON type; what the VALUES mean is the
 * configuration's to say (422). `null` removes the account's value, except where `null` is a value (see `EDITABLE`).
 */
export function readPatch(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw new HttpError(400, 'invalidRequest')
  const allowed = new Set(Object.keys(EDITABLE))
  const walk = (node: Obj, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      // The body is nested as config.json is: "provider.primary" is not a key.
      if (key.includes('.')) throw new HttpError(400, 'invalidRequest')
      const path = `${prefix}${key}`
      if (allowed.has(path)) continue
      // A section: only the ones that lead to an option.
      if (isObject(value) && [...allowed].some((option) => option.startsWith(`${path}.`))) walk(value, `${path}.`)
      else throw new HttpError(400, 'invalidRequest')
    }
  }
  walk(body, '')
  const patch: Record<string, unknown> = {}
  for (const [path, spec] of Object.entries(EDITABLE)) {
    const value = readPath(body, path)
    if (value === undefined) continue
    if (value === null) patch[path] = spec.nullable === true ? null : undefined
    else if (typeof value !== spec.kind || (spec.kind === 'number' && !Number.isFinite(value))) {
      throw new HttpError(400, 'invalidRequest')
    } else patch[path] = value
  }
  return patch
}

type Loaded =
  | { readonly ok: true; readonly view: SettingsView }
  | { readonly ok: false; readonly issues: SettingsIssueView[] }

/** The settings of an account as its files say them now, or the problems that keep them from being valid. */
async function describeSettings(source: SettingsRoutesSource, id: string): Promise<Loaded> {
  const { layout } = source.ctx
  const accountFile = accountLayoutOf(layout, id).configFile
  const root = await readConfigObject(layout.configFile)
  if (!root.ok) return { ok: false, issues: issueViews([root.error]) }
  const account = await readConfigObject(accountFile)
  if (!account.ok) return { ok: false, issues: issueViews([account.error]) }
  const effective = validateEffective(root.value, account.value, layout.configFile, accountFile)
  if (!effective.ok) return { ok: false, issues: issueViews(effective.error) }
  const sources: Record<string, SettingSource> = {}
  for (const path of Object.keys(EDITABLE)) {
    sources[path] = isSetIn(account.value, path) ? 'account' : isSetIn(root.value, path) ? 'installation' : 'default'
  }
  return {
    ok: true,
    view: {
      values: valuesOf(effective.value),
      sources,
      options: { providers: providersOffered(effective.value), languages: LANGUAGES },
    },
  }
}

/**
 * The settings of an account (RF-73, RF-62, RF-39).
 *
 * `GET .../settings` gives the effective values of the editable options and where each comes from. `PUT .../settings` takes
 * a PARTIAL patch (only the options to change, nested as in config.json) and writes it into the ACCOUNT's config.json, never
 * the installation's, so a change of one account cannot reach another. The result is validated as the daemon loads it, and
 * nothing is written when it is not valid: 422 `invalidConfig` with the issues (option and code). When it is, the running
 * unit of the account applies it at once, without reconnecting (see `DaemonHost.reloadConfig`), and the answer is the new GET.
 */
export function settingsRoutes(source: SettingsRoutesSource, onChanged: () => void): Route[] {
  const { host, ctx } = source
  const view = async (id: string) => {
    const loaded = await describeSettings(source, id)
    if (!loaded.ok) return { status: 422, body: { error: 'invalidConfig', issues: loaded.issues } }
    return { body: loaded.view }
  }
  return [
    {
      method: 'GET',
      path: '/api/accounts/:id/settings',
      handler: async ({ params }) => view(knownAccount(source, params)),
    },
    {
      method: 'PUT',
      path: '/api/accounts/:id/settings',
      handler: async ({ params, body }) => {
        const id = knownAccount(source, params)
        const patch = readPatch(body)
        const account = accountLayoutOf(ctx.layout, id)
        if ((await unsafeAccountPath(account)) !== null) throw new HttpError(500, 'internal')
        // A provider the web cannot set up (see `WEB_PROVIDERS`) is not chosen from here, so no provider that sends the chats
        // out is activated without its disclosure and consent. Saving the one the file already holds is fine.
        const held = await describeSettings(source, id)
        for (const option of ['provider.primary', 'provider.backup'] as const) {
          const chosen = patch[option]
          // (A name that is no provider at all is left to the validation below, which says why: 422.)
          if (
            typeof chosen !== 'string' ||
            (WEB_PROVIDERS as readonly string[]).includes(chosen) ||
            !(PROVIDERS as readonly string[]).includes(chosen)
          ) {
            continue
          }
          const current = held.ok
            ? held.view.values.provider[option === 'provider.primary' ? 'primary' : 'backup']
            : null
          if (chosen !== current) throw new HttpError(400, 'invalidRequest')
        }
        // RNF-02: a recipient that gets the text of the chats out of this machine (Claude Code, or an Ollama server that is
        // not on this machine) is chosen here only with the consent of the account recorded; the page asks and retries.
        // What the file already holds (set by hand or by the CLI) is not touched: only a change of `provider.primary`,
        // `provider.backup`, or of the address of an Ollama that is one of them. An invalid change is left to the write
        // below, which says why.
        const preview = await updateAccountConfig({
          rootFile: ctx.layout.configFile,
          accountFile: account.configFile,
          patch,
          dryRun: true,
        })
        if (preview.ok) {
          const { primary, backup, ollama, openai } = preview.value.provider
          const officialOpenAi = isOpenAiHost(openai.baseUrl)
          const keys = new Set<string | null>()
          for (const option of ['provider.primary', 'provider.backup']) {
            const chosen = patch[option]
            if (typeof chosen === 'string') keys.add(consentKeyFor(chosen, ollama.baseUrl, officialOpenAi))
          }
          // Also when the change removes the address (back to the one the installation or the default gives): what counts is
          // the address in force before and after, so a change that leaves it where it was asks nothing.
          const ollamaBefore = held.ok ? held.view.values.provider.ollama.baseUrl : null
          if (
            'provider.ollama.baseUrl' in patch &&
            ollama.baseUrl !== ollamaBefore &&
            (primary === 'ollama' || backup === 'ollama')
          ) {
            keys.add(consentKeyFor('ollama', ollama.baseUrl, officialOpenAi))
          }
          // Another address for OpenAI sends the chats (and the key) to another host: the agreement is asked again, also
          // when the change removes the address (back to OpenAI's own).
          if ('provider.openai.baseUrl' in patch && (primary === 'openai' || backup === 'openai')) {
            keys.add(consentKeyFor('openai', ollama.baseUrl, officialOpenAi))
          }
          for (const key of keys) {
            // Against the configuration this change would leave: the same rule as `doctor` (kind, current text, hosts).
            if (key !== null && consentStateOfKey(source.installation.setup, id, key, preview.value) === 'missing') {
              return { status: 409, body: consentRequiredBody(key, preview.value) }
            }
          }
        }
        // A model is chosen from a list: one that is not in the last list known for its provider is refused (not what the
        // account already holds, which may have been set by hand). "Test connection" stays the final proof.
        const unknown = await unknownModelIn(source, id, patch, held.ok ? held.view.values : null)
        if (unknown !== null) return { status: 422, body: { error: 'unknownModel', option: unknown } }
        const written = await updateAccountConfig({
          rootFile: ctx.layout.configFile,
          accountFile: account.configFile,
          patch,
        })
        if (!written.ok) {
          if (written.error.some((issue) => issue.code === 'concurrentEdit')) throw new HttpError(409, 'concurrentEdit')
          return { status: 422, body: { error: 'invalidConfig', issues: issueViews(written.error) } }
        }
        await host.reloadConfig(id)
        onChanged()
        return view(id)
      },
    },
  ]
}
