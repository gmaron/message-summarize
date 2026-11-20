import { fileURLToPath } from 'node:url'
import {
  type DigestErrorCode,
  getCatalog,
  LANGUAGES,
  type Language,
  type LinkErrorCode,
} from '../infrastructure/i18n/index.js'
import { EventBus } from '../interfaces/http/events.js'
import { isLoopbackHost } from '../interfaces/http/hosts.js'
import type { Route } from '../interfaces/http/router.js'
import { createWebServer, type WebServer } from '../interfaces/http/web-server.js'
import type { Installation } from './accounts.js'
import { readConfigObject, type WebConfig } from './config.js'
import type { CommandContext } from './context.js'
import type { DaemonHost } from './daemon-host.js'
import type { LogStore } from './log-store.js'
import { errorCode } from './logger.js'
import { PreviewService } from './preview.js'
import { type AccountView, describeAccounts } from './web-accounts.js'
import { removeWebAddress, writeWebAddress } from './web-address.js'
import { conversationRoutes } from './web-conversations.js'
import { digestRoutes } from './web-digest.js'
import { historyRoutes } from './web-history.js'
import { keysRoutes } from './web-keys.js'
import { logRoutes } from './web-logs.js'
import { modelCatalog } from './web-models.js'
import { promptRoutes } from './web-prompt.js'
import { accountCreator, accountRoutes } from './web-routes.js'
import { scheduleRoutes } from './web-schedules.js'
import { settingsRoutes } from './web-settings.js'
import { setupRoutes } from './web-setup.js'
import { ensureWebToken } from './web-token.js'

/**
 * The events the web pushes over SSE, by name. `qr` only says that the QR of a link changed (`seq` counts them): the
 * pairing credential itself is drawn on request by `GET /api/accounts/:id/link/qr.svg`, from memory, never from disk.
 */
export interface WebEvents extends Record<string, unknown> {
  readonly accounts: { readonly accounts: readonly AccountView[] }
  readonly qr: { readonly account: string; readonly seq: number }
  readonly sync: {
    readonly account: string
    readonly chats: number
    readonly messages: number
    /** 0 to 100 when the platform reports the progress of the sync. */
    readonly percent?: number
    readonly done: boolean
  }
  readonly link: { readonly account: string; readonly state: string; readonly error?: LinkErrorCode }
  /** How a digest of an account goes (RF-63, RF-65): the one asked for, the scheduled and the missed. Counts and codes. */
  readonly digest: {
    readonly account: string
    readonly state: 'started' | 'deferred' | 'done' | 'empty' | 'failed' | 'busy'
    readonly summarized?: number
    readonly failed?: number
    readonly parts?: number
    readonly error?: DigestErrorCode
  }
  /** The history of an account has a new entry (RF-74). Says nothing of what it holds: the page asks for it. */
  readonly history: { readonly account: string }
  /** The daemon logged lines (RF-75). `seq` is the newest; the page asks for the lines. At most once a second. */
  readonly log: { readonly seq: number; readonly boot: string }
  /** A preview ended (RF-64). Without its content: that is private, and the page asks for it. */
  readonly preview: {
    readonly account: string
    readonly state: 'done' | 'empty' | 'failed'
    readonly error?: DigestErrorCode
  }
}

/** Where the built web is: `web/` next to the compiled code (`dist/web`). */
const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../web/', import.meta.url))

export interface WebHandle {
  stop(): Promise<void>
}

export interface StartWebOptions {
  readonly ctx: CommandContext
  readonly installation: Installation
  readonly host: DaemonHost
  readonly web: WebConfig
  /** The language of the installation, for what is printed here. */
  readonly language: Language
  /** The daemon's recent log lines (RF-75). Without it `/api/logs` is not served. */
  readonly logs?: LogStore
  /** The least time between two `log` events. Default 1 s. For tests. */
  readonly logEventMs?: number
  /** How long a finished preview is kept in memory. Default 30 minutes. For tests. */
  readonly previewTtlMs?: number
}

/**
 * Starts the local web inside the daemon (RF-01, RNF-03) and wires it to the host: `GET /api/accounts`, the routes that
 * create, link and retry accounts, and an `accounts` event whenever an account changes state (plus the `qr`, `sync` and
 * `link` events of a link in progress). The web must never take the daemon down: when it cannot start
 * (the port is taken, the token cannot be written) it logs `web.failed` with a code, says so, and returns null while
 * the accounts keep running.
 */
export async function startWeb(options: StartWebOptions): Promise<WebHandle | null> {
  const { ctx, installation, host } = options
  const texts = getCatalog(options.language)
  const listenHost = ctx.web?.host ?? options.web.host
  const listenPort = ctx.web?.port ?? options.web.port
  const source = { ctx, installation, host }
  const models = modelCatalog(source)
  const bus = new EventBus<WebEvents>()
  const previews = new PreviewService({
    ctx,
    host,
    onEvent: (event) => bus.publish('preview', event),
    accountStamp: (id) => installation.accounts().find((row) => row.id === id)?.createdAt ?? null,
    ...(options.previewTtlMs === undefined ? {} : { ttlMs: options.previewTtlMs }),
  })
  let publishing = false
  let again = false
  const publishAccounts = async (): Promise<void> => {
    if (bus.size === 0) return
    if (publishing) {
      again = true
      return
    }
    publishing = true
    try {
      do {
        again = false
        bus.publish('accounts', { accounts: await describeAccounts(source) })
      } while (again)
    } catch (error) {
      ctx.logger.error('web.eventFailed', { code: errorCode(error) })
    } finally {
      publishing = false
    }
  }
  const createAccount = accountCreator(source)
  const routes: Route[] = [
    // What the page needs before it can draw anything: the language of the installation. Read from the file each time
    // (the setup wizard changes it); the one the daemon started with when the file cannot say.
    {
      method: 'GET',
      path: '/api/info',
      handler: async () => {
        const root = await readConfigObject(ctx.layout.configFile)
        const written = root.ok ? root.value.language : undefined
        const language = (LANGUAGES as readonly unknown[]).includes(written) ? written : options.language
        return { body: { language } }
      },
    },
    {
      method: 'GET',
      path: '/api/accounts',
      handler: async () => ({ body: { accounts: await describeAccounts(source) } }),
    },
    ...accountRoutes(source, createAccount),
    ...setupRoutes({ ...source, models, create: createAccount, onChanged: () => void publishAccounts() }),
    ...scheduleRoutes(source, () => void publishAccounts()),
    ...settingsRoutes({ ...source, models }, () => void publishAccounts()),
    ...models.routes,
    ...keysRoutes(source),
    ...promptRoutes(source, () => void publishAccounts()),
    ...digestRoutes({ ...source, previews }),
    ...conversationRoutes(source),
    ...historyRoutes(source),
    ...(options.logs === undefined ? [] : logRoutes(options.logs)),
  ]

  const qrCount = new Map<string, number>()
  const removeBusyCheck = host.addBusyCheck((id) => previews.isBusy(id))
  const unsubscribeChange = host.onChange(() => {
    previews.prune()
    void publishAccounts()
  })
  const unsubscribeLink = host.onLink((event) => {
    // A new link may bind another number: what was summarized before is not that account's any more.
    if (event.type === 'link') previews.forget(event.account)
    if (event.type === 'qr') {
      const seq = (qrCount.get(event.account) ?? 0) + 1
      qrCount.set(event.account, seq)
      bus.publish('qr', { account: event.account, seq })
    } else if (event.type === 'sync') {
      bus.publish('sync', {
        account: event.account,
        chats: event.chats,
        messages: event.messages,
        ...(event.percent === undefined ? {} : { percent: event.percent }),
        done: event.done,
      })
    } else {
      bus.publish('link', {
        account: event.account,
        state: event.state,
        ...(event.error === undefined ? {} : { error: event.error }),
      })
    }
  })
  const unsubscribeDigest = host.onDigest(({ account, ...event }) => {
    bus.publish('digest', { account, ...event })
    // Every run that ends (even a failed or empty one) added a row to the history.
    if (event.state === 'done' || event.state === 'empty' || event.state === 'failed')
      bus.publish('history', { account })
  })
  // Runs closed as interrupted, or recorded by another process (`msum digest`): found on the look of the host, only while
  // a page is connected.
  const unsubscribeHistory = host.onHistory(
    (account) => bus.publish('history', { account }),
    () => bus.size > 0,
  )
  // New log lines: told to the pages at most once per `logEventMs` (the first at once, the last one after the pause), and
  // only while a page is connected. Nothing of the lines goes in the event.
  const logEventMs = options.logEventMs ?? ctx.web?.logEventMs ?? 1_000
  let lastLogEvent = 0
  let pendingLog: ReturnType<typeof setTimeout> | null = null
  let newestLog = 0
  const unsubscribeLogs =
    options.logs?.subscribe((seq) => {
      newestLog = seq
      if (bus.size === 0 || pendingLog !== null) return
      const wait = lastLogEvent + logEventMs - Date.now()
      const send = (): void => {
        pendingLog = null
        lastLogEvent = Date.now()
        bus.publish('log', { seq: newestLog, boot: options.logs?.boot ?? '' })
      }
      if (wait <= 0) send()
      else {
        pendingLog = setTimeout(send, wait)
        pendingLog.unref()
      }
    }) ?? (() => undefined)
  const unsubscribe = (): void => {
    unsubscribeLogs()
    if (pendingLog !== null) clearTimeout(pendingLog)
    pendingLog = null
    unsubscribeHistory()
    unsubscribeChange()
    unsubscribeLink()
    unsubscribeDigest()
    removeBusyCheck()
    // Previews are dropped and their temporary runtimes closed: private text does not outlive the web.
    previews.stop()
  }

  let server: WebServer | null = null
  try {
    server = createWebServer({
      host: listenHost,
      port: listenPort,
      token: await ensureWebToken(ctx.layout),
      routes,
      events: bus,
      staticDir: ctx.web?.staticDir ?? DEFAULT_STATIC_DIR,
      notBuilt: texts.web.notBuilt,
      logger: ctx.logger,
      ...(ctx.web?.heartbeatMs === undefined ? {} : { heartbeatMs: ctx.web.heartbeatMs }),
    })
    const bound = server
    const address = await bound.start()
    await writeWebAddress(ctx.layout, address)
    ctx.logger.info('web.listening', { host: address.host, port: address.port })
    ctx.io.out(texts.cli.web.listening(address.host, address.port))
    if (!isLoopbackHost(listenHost)) ctx.io.err(texts.cli.web.exposed(listenHost))
    return {
      stop: async () => {
        unsubscribe()
        await removeWebAddress(ctx.layout).catch(() => undefined)
        await bound.stop()
      },
    }
  } catch (error) {
    unsubscribe()
    await server?.stop()
    await removeWebAddress(ctx.layout).catch(() => undefined)
    const code = errorCode(error)
    ctx.logger.error('web.failed', { code, host: listenHost, port: listenPort })
    ctx.io.err(texts.cli.web.failed(listenHost, listenPort, code))
    return null
  }
}
