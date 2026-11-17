import { fileURLToPath } from 'node:url'
import { getCatalog, type Language } from '../infrastructure/i18n/index.js'
import { EventBus } from '../interfaces/http/events.js'
import { isLoopbackHost } from '../interfaces/http/hosts.js'
import type { Route } from '../interfaces/http/router.js'
import { createWebServer, type WebServer } from '../interfaces/http/web-server.js'
import type { Installation } from './accounts.js'
import type { WebConfig } from './config.js'
import type { CommandContext } from './context.js'
import type { DaemonHost } from './daemon-host.js'
import { errorCode } from './logger.js'
import { type AccountView, describeAccounts } from './web-accounts.js'
import { removeWebAddress, writeWebAddress } from './web-address.js'
import { ensureWebToken } from './web-token.js'

/** The events the web pushes over SSE, by name. Later parts add `qr` and `sync`. */
export interface WebEvents extends Record<string, unknown> {
  readonly accounts: { readonly accounts: readonly AccountView[] }
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
}

/**
 * Starts the local web inside the daemon (RF-01, RNF-03) and wires it to the host: `GET /api/accounts`, and an
 * `accounts` event whenever an account changes state. The web must never take the daemon down: when it cannot start
 * (the port is taken, the token cannot be written) it logs `web.failed` with a code, says so, and returns null while
 * the accounts keep running.
 */
export async function startWeb(options: StartWebOptions): Promise<WebHandle | null> {
  const { ctx, installation, host } = options
  const texts = getCatalog(options.language)
  const listenHost = ctx.web?.host ?? options.web.host
  const listenPort = ctx.web?.port ?? options.web.port
  const source = { ctx, installation, host }
  const routes: Route[] = [
    {
      method: 'GET',
      path: '/api/accounts',
      handler: async () => ({ body: { accounts: await describeAccounts(source) } }),
    },
  ]

  const bus = new EventBus<WebEvents>()
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
  const unsubscribe = host.onChange(() => void publishAccounts())

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
