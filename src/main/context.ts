import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Clock } from '../application/ports/clock.js'
import type { Summarizer } from '../application/ports/summarizer.js'
import { type Catalog, getCatalog } from '../infrastructure/i18n/index.js'
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
}

export const DEFAULT_LINK_TIMING: LinkTiming = {
  connectTimeoutMs: 5 * 60_000,
  minAfterConnectMs: 10_000,
  quietMs: 15_000,
  maxAfterConnectMs: 2 * 60_000,
  pollMs: 500,
}

/** What `doctor` asks of the outside world. Tests replace them. */
export interface DoctorProbes {
  /** The output of `<command> --version`, or null when it could not be run. */
  commandVersion(command: string, env: NodeJS.ProcessEnv): Promise<string | null>
  /** Whether an Ollama server answers at this base URL. */
  ollamaReachable(baseUrl: string): Promise<boolean>
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
  /** Resolves when the process is asked to stop (SIGINT, SIGTERM). */
  waitForShutdown(): Promise<void>
  readonly probes: DoctorProbes
  readonly nodeVersion: string
  readonly linkTiming: LinkTiming
  /** Replaces the configured providers. For tests. */
  readonly summarizer?: Summarizer | null
  readonly daemonTiming?: {
    readonly heartbeatMs?: number
    readonly sweepMs?: number
    readonly missedRunDelayMs?: number
    readonly shutdownGraceMs?: number
    readonly scheduleReloadMs?: number
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

/** "5491100000009@s.whatsapp.net" as "+54*******0009": enough to recognize the account, not to read the number. */
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
