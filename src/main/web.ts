import { fileURLToPath } from 'node:url'
import { type DigestErrorCode, getCatalog, type Language, type LinkErrorCode } from '../infrastructure/i18n/index.js'
import { EventBus } from '../interfaces/http/events.js'
import { isLoopbackHost } from '../interfaces/http/hosts.js'
import type { Route } from '../interfaces/http/router.js'
import { createWebServer, type WebServer } from '../interfaces/http/web-server.js'
import type { Installation } from './accounts.js'
import type { WebConfig } from './config.js'
import type { CommandContext } from './context.js'
import type { DaemonHost } from './daemon-host.js'
import { errorCode } from './logger.js'
import { PreviewService } from './preview.js'
import { type AccountView, describeAccounts } from './web-accounts.js'
import { removeWebAddress, writeWebAddress } from './web-address.js'
import { conversationRoutes } from './web-conversations.js'
import { digestRoutes } from './web-digest.js'
import { promptRoutes } from './web-prompt.js'
import { accountRoutes } from './web-routes.js'
import { scheduleRoutes } from './web-schedules.js'
import { settingsRoutes } from './web-settings.js'
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
  const routes: Route[] = [
    // What the page needs before it can draw anything: the language of the installation.
    { method: 'GET', path: '/api/info', handler: () => ({ body: { language: options.language } }) },
    {
      method: 'GET',
      path: '/api/accounts',
      handler: async () => ({ body: { accounts: await describeAccounts(source) } }),
    },
    ...accountRoutes(source),
    ...scheduleRoutes(source, () => void publishAccounts()),
    ...settingsRoutes(source, () => void publishAccounts()),
    ...promptRoutes(source, () => void publishAccounts()),
    ...digestRoutes({ ...source, previews }),
    ...conversationRoutes(source),
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
  const unsubscribeDigest = host.onDigest(({ account, ...event }) => bus.publish('digest', { account, ...event }))
  const unsubscribe = (): void => {
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
