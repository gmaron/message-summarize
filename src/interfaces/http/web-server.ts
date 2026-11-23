import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WebErrorCode } from '../../infrastructure/i18n/index.js'
import type { EventSource } from './events.js'
import { isAllowedHost, isListedHost } from './hosts.js'
import { HttpError, matchRoute, type Route } from './router.js'
import { notBuiltPage, serveStatic } from './static-files.js'

export const SESSION_COOKIE = 'msum_session'
export const MAX_BODY_BYTES = 64 * 1024
export const DEFAULT_HEARTBEAT_MS = 25_000
/** After this long a stop closes the connections that did not finish by themselves. */
const STOP_FORCE_MS = 100
/** How long the cookie of a session lasts in the browser: 30 days. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
/** A cookie issued this far in the future (a clock that moved back) is still refused. */
const SESSION_SKEW_SECONDS = 5 * 60

/** What the server needs to say about its own trouble. The composition root passes its logger. */
export interface WebLogger {
  error(event: string, fields?: { code?: string }): void
}

export interface WebServerOptions {
  readonly host: string
  /** Names a reverse proxy reaches the web by (`web.allowedHosts`): accepted as `Host` without a port and, in an `Origin`, over https. */
  readonly allowedHosts?: readonly string[]
  /** 0 asks the system for a free port (tests). */
  readonly port: number
  readonly token: string
  /**
   * A random secret kept in the data directory (`web-session`), so a session survives a restart of the daemon. The cookie
   * holds `<issuedAt>.<HMAC(sessionSecret, token|issuedAt)>`: it follows both files, deleting either one ends every
   * session, it never holds the token itself, and the server refuses it 30 days after `issuedAt`.
   */
  readonly sessionSecret: string
  /** The clock, in milliseconds since the epoch (tests move it). */
  readonly now?: () => number
  /** The routes under `/api`. Every one needs the token; `POST /api/session` and `GET /api/events` are built in. */
  readonly routes: readonly Route[]
  readonly events: EventSource
  /** The built web (an `index.html` and its assets). Looked at on every request, so it may appear later. */
  readonly staticDir: string
  /** The page `/` answers with (503) when `staticDir` does not exist: already translated. */
  readonly notBuilt: { readonly title: string; readonly message: string }
  readonly logger: WebLogger
  readonly heartbeatMs?: number
}

export interface WebServer {
  /** Starts listening. Resolves with the address as bound (the port is the real one when 0 was asked). Rejects with the error of the system (EADDRINUSE...) when it cannot. */
  start(): Promise<{ readonly host: string; readonly port: number }>
  /** Closes the SSE streams and the connections, and resolves once the server is closed. Safe to repeat. */
  stop(): Promise<void>
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
}

const digest = (text: string): Buffer => createHash('sha256').update(text).digest()

/** Constant-time comparison: both sides are hashed first so their lengths do not matter or leak. */
export function tokensMatch(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected))
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return null
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code
  return error instanceof Error ? error.name : 'unknown'
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}

const sendError = (res: ServerResponse, status: number, code: WebErrorCode, headers?: Record<string, string>): void =>
  sendJson(res, status, { error: code }, headers)

/** The body, or null when it is bigger than the limit (the rest of it is not read). */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > MAX_BODY_BYTES) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.removeAllListeners('data')
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseJson(body: Buffer): unknown {
  if (body.length === 0) return undefined
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalidJson')
  }
}

/**
 * The local web server (RNF-03), on plain `node:http`. Static files (the shell of the single-page app, which holds no
 * data) are public; nothing under `/api` is: it needs the token, as `Authorization: Bearer` or as the `msum_session`
 * cookie that `POST /api/session` sets. The cookie does not hold the token itself (cookies are not scoped to a port, so
 * it would go to every server on this address) but a value derived from it and from a persisted random secret, valid
 * for 30 days (the server checks the date it holds) and across restarts of the daemon. Requests for a `Host` we do not expect (DNS rebinding) and state-changing
 * requests whose `Origin` is foreign (CSRF) are refused before anything else.
 */
export function createWebServer(options: WebServerOptions): WebServer {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  /** Open SSE streams, each with the function that detaches it from the bus and the heartbeat. */
  const streams = new Map<ServerResponse, () => void>()
  const now = options.now ?? Date.now
  const macOf = (issuedAt: string): string =>
    createHmac('sha256', options.sessionSecret).update(`${options.token}|${issuedAt}`).digest('base64url')
  /** A fresh cookie value: derived from the token and the persisted secret, so the master token never travels in a cookie. */
  const issueSession = (): string => {
    const issuedAt = String(Math.floor(now() / 1000))
    return `${issuedAt}.${macOf(issuedAt)}`
  }
  /** Strict: `<digits>.<base64url>`, the right MAC (constant time) and an age between -skew and the maximum. */
  const sessionValid = (value: string): boolean => {
    const match = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(value)
    if (match === null) return false
    const [, issuedAt, mac] = match as unknown as [string, string, string]
    const expected = Buffer.from(macOf(issuedAt))
    const given = Buffer.from(mac)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
    const age = Math.floor(now() / 1000) - Number(issuedAt)
    return age <= SESSION_MAX_AGE_SECONDS && age >= -SESSION_SKEW_SECONDS
  }
  let stopping: Promise<void> | null = null
  let bound = options.port

  const authorized = (req: IncomingMessage): boolean => {
    const bearer = /^bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')
    if (bearer !== null && tokensMatch(bearer[1] as string, options.token)) return true
    const cookie = cookieValue(req.headers.cookie, SESSION_COOKIE)
    if (cookie === null) return false
    return sessionValid(cookie)
  }

  const allowedHosts = options.allowedHosts ?? []

  const originAllowed = (origin: string): boolean => {
    try {
      const url = new URL(origin)
      if (!isAllowedHost(url.host, options.host, bound, allowedHosts)) return false
      return url.protocol === 'http:' || (url.protocol === 'https:' && isListedHost(url.hostname, allowedHosts))
    } catch {
      return false
    }
  }

  const openStream = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    const write = (text: string): void => {
      if (!res.writableEnded && !res.destroyed) res.write(text)
    }
    const timer = setInterval(() => write(': keep-alive\n\n'), heartbeatMs)
    timer.unref()
    const unsubscribe = options.events.subscribe((event, data) => {
      write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    })
    const cleanup = () => {
      clearInterval(timer)
      unsubscribe()
      streams.delete(res)
    }
    streams.set(res, cleanup)
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  const openSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req)
    if (raw === null) return sendError(res, 413, 'payloadTooLarge', { Connection: 'close' })
    const body = parseJson(raw)
    const given = typeof body === 'object' && body !== null ? (body as { token?: unknown }).token : undefined
    if (typeof given !== 'string' || !tokensMatch(given, options.token)) return sendError(res, 401, 'unauthorized')
    // Over https (a reverse proxy such as `tailscale serve`; the Origin was already checked) the cookie is Secure too.
    // Plain http on loopback gets none, which a browser would not keep.
    const secure = req.headers.origin?.startsWith('https:') === true ? '; Secure' : ''
    sendJson(
      res,
      200,
      { ok: true },
      {
        'Set-Cookie': `${SESSION_COOKIE}=${issueSession()}; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict; Path=/${secure}`,
      },
    )
  }

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store')
    const method = req.method ?? 'GET'
    if (method === 'POST' && url.pathname === '/api/session') return openSession(req, res)
    if (!authorized(req)) return sendError(res, 401, 'unauthorized')
    if (method === 'GET' && url.pathname === '/api/events') return openStream(req, res)
    const match = matchRoute(options.routes, method, url.pathname)
    if (match.kind === 'notFound') return sendError(res, 404, 'notFound')
    if (match.kind === 'methodNotAllowed') return sendError(res, 405, 'methodNotAllowed')
    let body: unknown
    if (method !== 'GET') {
      const raw = await readBody(req)
      if (raw === null) return sendError(res, 413, 'payloadTooLarge', { Connection: 'close' })
      body = parseJson(raw)
    }
    const result = await match.route.handler({ params: match.params, query: url.searchParams, body })
    // 204 has no body (and no Content-Length that would say otherwise).
    if (result.status === 204) {
      res.writeHead(204)
      res.end()
      return
    }
    if (result.raw !== undefined) {
      res.writeHead(result.status ?? 200, {
        'Content-Type': result.raw.type,
        'Content-Length': Buffer.byteLength(result.raw.text),
      })
      res.end(result.raw.text)
      return
    }
    sendJson(res, result.status ?? 200, result.body ?? {})
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
    if (!isAllowedHost(req.headers.host, options.host, bound, allowedHosts)) return sendError(res, 403, 'forbidden')
    const method = req.method ?? 'GET'
    const origin = req.headers.origin
    if (method !== 'GET' && method !== 'HEAD' && origin !== undefined && !originAllowed(origin)) {
      return sendError(res, 403, 'forbidden')
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return sendError(res, 404, 'notFound')
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(req, res, url)
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'methodNotAllowed')
    await serveStatic(
      options.staticDir,
      url.pathname,
      method === 'HEAD',
      res,
      notBuiltPage(options.notBuilt.title, options.notBuilt.message),
    )
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        if (!res.headersSent) sendError(res, error.status, error.code)
        return
      }
      options.logger.error('web.requestFailed', { code: errorCodeOf(error) })
      if (!res.headersSent) sendError(res, 500, 'internal')
      else res.destroy()
    })
  })
  // An error of the server after it listens (running out of file descriptors accepting a connection...) must never
  // become an uncaught exception: the process guards would stop every account for a problem of the web.
  server.on('error', (error) => {
    if (server.listening) options.logger.error('web.serverError', { code: errorCodeOf(error) })
  })
  // A client that sends nothing for a while is not kept open forever.
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000

  return {
    start: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        server.once('error', onError)
        server.listen({ host: options.host, port: options.port }, () => {
          server.off('error', onError)
          bound = (server.address() as AddressInfo).port
          resolve({ host: (server.address() as AddressInfo).address, port: bound })
        })
      }),
    stop: () => {
      stopping ??= new Promise<void>((resolve) => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
        // Detached first, so nothing writes to a stream that is ending (a publish in flight, the heartbeat).
        for (const [stream, cleanup] of [...streams]) {
          cleanup()
          stream.end()
        }
        server.closeIdleConnections()
        setTimeout(() => server.closeAllConnections(), STOP_FORCE_MS).unref()
      })
      return stopping
    },
  }
}
