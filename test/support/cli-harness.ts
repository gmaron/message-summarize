import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { CaptureMessages } from '../../src/application/capture-messages.js'
import type { SummarizeRequest, SummarizeResult, Summarizer } from '../../src/application/ports/summarizer.js'
import { ok } from '../../src/domain/result.js'
import type {
  HistorySyncListener,
  HistorySyncProgress,
  WhatsAppSocket,
  WhatsAppStatus,
  WhatsAppStatusListener,
} from '../../src/infrastructure/whatsapp/connection.js'
import { openInstallation } from '../../src/main/accounts.js'
import { type AppConfig, parseConfig } from '../../src/main/config.js'
import {
  type CommandContext,
  DEFAULT_LINK_TIMING,
  type DoctorProbes,
  type WebOverrides,
} from '../../src/main/context.js'
import { createLogger } from '../../src/main/logger.js'
import { type AccountLayout, accountLayoutOf, ensureDataDirs, layoutOf } from '../../src/main/paths.js'
import { createRuntime, type Runtime } from '../../src/main/runtime.js'
import type { ConnectionHooks, ManagedConnection } from '../../src/main/whatsapp.js'

export const ME = '5491100000009@s.whatsapp.net'
export const OTHER = '5491100000077@s.whatsapp.net'
export const BA = 'America/Argentina/Buenos_Aires'
/** 2026-11-17 12:00 in Buenos Aires. */
export const NOW = Date.parse('2026-11-17T15:00:00Z')

/** A WhatsApp connection under the test's control: it says what the adapter would say, and records what it was asked. */
export class FakeConnection implements ManagedConnection {
  status: WhatsAppStatus = { state: 'stopped' }
  user: { id: string; lid?: string } | undefined = { id: ME }
  sendFails = false
  readonly sent: string[] = []
  readonly calls: string[] = []
  hooks: ConnectionHooks | null = null
  /** What happens when `start()` is called (the test decides: show a QR, connect...). */
  onStart: () => void | Promise<void> = () => {}
  /** What happens when `stop()` is called, before it finishes (the test can hold it: a socket that closes slowly). */
  onStop: () => void | Promise<void> = () => {}
  private readonly listeners = new Set<WhatsAppStatusListener>()
  private readonly historyListeners = new Set<HistorySyncListener>()

  /**
   * A new unit starts from a clean status. This object is reused by every unit of a test, so the status a previous one
   * left (loggedOut, error, qr) would be fed to the next as if it had just happened. While some unit is still listening
   * the status is the live one and stays.
   */
  freshStatus(): void {
    if (this.listeners.size === 0) this.status = { state: 'stopped' }
  }

  emit(status: WhatsAppStatus): void {
    this.status = status
    for (const listener of [...this.listeners]) listener(status)
  }

  onStatus(listener: WhatsAppStatusListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emitHistory(progress: HistorySyncProgress): void {
    for (const listener of [...this.historyListeners]) listener(progress)
  }

  onHistorySync(listener: HistorySyncListener): () => void {
    this.historyListeners.add(listener)
    return () => {
      this.historyListeners.delete(listener)
    }
  }

  selfChat(): Pick<WhatsAppSocket, 'user' | 'sendTextToSelf'> | null {
    if (this.status.state !== 'connected') return null
    return {
      user: this.user,
      sendTextToSelf: async (text) => {
        if (this.sendFails) throw new Error('send failed')
        this.sent.push(text)
      },
    }
  }

  async start(): Promise<void> {
    this.calls.push('start')
    await this.onStart()
  }

  async stop(): Promise<void> {
    this.calls.push('stop')
    await this.onStop()
    if (this.status.state !== 'stopped') this.emit({ state: 'stopped' })
  }

  async clearSession(): Promise<void> {
    this.calls.push('clearSession')
  }

  /** The ids of one person the "platform" knows (LID and phone number), as `[a, b]`. */
  readonly aliasPairs: [string, string][] = []
  private readonly aliasListeners = new Set<(a: string, b: string) => void | Promise<void>>()

  onAlias(listener: (a: string, b: string) => void | Promise<void>): () => void {
    this.aliasListeners.add(listener)
    return () => {
      this.aliasListeners.delete(listener)
    }
  }

  knownAliases(): [string, string][] {
    return [...this.aliasPairs]
  }

  async aliasesOf(id: string): Promise<string[]> {
    return this.aliasPairs.flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : []))
  }

  /** The platform learns that `a` and `b` are the same person; like the adapter, the listeners finish before it goes on. */
  async learnAlias(a: string, b: string): Promise<void> {
    this.aliasPairs.push([a, b])
    for (const listener of [...this.aliasListeners]) await listener(a, b)
  }

  /** Where the events of the socket go while it is open: the capture use case. */
  capture: CaptureMessages | null = null

  /**
   * An event of the socket. A stopped connection (or one with no capture) delivers nothing, as the real adapter, which
   * detaches from the socket when it stops. Returns whether the event reached the capture.
   */
  async receive(event: Parameters<CaptureMessages['receiveMessage']>[0]): Promise<boolean> {
    if (this.status.state === 'stopped' || this.capture === null) return false
    await this.capture.receiveMessage(event)
    return true
  }
}

export const SUMMARY = {
  resumen: 'Ana asks about the plan',
  pendientes: ['reply'],
  necesita_respuesta: true,
  prioridad: 'alta',
}

/** A summarizer that records its requests and answers with a valid summary. */
export class FakeSummarizer implements Summarizer {
  readonly requests: SummarizeRequest[] = []
  constructor(private readonly answer: () => Promise<SummarizeResult> | SummarizeResult = () => ok(SUMMARY)) {}
  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    this.requests.push(request)
    return this.answer()
  }
}

export interface HarnessOptions {
  /** config.json contents: an object (written as JSON), a string (written as is), or null for no file. */
  readonly config?: Record<string, unknown> | string | null
  readonly summarizer?: Summarizer | null
  /** The answer to the confirmation question. Default yes. */
  readonly confirm?: boolean
  /** What `readSecret` reads (an API key typed or piped). Default: nothing. */
  readonly secretInput?: string
  /** The environment the commands see. Default: empty. */
  readonly env?: NodeJS.ProcessEnv
  readonly probes?: Partial<DoctorProbes>
  readonly now?: number
  /** The clock follows `Date.now()` (for tests with fake timers) instead of staying at `now`. */
  readonly liveClock?: boolean
  readonly stdoutLogs?: boolean
  /** The accounts that exist before the command runs (directories and records). Default: just "default". */
  readonly accounts?: readonly string[]
  /** How the daemon starts the web. Default: a free port on 127.0.0.1 (never the configured one: tests run in parallel). */
  readonly web?: WebOverrides
  /** What opening the browser does. Default: it succeeds. */
  readonly openUrl?: (url: string) => Promise<void>
}

export const BASE_CONFIG = {
  language: 'en',
  timezone: BA,
  schedules: [],
  provider: { primary: 'claude-cli' },
}

export interface Harness {
  readonly dir: string
  readonly layout: ReturnType<typeof layoutOf>
  /** The paths of the first account of the harness ("default" unless `accounts` says otherwise). */
  readonly account: AccountLayout
  /** The paths of any account id. */
  accountOf(id: string): AccountLayout
  readonly ctx: CommandContext
  readonly connection: FakeConnection
  readonly summarizer: FakeSummarizer
  readonly out: string[]
  readonly err: string[]
  /** Everything the structured logger wrote, as one string per line (stdout and stderr together). */
  readonly logs: string[]
  readonly questions: string[]
  /** The addresses `msum open` asked the browser to open. */
  readonly browserOpened: string[]
  readonly clock: { time: number; now(): number }
  /** The validated configuration the harness wrote (defaults applied). */
  config(): AppConfig
  /** A runtime on an account's database (the first one by default). The caller closes it. */
  runtime(id?: string): Runtime
  /** Pretends a SIGINT arrived. */
  shutdown(): void
  dispose(): void
}

const dirs: string[] = []

/** A data directory in a temp folder, with a config, a fake connection and a context to run commands in. */
export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'msum-test-'))
  dirs.push(dir)
  const layout = layoutOf(join(dir, 'data'))
  mkdirSync(layout.dataDir, { recursive: true })
  await ensureDataDirs(layout)
  const config = options.config === undefined ? BASE_CONFIG : options.config
  if (config !== null) {
    writeFileSync(layout.configFile, typeof config === 'string' ? config : JSON.stringify(config), { mode: 0o600 })
  }

  const accountIds = options.accounts ?? ['default']
  const clockAt = options.now ?? NOW
  const opened = await openInstallation({ layout, clock: { now: () => clockAt } })
  if (!opened.ok) throw new Error('the harness could not open the installation')
  for (const id of accountIds) await opened.installation.createAccount(id)
  opened.installation.close()
  const firstId = accountIds[0] ?? 'default'

  const out: string[] = []
  const err: string[] = []
  const logs: string[] = []
  const questions: string[] = []
  const browserOpened: string[] = []
  const clock = { time: options.now ?? NOW, now: () => (options.liveClock === true ? Date.now() : clock.time) }
  const connection = new FakeConnection()
  const summarizer = new FakeSummarizer()
  let stop: () => void = () => {}
  const stopped = new Promise<void>((resolve) => {
    stop = resolve
  })
  const sink = { write: (text: string) => logs.push(text) }
  const ctx: CommandContext = {
    env: options.env ?? {},
    layout,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    logger: createLogger(sink, sink, () => clock.time),
    clock,
    connectionFactory: async (_runtime, hooks) => {
      connection.freshStatus()
      connection.hooks = hooks
      return connection
    },
    confirm: async (question) => {
      questions.push(question)
      return options.confirm ?? true
    },
    readSecret: async (prompt) => {
      questions.push(prompt)
      return options.secretInput ?? ''
    },
    waitForShutdown: () => stopped,
    probes: {
      commandVersion: async () => '1.0.0 (fake)',
      commandProbe: async () => ({ started: true, ok: true, line: '1.0.0 (fake)' }),
      ollamaReachable: async () => true,
      ollamaModels: async () => ok([]),
      verifyCli: async () => ({ ok: true as const, path: '/fake/claude', version: '1.0.0 (fake)' }),
      ...options.probes,
    },
    openUrl: async (url) => {
      browserOpened.push(url)
      await options.openUrl?.(url)
    },
    web: { host: '127.0.0.1', port: 0, ...options.web },
    nodeVersion: '22.16.0',
    linkTiming: {
      ...DEFAULT_LINK_TIMING,
      connectTimeoutMs: 2_000,
      minAfterConnectMs: 0,
      quietMs: 20,
      maxAfterConnectMs: 400,
      pollMs: 5,
    },
    summarizer: options.summarizer === undefined ? summarizer : options.summarizer,
  }

  const parsed = (): AppConfig => {
    const result = parseConfig(typeof config === 'object' && config !== null ? config : {}, BA)
    if (!result.ok) throw new Error(`the harness config is invalid: ${JSON.stringify(result.error)}`)
    return result.value
  }
  return {
    dir,
    layout,
    account: accountLayoutOf(layout, firstId),
    accountOf: (id) => accountLayoutOf(layout, id),
    ctx,
    connection,
    summarizer,
    out,
    err,
    logs,
    questions,
    browserOpened,
    clock,
    config: parsed,
    runtime: (id) =>
      createRuntime({
        layout: accountLayoutOf(layout, id ?? firstId),
        config: parsed(),
        env: {},
        clock,
        summarizer: options.summarizer === undefined ? summarizer : options.summarizer,
      }),
    shutdown: () => stop(),
    dispose: () => removeDir(dir),
  }
}

/** Removes every temp directory the harnesses made. Call it in afterEach. */
export function disposeHarnesses(): void {
  for (const dir of dirs.splice(0)) removeDir(dir)
}

/**
 * Windows refuses to delete a file that is still open (EBUSY, EPERM): a database or a socket that is a few milliseconds
 * away from closing, or something that scans the new file. The standard answer is to try again a few times.
 */
function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

export interface SeedMessage {
  readonly id: string
  readonly text: string
  readonly conversationId?: string
  /** Epoch ms. Default: one hour before NOW. */
  readonly timestamp?: number
  readonly conversationName?: string
}

/** Stores incoming messages through the real capture use case, as the adapter would. */
export async function seedMessages(runtime: Runtime, messages: readonly SeedMessage[]): Promise<void> {
  const capture: CaptureMessages = runtime.capture
  for (const m of messages) {
    const conversationId = m.conversationId ?? '5491100000001@s.whatsapp.net'
    await capture.participantInfo({
      participant: { id: conversationId, savedName: m.conversationName ?? 'Ana Test', publicName: null },
    })
    await capture.conversationMetadata({
      conversation: {
        id: conversationId,
        isGroup: false,
        name: null,
        participantId: conversationId,
        address: '+5491100000001',
      },
    })
    await capture.receiveMessage({
      origin: 'history',
      isGroup: false,
      message: {
        id: m.id,
        conversationId,
        senderId: conversationId,
        senderName: null,
        senderAddress: '+5491100000001',
        fromMe: false,
        timestamp: m.timestamp ?? NOW - 3_600_000,
        kind: 'text',
        text: m.text,
        transcript: null,
        read: false,
      },
    })
  }
}

/** Lets pending promises and zero-delay timers run. */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** How long a test waits for something that really happens in another task or on disk. Generous: a slow machine is not a failure. */
export const WAIT_DEADLINE_MS = 5_000

/**
 * Waits until `predicate` holds, polling, and fails with a clear message after the deadline. Use it instead of a fixed
 * sleep: a sleep is either too short on a loaded machine or wastes time on a fast one.
 */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  what = 'a condition',
  deadlineMs = WAIT_DEADLINE_MS,
): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(`timed out after ${deadlineMs} ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** `vi.waitFor` with the generous deadline (its default is one second). */
export const waitFor = <T>(assertion: () => T | Promise<T>): Promise<T> =>
  vi.waitFor(assertion, { timeout: WAIT_DEADLINE_MS, interval: 10 })
