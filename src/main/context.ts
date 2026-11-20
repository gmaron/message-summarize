import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Clock } from '../application/ports/clock.js'
import type { ServiceInstaller } from '../application/ports/service-installer.js'
import type { Summarizer } from '../application/ports/summarizer.js'
import type { Transcriber } from '../application/ports/transcriber.js'
import type { Result } from '../domain/result.js'
import { type Catalog, getCatalog } from '../infrastructure/i18n/index.js'
import type { CliVerification } from '../infrastructure/llm/index.js'
import type { WhisperModel } from '../infrastructure/transcription/index.js'
import type { CliIo } from '../interfaces/cli/run.js'
import { type AppConfig, describeConfigIssue, languageHint, loadEffectiveConfig } from './config.js'
import type { Logger } from './logger.js'
import type { AccountLayout, DataLayout } from './paths.js'
import type { Runtime } from './runtime.js'
import type { ConnectionFactory } from './whatsapp.js'

/** How long `link` waits, in real time. */
export interface LinkTiming {
  /** For the QR to be scanned and the connection to open. */
  readonly connectTimeoutMs: number
  /** After connecting: at least this long for the history to start arriving... */
  readonly minAfterConnectMs: number
  /** ...then until nothing was captured for this long... */
  readonly quietMs: number
  /** ...but never longer than this after connecting. */
  readonly maxAfterConnectMs: number
  readonly pollMs: number
  /** The web shows the progress of the initial sync at most this often. Default 500. */
  readonly syncPublishMs?: number
}

export const DEFAULT_LINK_TIMING: LinkTiming = {
  connectTimeoutMs: 5 * 60_000,
  minAfterConnectMs: 10_000,
  quietMs: 15_000,
  maxAfterConnectMs: 2 * 60_000,
  pollMs: 500,
}

/** What running `<command> <arguments>` for a probe said. */
export interface CommandProbe {
  /** False when the program could not be started (it is not installed, or not executable). */
  readonly started: boolean
  /** True when it exited with code 0. */
  readonly ok: boolean
  /** The first non-empty line of what it printed (standard output, else standard error), or null. */
  readonly line: string | null
}

/** What `doctor` asks of the outside world. Tests replace them. */
export interface DoctorProbes {
  /** The output of `<command> --version`, or null when it could not be run. */
  commandVersion(command: string, env: NodeJS.ProcessEnv): Promise<string | null>
  /** Runs `<command> <args>` and reports how it went. For programs that have no `--version` (whisper.cpp). */
  commandProbe(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CommandProbe>
  /**
   * RF-49: whether this Claude Code can be run without tools. Runs `<command> --help` (never a model call) and checks
   * that every flag of the hardening is listed.
   */
  verifyCli(command: string, env: NodeJS.ProcessEnv): Promise<CliVerification>
  /** Whether an Ollama server answers at this base URL. */
  ollamaReachable(baseUrl: string): Promise<boolean>
  /** The names of the models that Ollama server has (`/api/tags`, short timeout), or why they could not be read. */
  ollamaModels(baseUrl: string): Promise<Result<string[], string>>
}

/** What the daemon uses to start the local web, over the configuration. For tests: they ask for a free port. */
export interface WebOverrides {
  readonly host?: string
  /** 0 asks the system for a free port. */
  readonly port?: number
  /** Where the built web is. Default: `web/` next to the compiled code. */
  readonly staticDir?: string
  readonly heartbeatMs?: number
  /** The least time between two `log` events of the web. For tests. */
  readonly logEventMs?: number
  /** The most a "test the connection" call of the setup wizard waits, at most its usual limit. For tests. */
  readonly providerTestTimeoutMs?: number
}

/** Everything the commands need from the outside. The composition root builds it; tests build their own. */
export interface CommandContext {
  readonly env: NodeJS.ProcessEnv
  readonly layout: DataLayout
  readonly io: CliIo
  readonly logger: Logger
  readonly clock: Clock
  readonly connectionFactory: ConnectionFactory
  /** Asks a yes/no question. Without a terminal it answers no. */
  confirm(question: string): Promise<boolean>
  /**
   * Reads a secret (an API key) from the input: on a terminal the typing is not echoed and `prompt` is shown; piped, the
   * whole input is read. Never from the arguments (`ps`, shell history). Returns what was read, possibly empty.
   */
  readSecret(prompt: string): Promise<string>
  /** Resolves when the process is asked to stop (SIGINT, SIGTERM). */
  waitForShutdown(): Promise<void>
  readonly probes: DoctorProbes
  /** Opens an address in the user's browser (`msum open`). Tests replace it: nothing is spawned. */
  openUrl(url: string): Promise<void>
  readonly nodeVersion: string
  readonly linkTiming: LinkTiming
  /** Replaces the configured providers. For tests. */
  readonly summarizer?: Summarizer | null
  /** Replaces the transcriber built from the configuration (null: none). For tests. */
  readonly transcriber?: Transcriber | null
  /** How long `msum digest` waits for pending audios and how often it looks while observing a daemon. For tests. */
  readonly transcriptionTiming?: { readonly waitMs?: number; readonly pollMs?: number }
  /**
   * Other hosts for the providers that have a fixed one, for `msum provider test`. For tests, which point them at fake
   * servers: the product only ever contacts the real hosts (RNF-01).
   */
  readonly providerBaseUrls?: { readonly anthropic?: string; readonly gemini?: string }
  /** Replaces `fetch` for the download of whisper models and of Ollama models, so tests never reach the network. */
  readonly fetch?: typeof fetch
  /** Replaces the RAM of this machine (`os.totalmem()`) for `msum ollama recommend`. For tests. */
  readonly totalMemBytes?: number
  /** Replaces the table of pinned whisper models (sizes and checksums). For tests, which cannot produce a 77 MB file. */
  readonly whisperModels?: readonly WhisperModel[]
  /** Called right after `link`, `unlink`, `retry` or `import` takes the lock of an account. For tests: they widen that window. */
  readonly afterLock?: () => void | Promise<void>
  /** Called after each step of an import (session, database, config, built, renamed). For tests: they interrupt it. */
  readonly afterImportStep?: (step: 'session' | 'database' | 'config' | 'built' | 'renamed') => void | Promise<void>
  /**
   * Replaces what `msum service` talks to and what it registers. For tests: they give a fake installer and an entry
   * point, so no launchd, systemd or registry is touched.
   */
  readonly service?: {
    readonly installer?: ServiceInstaller
    /** The program and the script that start the CLI, without `daemon`: `[node, cli.js]`. */
    readonly entry?: readonly string[]
  }
  readonly web?: WebOverrides
  readonly daemonTiming?: {
    readonly heartbeatMs?: number
    readonly sweepMs?: number
    readonly missedRunDelayMs?: number
    readonly shutdownGraceMs?: number
    readonly scheduleReloadMs?: number
    readonly unitBackoffMs?: number
    readonly unitBackoffMaxMs?: number
    readonly unitStableMs?: number
    readonly unitMaxFailures?: number
  }
}

export interface LoadedConfig {
  readonly config: AppConfig
  readonly catalog: Catalog
}

/**
 * Loads the configuration a command runs with: the installation's config.json, merged with the account's when there
 * is an account. When it is invalid, prints every problem (file, option and reason, in the user's language, RF-73) to
 * stderr and returns null: the command stops.
 */
export async function loadConfigOrReport(
  ctx: CommandContext,
  account: AccountLayout | null = null,
): Promise<LoadedConfig | null> {
  const accountFile = account?.configFile ?? null
  const loaded = await loadEffectiveConfig(ctx.layout.configFile, accountFile)
  if (loaded.ok) return { config: loaded.value, catalog: getCatalog(loaded.value.language) }
  const catalog = getCatalog(await languageHint(ctx.layout.configFile, accountFile))
  ctx.io.err(catalog.cli.config.heading)
  for (const issue of loaded.error) ctx.io.err(`  - ${describeConfigIssue(catalog, issue)}`)
  return null
}

/**
 * True when the session holds REGISTERED credentials: `creds.json` with a `me` (the linked account). A directory with
 * files from a link that was interrupted before the phone confirmed it is not a session.
 */
export async function hasSession(account: Pick<AccountLayout, 'authDir'>): Promise<boolean> {
  try {
    const creds = JSON.parse(await readFile(join(account.authDir, 'creds.json'), 'utf8')) as { me?: unknown }
    return typeof creds.me === 'object' && creds.me !== null
  } catch {
    return false
  }
}

/** "9963667784458@s.whatsapp.net" as "+99*******4458": enough to recognize the account, not to read the number. */
export function maskAccount(jid: string): string {
  const digits = jid.split('@')[0]?.replace(/\D/g, '') ?? ''
  if (digits.length <= 6) return '+******'
  return `+${digits.slice(0, 2)}${'*'.repeat(digits.length - 6)}${digits.slice(-4)}`
}

export function formatInstant(epochMs: number, catalog: Catalog, timeZone: string): string {
  return new Intl.DateTimeFormat(catalog.dateLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
    new Date(epochMs),
  )
}

/** Runs `work` with a runtime and always closes the database. */
export async function withRuntime<T>(create: () => Runtime, work: (runtime: Runtime) => Promise<T>): Promise<T> {
  const runtime = create()
  try {
    return await work(runtime)
  } finally {
    runtime.close()
  }
}
