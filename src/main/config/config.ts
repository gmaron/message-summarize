import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DEFAULT_CONCURRENCY } from '../../application/generate-digest.js'
import { type AskHint, MAX_ASK_HINT_TERMS, MAX_ASK_HINT_TEXT_CHARS, MAX_ASK_HINTS } from '../../domain/ask-hints.js'
import { type AskPreset, askPresetIssue, MAX_ASK_PRESETS } from '../../domain/ask-presets.js'
import { exactIdOf } from '../../domain/exclusion.js'
import { err, ok, type Result } from '../../domain/result.js'
import { type DigestSettings, parseDigestSettings, type SettingsIssueCode } from '../../domain/settings.js'
import type { Catalog, Language } from '../../infrastructure/i18n/index.js'
import { LANGUAGES } from '../../infrastructure/i18n/index.js'
import {
  ANTHROPIC_EFFORTS,
  type AnthropicEffort,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  DEFAULT_MAX_TOTAL_MS,
  DEFAULT_RETRY_BUDGET,
  OPENAI_BASE_URL,
  type StructuredOutputMode,
} from '../../infrastructure/llm/api/index.js'
import { genericCommandProblem } from '../../infrastructure/llm/cli/index.js'
import { isValidTimezone } from '../../infrastructure/scheduling/croner-scheduler.js'
import { DEFAULT_TRANSCRIPTION_TIMEOUT_MS, LANGUAGE_PATTERN } from '../../infrastructure/transcription/index.js'

export const PROVIDERS = [
  'claude-cli',
  'gemini-cli',
  'codex-cli',
  'generic-cli',
  'ollama',
  'openai',
  'anthropic',
  'gemini',
] as const
export type ProviderKind = (typeof PROVIDERS)[number]
/** The providers that call an HTTP API with a key. They are external: "local only" chats never reach them (RF-43). */
export const API_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const
export type ApiProviderKind = (typeof API_PROVIDERS)[number]
/** True when the primary or the backup is the generic CLI, which gets a warning wherever it is about to run (RF-49). */
export const usesGenericCli = (config: { readonly provider: Pick<ProviderConfig, 'primary' | 'backup'> }): boolean =>
  config.provider.primary === 'generic-cli' || config.provider.backup === 'generic-cli'
export const isApiProvider = (kind: ProviderKind): kind is ApiProviderKind =>
  (API_PROVIDERS as readonly string[]).includes(kind)
const STRUCTURED_OUTPUT_MODES = [
  'json_schema',
  'json_object',
  'prompt',
] as const satisfies readonly StructuredOutputMode[]

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

/**
 * The API providers have no default model (model names change often: a stale default would fail later), so `model` is
 * required when one is used. The key is never here: it goes in secrets.json or the environment (RNF-04).
 */
export interface OpenAiConfig {
  /** Any server with the Chat Completions API (LM Studio, OpenRouter...). */
  readonly baseUrl: string
  readonly model: string | null
  readonly timeoutMs: number
  readonly structuredOutput: StructuredOutputMode
}

export interface AnthropicConfig {
  readonly model: string | null
  readonly timeoutMs: number
  readonly maxTokens: number
  /** Null: the model default. */
  readonly effort: AnthropicEffort | null
}

export interface GeminiConfig {
  readonly model: string | null
  readonly timeoutMs: number
}

/** RF-46: what one call may wait for a rate limit, per conversation. Shared by the API providers. */
export interface RetryConfig {
  readonly maxRetries: number
  readonly maxWaitMs: number
  /** The deadline of the whole call, attempts and waits together. */
  readonly maxTotalMs: number
}

/**
 * `gemini-cli` and `codex-cli` are shipped disabled (RF-49: their documentation offers no way to run them without tools
 * that can be verified), so the section only holds what a future enabled preset needs. `doctor` says they are disabled.
 */
export interface VendorCliConfig {
  readonly command: string
  readonly model: string | null
  readonly timeoutMs: number
}

/** RF-47, generic mode: any command that takes the prompt and prints text. Refused unless the risk is acknowledged. */
export interface GenericCliConfig {
  /** The program and its arguments, with no shell. `{{prompt}}` as a whole element receives the prompt; else stdin. */
  readonly command: readonly string[] | null
  readonly timeoutMs: number
  /** True when the user accepted that the command may run tools on text written by third parties. */
  readonly acknowledgeRisk: boolean
}

export interface ProviderConfig {
  /** Null until the user chooses one (RF-41: there is no default provider). */
  readonly primary: ProviderKind | null
  readonly backup: ProviderKind | null
  readonly claudeCli: ClaudeCliConfig
  readonly ollama: OllamaConfig
  readonly openai: OpenAiConfig
  readonly anthropic: AnthropicConfig
  readonly gemini: GeminiConfig
  readonly retry: RetryConfig
  readonly geminiCli: VendorCliConfig
  readonly codexCli: VendorCliConfig
  readonly genericCli: GenericCliConfig
}

/**
 * Local transcription of audios (RF-15, RF-20..23). Off by default. Turning it on with the program or the model missing is
 * not an error: the audios stay untranscribed and `doctor` says what is missing (RF-21).
 */
export interface TranscriptionConfig {
  readonly enabled: boolean
  /** The whisper.cpp program. */
  readonly whisperCommand: string
  /** Converts the audio before whisper reads it. */
  readonly ffmpegCommand: string
  /** A path to a ggml model, or the name of one in the models directory of the installation (`base`, `small.en`...). */
  readonly model: string | null
  /** `auto` detects the language of each audio; otherwise an ISO 639 code such as `es` (RF-23). */
  readonly language: string
  /** Total time for one audio. */
  readonly timeoutMs: number
  /**
   * RF-15: audios of the history sync from the last N days are downloaded too (older ones stay untranscribed). 0 means no
   * limit: every audio of the history is downloaded and transcribed.
   */
  readonly historyAudioDays: number
  /** Transcriptions that run at once, each one a separate whisper process (1..16, default 1). */
  readonly concurrency: number
  /** Threads (`-t`) of each whisper process (1..64, default 1). Together with `concurrency`: the CPUs used. */
  readonly threads: number
  /** Audio downloads that run at once (1..16, default 2). */
  readonly downloadConcurrency: number
  /** The most the downloaded audios of an account may take together, in MB. Past it new downloads are refused. */
  readonly maxMediaMb: number
}

/**
 * Reading the text of images (opt-in). Unlike the audio, THE IMAGE LEAVES THIS MACHINE: a model with vision reads it, and that
 * is the CLI provider (`provider.claudeCli`, today the only one that is supported). So it is off by default, an image of a
 * conversation in `localOnlyPatterns` is never read, and `doctor` says what is sent. The text goes where "[image]" shows
 * in digests and Ask; the picture is deleted as soon as it is read.
 */
export interface ImageReadingConfig {
  readonly enabled: boolean
  /** Images of the history sync from the last N days are read too (older ones stay "[image]"). 0: no limit. Default 7. */
  readonly historyDays: number
  /** Total time for one image. */
  readonly timeoutMs: number
}

export const DEFAULT_IMAGE_READING: ImageReadingConfig = { enabled: false, historyDays: 7, timeoutMs: 180_000 }

/** The local web (RNF-03). Only the installation's config.json sets it: an account cannot. */
export interface WebConfig {
  readonly enabled: boolean
  /** "127.0.0.1" by default. Any other address is the explicit opt-in to expose the web beyond this machine. */
  readonly host: string
  readonly port: number
  /**
   * Names a reverse proxy reaches the web by (a Tailscale name, for example), accepted as the `Host` even without a
   * port. Empty by default: only IP addresses and the loopback names are accepted. The token is still required.
   */
  readonly allowedHosts: readonly string[]
}

export const DEFAULT_WEB: WebConfig = { enabled: true, host: '127.0.0.1', port: 8787, allowedHosts: [] }

/** The daemon's log files (RNF-12). Only the installation's config.json sets it: an account cannot. */
export interface LogsConfig {
  /** The most the log files may take together, in bytes (two files of half of it each, see `log-file.ts`). */
  readonly maxBytes: number
}

export const MIN_LOG_BYTES = 1_048_576
export const DEFAULT_LOGS: LogsConfig = { maxBytes: 52_428_800 }

/** The validated contents of config.json. A missing option has its default (RF-73). */
export interface AppConfig {
  readonly language: Language
  /** IANA name. Dates in the digest and the schedules use it. */
  readonly timezone: string
  readonly digest: DigestSettings
  readonly localOnlyPatterns: readonly string[]
  /** Context of the owner added to the prompt of an Ask when the question mentions its words (never to the digest). */
  readonly askHints: readonly AskHint[]
  /** Requests the owner saved for the Ask tab. Empty: the web offers the defaults of the language. The account's replace the installation's. */
  readonly askPresets: readonly AskPreset[]
  /** Path of a custom prompt template, read on every digest (RF-38). */
  readonly promptFile: string | null
  readonly concurrency: number
  /**
   * Opt-in, owner-approved exception to RNF-17: link with `syncFullHistory: true`, so the phone sends its whole history
   * when the device is linked (it only affects what history arrives at link time). Default false.
   */
  readonly fullHistoryOnLink: boolean
  /** Cron expressions (RF-60). */
  readonly schedules: readonly string[]
  readonly provider: ProviderConfig
  readonly transcription: TranscriptionConfig
  readonly imageReading: ImageReadingConfig
  readonly web: WebConfig
  readonly logs: LogsConfig
}

export type ConfigIssueCode =
  | SettingsIssueCode
  | 'invalidLanguage'
  | 'invalidJson'
  | 'unknownOption'
  | 'notOneOf'
  | 'required'
  | 'invalidTimezone'
  /** An API key written in config.json, which must not hold secrets. */
  | 'secretInConfig'
  /** `provider.genericCli.command` has no program, a placeholder as the program, or one inside an element. */
  | 'invalidCommandTemplate'
  | 'invalidPort'
  /** An entry of `web.allowedHosts` that is not a bare host name (a scheme, a port, a path or a space). */
  | 'invalidHostName'
  /** A number under the smallest accepted (`logs.maxBytes`). */
  | 'belowMinimum'
  /** A whole number outside its limits; `allowed` holds the smallest and the largest. */
  | 'outOfRange'
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
  'askHints',
  'askPresets',
  'promptFile',
  'concurrency',
  'fullHistoryOnLink',
  'schedules',
  'provider',
  'transcription',
  'imageReading',
  'web',
  'logs',
])
const IMAGE_READING_KEYS = new Set(['enabled', 'historyDays', 'timeoutMs'])
const TRANSCRIPTION_KEYS = new Set([
  'enabled',
  'whisperCommand',
  'ffmpegCommand',
  'model',
  'language',
  'timeoutMs',
  'historyAudioDays',
  'maxMediaMb',
  'concurrency',
  'threads',
  'downloadConcurrency',
])
const PROVIDER_KEYS = new Set([
  'primary',
  'backup',
  'claudeCli',
  'geminiCli',
  'codexCli',
  'genericCli',
  'ollama',
  'openai',
  'anthropic',
  'gemini',
  'retry',
])
const GENERIC_CLI_KEYS = new Set(['command', 'timeoutMs', 'acknowledgeRisk'])
const CLAUDE_CLI_KEYS = new Set(['command', 'model', 'timeoutMs'])
const WEB_KEYS = new Set(['enabled', 'host', 'port', 'allowedHosts'])
const LOGS_KEYS = new Set(['maxBytes'])
const OLLAMA_KEYS = new Set(['baseUrl', 'model', 'numCtx', 'keepAlive', 'timeoutMs'])
const OPENAI_KEYS = new Set(['baseUrl', 'model', 'timeoutMs', 'structuredOutput'])
const ANTHROPIC_KEYS = new Set(['model', 'timeoutMs', 'maxTokens', 'effort'])
const GEMINI_KEYS = new Set(['model', 'timeoutMs'])
const RETRY_KEYS = new Set(['maxRetries', 'maxWaitMs', 'maxTotalMs'])
/** Names under which a key could be put in the section of an API provider: refused, with a pointer to `msum secret`. */
const SECRET_KEY_NAMES = ['apiKey', 'api_key', 'apikey', 'key', 'token', 'secret']

/** Options of the installation's config.json that an account's file cannot set. */
const INSTALLATION_ONLY = ['web', 'logs'] as const

/** Lists an account can only add to (see `mergeConfigJson`). */
const UNIONED_LISTS = ['localOnlyPatterns', 'excludePatterns'] as const

export const MAX_TRANSCRIPTION_CONCURRENCY = 16
export const MAX_TRANSCRIPTION_THREADS = 64
export const MAX_DOWNLOAD_CONCURRENCY = 16

export type Obj = Record<string, unknown>
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
  } catch {
    return false
  }
}

/**
 * The address of an API server that gets the API key and the chats: http(s), no credentials in it (they would travel in
 * every request and show in logs) and no fragment. The summarizers never follow redirects.
 */
function isApiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return isHttpUrl(value) && url.username === '' && url.password === '' && url.hash === '' && !value.includes('#')
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
  /** `askHints`: a list of `{ when: [words], text }`. Each problem names the entry, e.g. `askHints[1].when`. */
  const parseAskHints = (): readonly AskHint[] | undefined => {
    const v = input.askHints
    if (v === undefined) return []
    if (!Array.isArray(v)) return add('askHints', 'notArray')
    if (v.length > MAX_ASK_HINTS) return add('askHints', 'tooManyHints')
    const hints: AskHint[] = []
    let valid = true
    v.forEach((entry: unknown, index) => {
      const path = `askHints[${index}]`
      if (!isObject(entry) || Object.keys(entry).some((key) => key !== 'when' && key !== 'text')) {
        valid = false
        add(path, 'invalidHint')
        return
      }
      const { when, text } = entry
      let whenOk = false
      if (!Array.isArray(when) || when.some((t) => typeof t !== 'string')) add(`${path}.when`, 'notStringList')
      else if (when.length === 0 || when.some((t: string) => t.trim() === '')) add(`${path}.when`, 'emptyHintWhen')
      else if (when.length > MAX_ASK_HINT_TERMS) add(`${path}.when`, 'tooManyHintTerms')
      else whenOk = true
      let textOk = false
      if (typeof text !== 'string') add(`${path}.text`, 'notString')
      else if (text.trim() === '') add(`${path}.text`, 'emptyHintText')
      else if (text.length > MAX_ASK_HINT_TEXT_CHARS) add(`${path}.text`, 'hintTextTooLong')
      else textOk = true
      if (whenOk && textOk) hints.push({ when: [...(when as string[])], text: text as string })
      else valid = false
    })
    return valid ? hints : undefined
  }
  /** `askPresets`: a list of `{ name, text }`. Each problem names the entry, e.g. `askPresets[1].name`. */
  const parseAskPresets = (): readonly AskPreset[] | undefined => {
    const v = input.askPresets
    if (v === undefined) return []
    if (!Array.isArray(v)) return add('askPresets', 'notArray')
    if (v.length > MAX_ASK_PRESETS) return add('askPresets', 'tooManyPresets')
    const presets: AskPreset[] = []
    let valid = true
    v.forEach((entry: unknown, index) => {
      const issue = askPresetIssue(entry)
      if (issue === null) {
        const { name, text } = entry as AskPreset
        presets.push({ name: name.trim(), text: text.trim() })
        return
      }
      valid = false
      const field = issue === 'invalidPreset' ? '' : issue.includes('Name') ? '.name' : '.text'
      add(`askPresets[${index}]${field}`, issue)
    })
    return valid ? presets : undefined
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

  /** Like `section`, for an API provider: a key written there is refused (RNF-04) instead of being "an unknown option". */
  const apiSection = (parent: Obj, key: string, path: string, known: Set<string>): Obj => {
    const v = parent[key]
    if (isObject(v)) {
      for (const name of SECRET_KEY_NAMES) if (name in v) add(`${path}.${name}`, 'secretInConfig')
    }
    return section(parent, key, path, new Set([...known, ...SECRET_KEY_NAMES]))
  }
  const nonNegativeInt = (obj: Obj, key: string, path: string, fallback: number): number | undefined => {
    const v = obj[key]
    if (v === undefined) return fallback
    if (typeof v !== 'number') return add(path, 'notNumber')
    if (!Number.isInteger(v)) return add(path, 'notInteger')
    if (v < 0) return add(path, 'notPositive')
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
  const askHints = parseAskHints()
  const askPresets = parseAskPresets()
  const promptFile = text(input, 'promptFile', 'promptFile')
  const concurrency = positiveInt(input, 'concurrency', 'concurrency', DEFAULT_CONCURRENCY)

  const fullHistoryOnLink = ((): boolean | undefined => {
    const v = input.fullHistoryOnLink
    if (v === undefined) return false
    return typeof v === 'boolean' ? v : add('fullHistoryOnLink', 'notBoolean')
  })()

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

  const openaiObj = apiSection(providerObj, 'openai', 'provider.openai', OPENAI_KEYS)
  const openaiBaseUrl = ((): string | null | undefined => {
    const v = text(openaiObj, 'baseUrl', 'provider.openai.baseUrl')
    if (typeof v !== 'string') return v
    return isApiBaseUrl(v) ? v : add('provider.openai.baseUrl', 'invalidUrl')
  })()
  const openaiModel = text(openaiObj, 'model', 'provider.openai.model')
  const openaiTimeout = positiveInt(openaiObj, 'timeoutMs', 'provider.openai.timeoutMs', DEFAULT_PROVIDER_TIMEOUT_MS)
  const openaiStructured = choice(
    openaiObj,
    'structuredOutput',
    'provider.openai.structuredOutput',
    STRUCTURED_OUTPUT_MODES,
  ) as StructuredOutputMode | null | undefined

  const anthropicObj = apiSection(providerObj, 'anthropic', 'provider.anthropic', ANTHROPIC_KEYS)
  const anthropicModel = text(anthropicObj, 'model', 'provider.anthropic.model')
  const anthropicTimeout = positiveInt(
    anthropicObj,
    'timeoutMs',
    'provider.anthropic.timeoutMs',
    DEFAULT_PROVIDER_TIMEOUT_MS,
  )
  const anthropicMaxTokens = positiveInt(
    anthropicObj,
    'maxTokens',
    'provider.anthropic.maxTokens',
    DEFAULT_ANTHROPIC_MAX_TOKENS,
  )
  const anthropicEffort = choice(anthropicObj, 'effort', 'provider.anthropic.effort', ANTHROPIC_EFFORTS) as
    | AnthropicEffort
    | null
    | undefined

  const geminiObj = apiSection(providerObj, 'gemini', 'provider.gemini', GEMINI_KEYS)
  const geminiModel = text(geminiObj, 'model', 'provider.gemini.model')
  const geminiTimeout = positiveInt(geminiObj, 'timeoutMs', 'provider.gemini.timeoutMs', DEFAULT_PROVIDER_TIMEOUT_MS)

  const geminiCliObj = section(providerObj, 'geminiCli', 'provider.geminiCli', CLAUDE_CLI_KEYS)
  const geminiCliCommand = text(geminiCliObj, 'command', 'provider.geminiCli.command')
  const geminiCliModel = text(geminiCliObj, 'model', 'provider.geminiCli.model')
  const geminiCliTimeout = positiveInt(
    geminiCliObj,
    'timeoutMs',
    'provider.geminiCli.timeoutMs',
    DEFAULT_PROVIDER_TIMEOUT_MS,
  )
  const codexCliObj = section(providerObj, 'codexCli', 'provider.codexCli', CLAUDE_CLI_KEYS)
  const codexCliCommand = text(codexCliObj, 'command', 'provider.codexCli.command')
  const codexCliModel = text(codexCliObj, 'model', 'provider.codexCli.model')
  const codexCliTimeout = positiveInt(
    codexCliObj,
    'timeoutMs',
    'provider.codexCli.timeoutMs',
    DEFAULT_PROVIDER_TIMEOUT_MS,
  )

  const genericObj = section(providerObj, 'genericCli', 'provider.genericCli', GENERIC_CLI_KEYS)
  const genericTimeout = positiveInt(
    genericObj,
    'timeoutMs',
    'provider.genericCli.timeoutMs',
    DEFAULT_PROVIDER_TIMEOUT_MS,
  )
  const genericAcknowledged = ((): boolean | undefined => {
    const v = genericObj.acknowledgeRisk
    if (v === undefined) return false
    if (typeof v !== 'boolean') return add('provider.genericCli.acknowledgeRisk', 'notBoolean')
    return v
  })()
  const genericCommand = ((): readonly string[] | null | undefined => {
    const v = genericObj.command
    if (v === undefined) return null
    if (!Array.isArray(v)) return add('provider.genericCli.command', 'notArray')
    if (!v.every((element) => typeof element === 'string')) return add('provider.genericCli.command', 'notStringList')
    if (genericCommandProblem(v as string[]) !== null) {
      return add('provider.genericCli.command', 'invalidCommandTemplate')
    }
    return [...(v as string[])]
  })()

  const retryObj = section(providerObj, 'retry', 'provider.retry', RETRY_KEYS)
  const retryTotal = positiveInt(retryObj, 'maxTotalMs', 'provider.retry.maxTotalMs', DEFAULT_MAX_TOTAL_MS)
  const retryMax = nonNegativeInt(retryObj, 'maxRetries', 'provider.retry.maxRetries', DEFAULT_RETRY_BUDGET.maxRetries)
  const retryWait = nonNegativeInt(
    retryObj,
    'maxWaitMs',
    'provider.retry.maxWaitMs',
    DEFAULT_RETRY_BUDGET.maxTotalWaitMs,
  )

  const transcriptionObj = section(input, 'transcription', 'transcription', TRANSCRIPTION_KEYS)
  const transcriptionEnabled = ((): boolean | undefined => {
    const v = transcriptionObj.enabled
    if (v === undefined) return false
    if (typeof v !== 'boolean') return add('transcription.enabled', 'notBoolean')
    return v
  })()
  const whisperCommand = text(transcriptionObj, 'whisperCommand', 'transcription.whisperCommand')
  const ffmpegCommand = text(transcriptionObj, 'ffmpegCommand', 'transcription.ffmpegCommand')
  const transcriptionModel = text(transcriptionObj, 'model', 'transcription.model')
  const transcriptionLanguage = ((): string | undefined => {
    const v = transcriptionObj.language
    if (v === undefined) return 'auto'
    if (typeof v !== 'string') return add('transcription.language', 'notString')
    if (!LANGUAGE_PATTERN.test(v)) return add('transcription.language', 'invalidLanguage')
    return v
  })()
  const transcriptionTimeout = positiveInt(
    transcriptionObj,
    'timeoutMs',
    'transcription.timeoutMs',
    DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  )
  const rangedInt = (
    obj: Obj,
    key: string,
    path: string,
    fallback: number,
    min: number,
    max: number,
  ): number | undefined => {
    const v = nonNegativeInt(obj, key, path, fallback)
    if (v === undefined) return undefined
    if (v < min || v > max) return add(path, 'outOfRange', [String(min), String(max)])
    return v
  }
  // 0: no limit, the whole history.
  const historyAudioDays = nonNegativeInt(transcriptionObj, 'historyAudioDays', 'transcription.historyAudioDays', 14)
  const transcriptionConcurrency = rangedInt(
    transcriptionObj,
    'concurrency',
    'transcription.concurrency',
    1,
    1,
    MAX_TRANSCRIPTION_CONCURRENCY,
  )
  const transcriptionThreads = rangedInt(
    transcriptionObj,
    'threads',
    'transcription.threads',
    1,
    1,
    MAX_TRANSCRIPTION_THREADS,
  )
  const downloadConcurrency = rangedInt(
    transcriptionObj,
    'downloadConcurrency',
    'transcription.downloadConcurrency',
    2,
    1,
    MAX_DOWNLOAD_CONCURRENCY,
  )
  const maxMediaMb = positiveInt(transcriptionObj, 'maxMediaMb', 'transcription.maxMediaMb', 500)

  const imageObj = section(input, 'imageReading', 'imageReading', IMAGE_READING_KEYS)
  const imageEnabled = ((): boolean | undefined => {
    const v = imageObj.enabled
    if (v === undefined) return DEFAULT_IMAGE_READING.enabled
    return typeof v === 'boolean' ? v : add('imageReading.enabled', 'notBoolean')
  })()
  // 0: no limit, the whole history.
  const imageHistoryDays = nonNegativeInt(
    imageObj,
    'historyDays',
    'imageReading.historyDays',
    DEFAULT_IMAGE_READING.historyDays,
  )
  const imageTimeout = positiveInt(imageObj, 'timeoutMs', 'imageReading.timeoutMs', DEFAULT_IMAGE_READING.timeoutMs)

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

  const webAllowedHosts = ((): readonly string[] | undefined => {
    const v = webObj.allowedHosts
    if (v === undefined) return DEFAULT_WEB.allowedHosts
    if (!Array.isArray(v)) return add('web.allowedHosts', 'notArray')
    if (!v.every((h) => typeof h === 'string')) return add('web.allowedHosts', 'notStringList')
    if (!v.every((h: string) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(h.trim()))) {
      return add('web.allowedHosts', 'invalidHostName')
    }
    return (v as string[]).map((h) => h.trim().toLowerCase())
  })()

  const logsObj = section(input, 'logs', 'logs', LOGS_KEYS)
  const logsMaxBytes = ((): number | undefined => {
    const v = logsObj.maxBytes
    if (v === undefined) return DEFAULT_LOGS.maxBytes
    if (typeof v !== 'number') return add('logs.maxBytes', 'notNumber')
    if (!Number.isInteger(v)) return add('logs.maxBytes', 'notInteger')
    if (v < MIN_LOG_BYTES) return add('logs.maxBytes', 'belowMinimum')
    return v
  })()

  const usesOllama =
    primary === 'ollama' || backup === 'ollama' || (localOnlyPatterns !== undefined && localOnlyPatterns.length > 0)
  if (usesOllama && ollamaModel === null) add('provider.ollama.model', 'required')
  // No API provider has a default model: choosing one without a model is a configuration error, not a failure later.
  const chosen = [primary, backup]
  if (chosen.includes('openai') && openaiModel === null) add('provider.openai.model', 'required')
  if (chosen.includes('anthropic') && anthropicModel === null) add('provider.anthropic.model', 'required')
  if (chosen.includes('gemini') && geminiModel === null) add('provider.gemini.model', 'required')
  // The generic CLI has no default command: the user brings it. (The acknowledgment is checked when it runs, and by
  // `doctor`, so that `doctor` can show the warning instead of the configuration being refused whole.)
  if (chosen.includes('generic-cli') && genericCommand === null) add('provider.genericCli.command', 'required')

  if (
    issues.length > 0 ||
    !settings.ok ||
    language === undefined ||
    timezone === undefined ||
    localOnlyPatterns === undefined ||
    askHints === undefined ||
    askPresets === undefined ||
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
    openaiBaseUrl === undefined ||
    openaiModel === undefined ||
    openaiTimeout === undefined ||
    openaiStructured === undefined ||
    anthropicModel === undefined ||
    anthropicTimeout === undefined ||
    anthropicMaxTokens === undefined ||
    anthropicEffort === undefined ||
    geminiModel === undefined ||
    geminiTimeout === undefined ||
    retryMax === undefined ||
    retryTotal === undefined ||
    retryWait === undefined ||
    geminiCliCommand === undefined ||
    geminiCliModel === undefined ||
    geminiCliTimeout === undefined ||
    codexCliCommand === undefined ||
    codexCliModel === undefined ||
    codexCliTimeout === undefined ||
    genericTimeout === undefined ||
    genericAcknowledged === undefined ||
    genericCommand === undefined ||
    fullHistoryOnLink === undefined ||
    transcriptionEnabled === undefined ||
    whisperCommand === undefined ||
    ffmpegCommand === undefined ||
    transcriptionModel === undefined ||
    transcriptionLanguage === undefined ||
    transcriptionTimeout === undefined ||
    historyAudioDays === undefined ||
    transcriptionConcurrency === undefined ||
    transcriptionThreads === undefined ||
    downloadConcurrency === undefined ||
    maxMediaMb === undefined ||
    imageEnabled === undefined ||
    imageHistoryDays === undefined ||
    imageTimeout === undefined ||
    webEnabled === undefined ||
    webHost === undefined ||
    webPort === undefined ||
    webAllowedHosts === undefined ||
    logsMaxBytes === undefined
  ) {
    return err(issues)
  }
  return ok({
    language,
    timezone,
    digest: settings.value,
    localOnlyPatterns,
    askHints,
    askPresets,
    promptFile,
    concurrency,
    fullHistoryOnLink,
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
      openai: {
        baseUrl: openaiBaseUrl ?? OPENAI_BASE_URL,
        model: openaiModel,
        timeoutMs: openaiTimeout,
        structuredOutput: openaiStructured ?? 'json_schema',
      },
      anthropic: {
        model: anthropicModel,
        timeoutMs: anthropicTimeout,
        maxTokens: anthropicMaxTokens,
        effort: anthropicEffort ?? null,
      },
      gemini: { model: geminiModel, timeoutMs: geminiTimeout },
      retry: { maxRetries: retryMax, maxWaitMs: retryWait, maxTotalMs: retryTotal },
      geminiCli: { command: geminiCliCommand ?? 'gemini', model: geminiCliModel, timeoutMs: geminiCliTimeout },
      codexCli: { command: codexCliCommand ?? 'codex', model: codexCliModel, timeoutMs: codexCliTimeout },
      genericCli: { command: genericCommand, timeoutMs: genericTimeout, acknowledgeRisk: genericAcknowledged },
    },
    transcription: {
      enabled: transcriptionEnabled,
      whisperCommand: whisperCommand ?? 'whisper-cli',
      ffmpegCommand: ffmpegCommand ?? 'ffmpeg',
      model: transcriptionModel,
      language: transcriptionLanguage,
      timeoutMs: transcriptionTimeout,
      historyAudioDays,
      maxMediaMb,
      concurrency: transcriptionConcurrency,
      threads: transcriptionThreads,
      downloadConcurrency,
    },
    imageReading: { enabled: imageEnabled, historyDays: imageHistoryDays, timeoutMs: imageTimeout },
    web: { enabled: webEnabled, host: webHost ?? DEFAULT_WEB.host, port: webPort, allowedHosts: webAllowedHosts },
    logs: { maxBytes: logsMaxBytes },
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
    for (const key of [
      'claudeCli',
      'geminiCli',
      'codexCli',
      'genericCli',
      'ollama',
      'openai',
      'anthropic',
      'gemini',
      'retry',
    ]) {
      const baseSection = baseProvider[key]
      const overrideSection = overrideProvider[key]
      if (isObject(baseSection) && isObject(overrideSection)) provider[key] = { ...baseSection, ...overrideSection }
    }
    merged.provider = provider
  }
  const baseTranscription = base.transcription
  const overrideTranscription = overrides.transcription
  if (isObject(baseTranscription) && isObject(overrideTranscription)) {
    merged.transcription = { ...baseTranscription, ...overrideTranscription }
  }
  const baseImages = base.imageReading
  const overrideImages = overrides.imageReading
  if (isObject(baseImages) && isObject(overrideImages)) merged.imageReading = { ...baseImages, ...overrideImages }
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
  // The web and the logs belong to the installation (one server and one daemon for every account): an account file
  // cannot configure them.
  if (accountFile !== null) {
    const found = INSTALLATION_ONLY.filter((option) => option in account)
    if (found.length > 0) return err(found.map((option) => ({ option, code: 'installationOnly', file: accountFile })))
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
    case 'invalidLanguage':
      return texts.invalidLanguage(issue.option)
    case 'secretInConfig':
      return texts.secretInConfig(issue.option)
    case 'invalidCommandTemplate':
      return texts.invalidCommandTemplate(issue.option)
    case 'invalidPort':
      return texts.invalidPort(issue.option)
    case 'invalidHostName':
      return texts.invalidHostName(issue.option)
    case 'belowMinimum':
      return texts.belowMinimum(issue.option)
    case 'outOfRange':
      return texts.outOfRange(issue.option, issue.allowed?.[0] ?? '1', issue.allowed?.[1] ?? '')
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
    askHints: [],
    askPresets: [],
    defaultWindowHours: 24,
    maxCharsPerConversation: 24000,
    unreadOnly: false,
    flagUnsaved: false,
    hideRest: false,
    concurrency: DEFAULT_CONCURRENCY,
    // Opt-in (RNF-17 exception): ask the phone for its whole history when the account is linked. See docs/guides.
    fullHistoryOnLink: false,
    // No "schedules": the times of the digests are set with `msum schedule add` (they live in the database).
    provider: {
      // RF-41: there is no default provider. Set "claude-cli", "ollama", "openai", "anthropic" or "gemini" here. The
      // API providers need "provider.<name>.model" (no default) and a key saved with `msum secret set <name>`: keys
      // never go in this file.
      primary: null,
      backup: null,
      claudeCli: { command: 'claude', model: 'sonnet', timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS },
    },
    // Local transcription of audios (off). To turn it on: `msum whisper download base`, then set "enabled": true and
    // "model": "base" (see docs/guides/transcription.md).
    transcription: { enabled: false, whisperCommand: 'whisper-cli', ffmpegCommand: 'ffmpeg', language: 'auto' },
  }
  return `${JSON.stringify(config, null, 2)}\n`
}
