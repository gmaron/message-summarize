import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DEFAULT_CONCURRENCY } from '../application/generate-digest.js'
import { exactIdOf } from '../domain/exclusion.js'
import { err, ok, type Result } from '../domain/result.js'
import { type DigestSettings, parseDigestSettings, type SettingsIssueCode } from '../domain/settings.js'
import type { Catalog, Language } from '../infrastructure/i18n/index.js'
import { LANGUAGES } from '../infrastructure/i18n/index.js'
import { isValidTimezone } from '../infrastructure/scheduling/croner-scheduler.js'

export const PROVIDERS = ['claude-cli', 'ollama'] as const
export type ProviderKind = (typeof PROVIDERS)[number]

export interface ClaudeCliConfig {
  readonly command: string
  readonly model: string
  readonly timeoutMs: number
}

export interface OllamaConfig {
  readonly baseUrl: string
  /** There is no sensible default model: required when Ollama is used (as the provider or for local-only chats). */
  readonly model: string | null
  readonly numCtx: number
  readonly keepAlive: string
  readonly timeoutMs: number
}

export interface ProviderConfig {
  /** Null until the user chooses one (RF-41: there is no default provider). */
  readonly primary: ProviderKind | null
  readonly backup: ProviderKind | null
  readonly claudeCli: ClaudeCliConfig
  readonly ollama: OllamaConfig
}

/** The local web (RNF-03). Only the installation's config.json sets it: an account cannot. */
export interface WebConfig {
  readonly enabled: boolean
  /** "127.0.0.1" by default. Any other address is the explicit opt-in to expose the web beyond this machine. */
  readonly host: string
  readonly port: number
}

export const DEFAULT_WEB: WebConfig = { enabled: true, host: '127.0.0.1', port: 8787 }

/** The validated contents of config.json. A missing option has its default (RF-73). */
export interface AppConfig {
  readonly language: Language
  /** IANA name. Dates in the digest and the schedules use it. */
  readonly timezone: string
  readonly digest: DigestSettings
  readonly localOnlyPatterns: readonly string[]
  /** Path of a custom prompt template, read on every digest (RF-38). */
  readonly promptFile: string | null
  readonly concurrency: number
  /** Cron expressions (RF-60). */
  readonly schedules: readonly string[]
  readonly provider: ProviderConfig
  readonly web: WebConfig
}

export type ConfigIssueCode =
  | SettingsIssueCode
  | 'invalidJson'
  | 'unknownOption'
  | 'notOneOf'
  | 'required'
  | 'invalidTimezone'
  | 'invalidPort'
  /** Not an absolute http(s) URL. */
  | 'invalidUrl'
  /** The account file changed while it was being updated (the writer gave up). */
  | 'concurrentEdit'
  /** An option that only the installation's config.json may set, found in an account's. */
  | 'installationOnly'

/** A problem of config.json: which option and why. Codes, not text: `describeConfigIssue` translates them. */
export interface ConfigIssue {
  readonly option: string
  readonly code: ConfigIssueCode
  /** For notOneOf: the accepted values. */
  readonly allowed?: readonly string[]
  /** The file the problem comes from, when more than one file is read (an installation and an account). */
  readonly file?: string
}

export const DEFAULT_LANGUAGE: Language = 'es'
const DEFAULT_PROVIDER_TIMEOUT_MS = 3 * 60_000

export const systemTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

const TOP_LEVEL = new Set([
  'language',
  'timezone',
  'ownerName',
  'excludePatterns',
  'defaultWindowHours',
  'maxCharsPerConversation',
  'unreadOnly',
  'flagUnsaved',
  'hideRest',
  'localOnlyPatterns',
  'promptFile',
  'concurrency',
  'schedules',
  'provider',
  'web',
])
const PROVIDER_KEYS = new Set(['primary', 'backup', 'claudeCli', 'ollama'])
const CLAUDE_CLI_KEYS = new Set(['command', 'model', 'timeoutMs'])
const WEB_KEYS = new Set(['enabled', 'host', 'port'])
const OLLAMA_KEYS = new Set(['baseUrl', 'model', 'numCtx', 'keepAlive', 'timeoutMs'])

/** Lists an account can only add to (see `mergeConfigJson`). */
const UNIONED_LISTS = ['localOnlyPatterns', 'excludePatterns'] as const

export type Obj = Record<string, unknown>
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
  } catch {
    return false
  }
}

export const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validates config.json (RF-73). A missing option takes its default; an option that is present and invalid, or one
 * that does not exist (a typo), is reported with its name and a code, never replaced silently. `fallbackTimezone` is
 * the default of `timezone` (the system's).
 */
export function parseConfig(
  input: unknown,
  fallbackTimezone: string = systemTimezone(),
): Result<AppConfig, ConfigIssue[]> {
  if (!isObject(input)) return err([{ option: '(config)', code: 'notObject' }])
  const issues: ConfigIssue[] = []
  const add = (option: string, code: ConfigIssueCode, allowed?: readonly string[]): undefined => {
    issues.push(allowed === undefined ? { option, code } : { option, code, allowed })
    return undefined
  }
  const unknownKeys = (obj: Obj, known: Set<string>, prefix: string): void => {
    for (const key of Object.keys(obj)) if (!known.has(key)) add(`${prefix}${key}`, 'unknownOption')
  }

  const text = (obj: Obj, key: string, path: string): string | null | undefined => {
    const v = obj[key]
    if (v === undefined) return null
    if (typeof v !== 'string') return add(path, 'notString')
    if (v.trim() === '') return add(path, 'emptyString')
    return v
  }
  const positiveInt = (obj: Obj, key: string, path: string, fallback: number): number | undefined => {
    const v = obj[key]
    if (v === undefined) return fallback
    if (typeof v !== 'number') return add(path, 'notNumber')
    if (!Number.isInteger(v)) return add(path, 'notInteger')
    if (v <= 0) return add(path, 'notPositive')
    return v
  }
  const patterns = (key: string): readonly string[] | undefined => {
    const v = input[key]
    if (v === undefined) return []
    if (!Array.isArray(v)) return add(key, 'notArray')
    if (!v.every((p) => typeof p === 'string')) return add(key, 'notStringList')
    if (v.some((p: string) => p.trim() === '')) return add(key, 'emptyPattern')
    if (v.some((p: string) => exactIdOf(p) === '')) return add(key, 'emptyIdPattern')
    return [...(v as string[])]
  }
  const choice = (obj: Obj, key: string, path: string, allowed: readonly string[]): string | null | undefined => {
    const v = obj[key]
    // Absent or null: not chosen (`msum init` writes null for the provider, which has no default).
    if (v === undefined || v === null) return null
    if (typeof v !== 'string' || !allowed.includes(v)) return add(path, 'notOneOf', allowed)
    return v
  }
  const section = (parent: Obj, key: string, path: string, known: Set<string>): Obj => {
    const v = parent[key]
    if (v === undefined) return {}
    if (!isObject(v)) {
      add(path, 'notObject')
      return {}
    }
    unknownKeys(v, known, `${path}.`)
    return v
  }

  unknownKeys(input, TOP_LEVEL, '')

  const settings = parseDigestSettings(input)
  if (!settings.ok) for (const issue of settings.error) add(issue.option, issue.code)

  const language = ((): Language | undefined => {
    const v = choice(input, 'language', 'language', LANGUAGES)
    return v === null ? DEFAULT_LANGUAGE : (v as Language | undefined)
  })()

  const timezone = ((): string | undefined => {
    const v = input.timezone
    if (v === undefined) return fallbackTimezone
    if (typeof v !== 'string') return add('timezone', 'notString')
    if (!isValidTimezone(v)) return add('timezone', 'invalidTimezone')
    return v
  })()

  const localOnlyPatterns = patterns('localOnlyPatterns')
  const promptFile = text(input, 'promptFile', 'promptFile')
  const concurrency = positiveInt(input, 'concurrency', 'concurrency', DEFAULT_CONCURRENCY)

  const schedules = ((): readonly string[] | undefined => {
    const v = input.schedules
    if (v === undefined) return []
    if (!Array.isArray(v)) return add('schedules', 'notArray')
    if (!v.every((s) => typeof s === 'string')) return add('schedules', 'notStringList')
    // Only imported once, at the first use of an account (see `importConfigSchedules`), and ignored afterwards: an
    // expression that cannot be imported is not a reason to refuse the whole configuration. `doctor` lists those.
    return [...(v as string[])]
  })()

  const providerObj = section(input, 'provider', 'provider', PROVIDER_KEYS)
  const primary = choice(providerObj, 'primary', 'provider.primary', PROVIDERS) as ProviderKind | null | undefined
  const backup = choice(providerObj, 'backup', 'provider.backup', PROVIDERS) as ProviderKind | null | undefined
  if (backup !== null && backup !== undefined && primary === null) add('provider.primary', 'required')

  const cliObj = section(providerObj, 'claudeCli', 'provider.claudeCli', CLAUDE_CLI_KEYS)
  const claudeCommand = text(cliObj, 'command', 'provider.claudeCli.command')
  const claudeModel = text(cliObj, 'model', 'provider.claudeCli.model')
  const claudeTimeout = positiveInt(cliObj, 'timeoutMs', 'provider.claudeCli.timeoutMs', DEFAULT_PROVIDER_TIMEOUT_MS)

  const ollamaObj = section(providerObj, 'ollama', 'provider.ollama', OLLAMA_KEYS)
  const ollamaBaseUrl = ((): string | null | undefined => {
    const v = text(ollamaObj, 'baseUrl', 'provider.ollama.baseUrl')
    if (typeof v !== 'string') return v
    // Where the "local only" chats go: an absolute http(s) address, nothing else.
    return isHttpUrl(v) ? v : add('provider.ollama.baseUrl', 'invalidUrl')
  })()
  const ollamaModel = text(ollamaObj, 'model', 'provider.ollama.model')
  const ollamaNumCtx = positiveInt(ollamaObj, 'numCtx', 'provider.ollama.numCtx', 16384)
  const ollamaKeepAlive = text(ollamaObj, 'keepAlive', 'provider.ollama.keepAlive')
  const ollamaTimeout = positiveInt(ollamaObj, 'timeoutMs', 'provider.ollama.timeoutMs', DEFAULT_PROVIDER_TIMEOUT_MS)

  const webObj = section(input, 'web', 'web', WEB_KEYS)
  const webEnabled = ((): boolean | undefined => {
    const v = webObj.enabled
    if (v === undefined) return DEFAULT_WEB.enabled
    return typeof v === 'boolean' ? v : add('web.enabled', 'notBoolean')
  })()
  const webHost = text(webObj, 'host', 'web.host')
  const webPort = ((): number | undefined => {
    const v = webObj.port
    if (v === undefined) return DEFAULT_WEB.port
    if (typeof v !== 'number') return add('web.port', 'notNumber')
    if (!Number.isInteger(v)) return add('web.port', 'notInteger')
    if (v < 1 || v > 65535) return add('web.port', 'invalidPort')
    return v
  })()

  const usesOllama =
    primary === 'ollama' || backup === 'ollama' || (localOnlyPatterns !== undefined && localOnlyPatterns.length > 0)
  if (usesOllama && ollamaModel === null) add('provider.ollama.model', 'required')

  if (
    issues.length > 0 ||
    !settings.ok ||
    language === undefined ||
    timezone === undefined ||
    localOnlyPatterns === undefined ||
    promptFile === undefined ||
    concurrency === undefined ||
    schedules === undefined ||
    primary === undefined ||
    backup === undefined ||
    claudeCommand === undefined ||
    claudeModel === undefined ||
    claudeTimeout === undefined ||
    ollamaBaseUrl === undefined ||
    ollamaModel === undefined ||
    ollamaNumCtx === undefined ||
    ollamaKeepAlive === undefined ||
    ollamaTimeout === undefined ||
    webEnabled === undefined ||
    webHost === undefined ||
    webPort === undefined
  ) {
    return err(issues)
  }
  return ok({
    language,
    timezone,
    digest: settings.value,
    localOnlyPatterns,
    promptFile,
    concurrency,
    schedules,
    provider: {
      primary,
      backup,
      claudeCli: { command: claudeCommand ?? 'claude', model: claudeModel ?? 'sonnet', timeoutMs: claudeTimeout },
      ollama: {
        baseUrl: ollamaBaseUrl ?? 'http://127.0.0.1:11434',
        model: ollamaModel,
        numCtx: ollamaNumCtx,
        keepAlive: ollamaKeepAlive ?? '1m',
        timeoutMs: ollamaTimeout,
      },
    },
    web: { enabled: webEnabled, host: webHost ?? DEFAULT_WEB.host, port: webPort },
  })
}

async function readJson(file: string): Promise<Result<unknown, 'missing' | 'invalid'>> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return err('missing')
    throw error
  }
  try {
    return ok(JSON.parse(raw))
  } catch {
    return err('invalid')
  }
}

/** Reads and validates config.json. A file that does not exist gives the defaults (RF-73). */
export async function loadConfig(file: string, fallbackTimezone?: string): Promise<Result<AppConfig, ConfigIssue[]>> {
  const json = await readJson(file)
  if (!json.ok) {
    return json.error === 'missing'
      ? parseConfig({}, fallbackTimezone)
      : err([{ option: '(config)', code: 'invalidJson' }])
  }
  return parseConfig(json.value, fallbackTimezone)
}

/**
 * The options of an account over those of the installation (RF-03). Every top-level option of the account file
 * replaces the installation's; `provider` merges per key (primary, backup, and the options of claudeCli and ollama
 * one by one), so an account can change its model without repeating the rest. A value of the wrong shape is kept as
 * it is, so the validation of the merged result reports it.
 *
 * The privacy lists `localOnlyPatterns` and `excludePatterns` are the exception to "replaces": they are UNIONED with
 * the installation's (deduplicated, installation first), so an account can add to them but never weaken them.
 */
export function mergeConfigJson(base: Obj, overrides: Obj): Obj {
  const merged: Obj = { ...base, ...overrides }
  for (const key of UNIONED_LISTS) {
    const baseList = base[key]
    const overrideList = overrides[key]
    if (Array.isArray(baseList) && Array.isArray(overrideList)) {
      merged[key] = [...new Set([...baseList, ...overrideList])]
    }
  }
  const baseProvider = base.provider
  const overrideProvider = overrides.provider
  if (isObject(baseProvider) && isObject(overrideProvider)) {
    const provider: Obj = { ...baseProvider, ...overrideProvider }
    for (const key of ['claudeCli', 'ollama']) {
      const baseSection = baseProvider[key]
      const overrideSection = overrideProvider[key]
      if (isObject(baseSection) && isObject(overrideSection)) provider[key] = { ...baseSection, ...overrideSection }
    }
    merged.provider = provider
  }
  return merged
}

/** True when `path` ("provider.ollama.model", "schedules[1]") is set in `source`. */
export function isSetIn(source: Obj, path: string): boolean {
  let node: unknown = source
  for (const key of path.replace(/\[\d+\]/g, '').split('.')) {
    if (!isObject(node) || !(key in node)) return false
    node = node[key]
  }
  return true
}

/**
 * Validates an installation's and an account's raw contents as ONE configuration: what loading does once both files
 * are read, and what the writer checks before it saves a change. A problem names the file it comes from: the account's
 * when that file sets the option, else the installation's. A relative `promptFile` is resolved against the directory
 * of the file that set it, so the result holds an absolute path.
 */
export function validateEffective(
  root: Obj,
  account: Obj,
  rootFile: string,
  accountFile: string | null,
  fallbackTimezone?: string,
): Result<AppConfig, ConfigIssue[]> {
  // The web belongs to the installation (one server for every account): an account file cannot configure it.
  if (accountFile !== null && 'web' in account) {
    return err([{ option: 'web', code: 'installationOnly', file: accountFile }])
  }
  const parsed = parseConfig(mergeConfigJson(root, account), fallbackTimezone)
  const fromAccount = (option: string): boolean => accountFile !== null && isSetIn(account, option)
  if (!parsed.ok) {
    return err(
      parsed.error.map((issue) => ({ ...issue, file: fromAccount(issue.option) ? (accountFile as string) : rootFile })),
    )
  }
  const { promptFile } = parsed.value
  if (promptFile === null) return parsed
  const source = fromAccount('promptFile') ? (accountFile as string) : rootFile
  return ok({ ...parsed.value, promptFile: resolve(dirname(source), promptFile) })
}

/** Reads a config file as a raw JSON object: `{}` when it does not exist, the issues when it is not valid. */
export async function readConfigObject(file: string): Promise<Result<Obj, ConfigIssue>> {
  const json = await readJson(file)
  if (!json.ok) return json.error === 'missing' ? ok({}) : err({ option: '(config)', code: 'invalidJson', file })
  if (!isObject(json.value)) return err({ option: '(config)', code: 'notObject', file })
  return ok(json.value)
}

/**
 * The configuration an account runs with: the installation's `rootFile` merged with the account's optional
 * `accountFile` (see `mergeConfigJson`), validated as a whole (see `validateEffective`).
 */
export async function loadEffectiveConfig(
  rootFile: string,
  accountFile: string | null,
  fallbackTimezone?: string,
): Promise<Result<AppConfig, ConfigIssue[]>> {
  const files = accountFile === null ? [rootFile] : [rootFile, accountFile]
  const issues: ConfigIssue[] = []
  const parts: Obj[] = []
  for (const file of files) {
    const read = await readConfigObject(file)
    if (read.ok) parts.push(read.value)
    else {
      issues.push(read.error)
      parts.push({})
    }
  }
  if (issues.length > 0) return err(issues)
  const [root = {}, account = {}] = parts
  return validateEffective(root, account, rootFile, accountFile, fallbackTimezone)
}

/**
 * A fingerprint of the config files (modification time and size of each, or "missing"): two equal fingerprints mean
 * nothing was written to them in between. It is how the daemon notices an edit by hand or by another process.
 */
export async function configStamp(files: readonly string[]): Promise<string> {
  const parts = await Promise.all(
    files.map(async (file) => {
      try {
        const info = await stat(file)
        return `${info.mtimeMs}:${info.size}`
      } catch {
        return 'missing'
      }
    }),
  )
  return parts.join('|')
}

/**
 * The language to talk to the user in when the configuration may be broken: the one in the file when it is valid,
 * else the default. With an account file, its language wins over the installation's. Never throws.
 */
export async function languageHint(file: string, accountFile: string | null = null): Promise<Language> {
  const hintOf = async (path: string): Promise<Language | null> => {
    try {
      const json = await readJson(path)
      if (json.ok && isObject(json.value)) {
        const v = json.value.language
        if (typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v)) return v as Language
      }
    } catch {
      // unreadable: no hint
    }
    return null
  }
  return (accountFile === null ? null : await hintOf(accountFile)) ?? (await hintOf(file)) ?? DEFAULT_LANGUAGE
}

/** One line for the user: the option and the reason, in their language (RF-73). */
export function describeConfigIssue(catalog: Catalog, issue: ConfigIssue): string {
  const text = describeIssueText(catalog, issue)
  return issue.file === undefined ? text : catalog.cli.config.inFile(issue.file, text)
}

function describeIssueText(catalog: Catalog, issue: ConfigIssue): string {
  const texts = catalog.cli.config
  switch (issue.code) {
    case 'invalidJson':
      return texts.invalidJson
    case 'unknownOption':
      return texts.unknownOption(issue.option)
    case 'notOneOf':
      return texts.notOneOf(issue.option, (issue.allowed ?? []).join(', '))
    case 'required':
      return texts.required(issue.option)
    case 'invalidTimezone':
      return texts.invalidTimezone(issue.option)
    case 'invalidPort':
      return texts.invalidPort(issue.option)
    case 'installationOnly':
      return texts.installationOnly(issue.option)
    case 'invalidUrl':
      return texts.invalidUrl(issue.option)
    case 'concurrentEdit':
      return texts.concurrentEdit
    default:
      return catalog.errors.settings[issue.code](issue.option)
  }
}

/** The config.json that `msum init` writes: every option with its default, plus an example schedule and provider. */
export function defaultConfigJson(timezone: string = systemTimezone()): string {
  const config = {
    language: DEFAULT_LANGUAGE,
    timezone,
    excludePatterns: [],
    localOnlyPatterns: [],
    defaultWindowHours: 24,
    maxCharsPerConversation: 24000,
    unreadOnly: false,
    flagUnsaved: false,
    hideRest: false,
    concurrency: DEFAULT_CONCURRENCY,
    // No "schedules": the times of the digests are set with `msum schedule add` (they live in the database).
    provider: {
      // RF-41: there is no default provider. Set "claude-cli" or "ollama" here.
      primary: null,
      backup: null,
      claudeCli: { command: 'claude', model: 'sonnet', timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS },
    },
  }
  return `${JSON.stringify(config, null, 2)}\n`
}
