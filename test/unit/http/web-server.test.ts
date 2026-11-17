import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../../../src/interfaces/http/events.js'
import { isAllowedHost, isLoopbackHost } from '../../../src/interfaces/http/hosts.js'
import { HttpError, matchRoute, type Route } from '../../../src/interfaces/http/router.js'
import { createWebServer, MAX_BODY_BYTES, type WebServer } from '../../../src/interfaces/http/web-server.js'
import { until } from '../../support/cli-harness.js'

const TOKEN = 'A'.repeat(43)
const NOT_BUILT = { title: 'Title', message: 'The web is not built <yet>' }

interface Reply {
  readonly status: number
  readonly headers: http.IncomingHttpHeaders
  readonly body: string
}

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const routes: Route[] = [
  { method: 'GET', path: '/api/ping', handler: () => ({ body: { pong: true } }) },
  { method: 'POST', path: '/api/echo', handler: ({ body }) => ({ body: { got: body } }) },
  { method: 'GET', path: '/api/things/:id', handler: ({ params }) => ({ body: { id: params.id } }) },
  {
    method: 'GET',
    path: '/api/forbidden',
    handler: () => {
      throw new HttpError(403, 'forbidden')
    },
  },
  {
    method: 'GET',
    path: '/api/boom',
    handler: () => {
      throw new Error('secret detail')
    },
  },
]

interface Setup {
  server: WebServer
  port: number
  root: string
  staticDir: string
  bus: EventBus<{ accounts: { n: number } }>
  logged: string[]
  call(options: {
    method?: string
    path: string
    headers?: Record<string, string>
    body?: string | Buffer
    host?: string
  }): Promise<Reply>
}

async function setup(options: { withStatic?: boolean; host?: string; heartbeatMs?: number } = {}): Promise<Setup> {
  const root = mkdtempSync(join(tmpdir(), 'msum-web-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const staticDir = join(root, 'public')
  if (options.withStatic !== false) {
    mkdirSync(join(staticDir, 'assets'), { recursive: true })
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>app</title>')
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)')
  }
  writeFileSync(join(root, 'secret.txt'), 'TOP-SECRET')
  const bus = new EventBus<{ accounts: { n: number } }>()
  const logged: string[] = []
  const server = createWebServer({
    host: options.host ?? '127.0.0.1',
    port: 0,
    token: TOKEN,
    routes,
    events: bus,
    staticDir,
    notBuilt: NOT_BUILT,
    logger: { error: (event, fields) => logged.push(`${event}:${fields?.code ?? ''}`) },
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  })
  const { port } = await server.start()
  cleanups.push(() => server.stop())
  const call: Setup['call'] = ({ method = 'GET', path, headers = {}, body, host }) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: { Host: host ?? `127.0.0.1:${port}`, ...headers },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          )
        },
      )
      req.on('error', reject)
      req.end(body)
    })
  return { server, port, root, staticDir, bus, logged, call }
}

const bearer = { Authorization: `Bearer ${TOKEN}` }
const json = { 'Content-Type': 'application/json' }

describe('authentication (RNF-03)', () => {
  it('answers 401 without a token, with a wrong one and with a malformed header, and never runs the route', async () => {
    const s = await setup()
    for (const headers of [
      {} as Record<string, string>,
      { Authorization: 'Bearer nope' },
      { Authorization: TOKEN },
      { Cookie: 'msum_session=nope' },
    ]) {
      const reply = await s.call({ path: '/api/ping', headers })
      expect(reply.status).toBe(401)
      expect(JSON.parse(reply.body)).toEqual({ error: 'unauthorized' })
    }
  })

  it('answers 401 for unknown /api paths too, before saying whether they exist', async () => {
    const s = await setup()
    expect((await s.call({ path: '/api/does-not-exist' })).status).toBe(401)
    expect((await s.call({ path: '/api/events' })).status).toBe(401)
  })

  it('accepts the bearer token', async () => {
    const s = await setup()
    const reply = await s.call({ path: '/api/ping', headers: bearer })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual({ pong: true })
    expect(reply.headers['cache-control']).toBe('no-store')
  })

  it('POST /api/session sets an HttpOnly SameSite=Strict cookie with a random session secret, never the token', async () => {
    const s = await setup()
    const reply = await s.call({
      method: 'POST',
      path: '/api/session',
      headers: json,
      body: JSON.stringify({ token: TOKEN }),
    })
    expect(reply.status).toBe(200)
    const cookie = String(reply.headers['set-cookie']?.[0])
    expect(cookie).toMatch(/^msum_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/)
    expect(cookie).not.toContain(TOKEN)
    const pair = cookie.split(';')[0] as string
    expect((await s.call({ path: '/api/ping', headers: { Cookie: `other=1; ${pair}` } })).status).toBe(200)
    // each session is its own secret
    const second = await s.call({
      method: 'POST',
      path: '/api/session',
      headers: json,
      body: JSON.stringify({ token: TOKEN }),
    })
    expect(String(second.headers['set-cookie']?.[0]).split(';')[0]).not.toBe(pair)
    // the master token in a cookie is not a session, and a made-up secret is not either
    expect((await s.call({ path: '/api/ping', headers: { Cookie: `msum_session=${TOKEN}` } })).status).toBe(401)
    expect((await s.call({ path: '/api/ping', headers: { Cookie: `msum_session=${'B'.repeat(43)}` } })).status).toBe(
      401,
    )
  })

  it('a restarted server does not know the sessions of the previous one', async () => {
    const first = await setup()
    const reply = await first.call({
      method: 'POST',
      path: '/api/session',
      headers: json,
      body: JSON.stringify({ token: TOKEN }),
    })
    const pair = String(reply.headers['set-cookie']?.[0]).split(';')[0] as string
    const second = await setup()
    expect((await second.call({ path: '/api/ping', headers: { Cookie: pair } })).status).toBe(401)
  })

  it('POST /api/session answers 401 for a wrong token, a missing one and a body that is not an object', async () => {
    const s = await setup()
    for (const body of [JSON.stringify({ token: 'wrong' }), '{}', '"text"', JSON.stringify({ token: 5 })]) {
      const reply = await s.call({ method: 'POST', path: '/api/session', headers: json, body })
      expect(reply.status).toBe(401)
      expect(reply.headers['set-cookie']).toBeUndefined()
    }
    expect((await s.call({ method: 'POST', path: '/api/session', headers: json, body: '{nope' })).status).toBe(400)
  })
})

describe('DNS rebinding and CSRF guards', () => {
  it('answers 403 for a Host that is not ours, even with the token, and for no Host at all', async () => {
    const s = await setup()
    for (const host of ['evil.example', `evil.example:${s.port}`, '127.0.0.1:1', `127.0.0.1.evil.example:${s.port}`]) {
      const reply = await s.call({ path: '/api/ping', headers: bearer, host })
      expect(reply.status).toBe(403)
    }
    expect((await s.call({ path: '/', host: 'evil.example' })).status).toBe(403)
  })

  it('accepts the loopback names with the right port', async () => {
    const s = await setup()
    for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `[::1]:${s.port}`]) {
      expect((await s.call({ path: '/api/ping', headers: bearer, host })).status).toBe(200)
    }
  })

  it('answers 403 to a state-changing request whose Origin is foreign, or "null", and accepts our own', async () => {
    const s = await setup()
    const post = (origin: string) =>
      s.call({ method: 'POST', path: '/api/echo', headers: { ...bearer, ...json, Origin: origin }, body: '{"a":1}' })
    expect((await post('https://evil.example')).status).toBe(403)
    expect((await post('http://evil.example')).status).toBe(403)
    expect((await post('null')).status).toBe(403)
    expect((await post(`http://127.0.0.1:${s.port + 1}`)).status).toBe(403)
    const own = await post(`http://localhost:${s.port}`)
    expect(own.status).toBe(200)
    expect(JSON.parse(own.body)).toEqual({ got: { a: 1 } })
    // a request with no Origin (a script, the CLI) is not a browser cross-site request
    expect(
      (await s.call({ method: 'POST', path: '/api/echo', headers: { ...bearer, ...json }, body: '{}' })).status,
    ).toBe(200)
  })

  it('applies the Origin check to the session endpoint too', async () => {
    const s = await setup()
    const reply = await s.call({
      method: 'POST',
      path: '/api/session',
      headers: { ...json, Origin: 'https://evil.example' },
      body: JSON.stringify({ token: TOKEN }),
    })
    expect(reply.status).toBe(403)
    expect(reply.headers['set-cookie']).toBeUndefined()
  })

  it('isAllowedHost: a wildcard listen address accepts IP literals but not names; a specific one only itself', () => {
    expect(isAllowedHost('192.168.1.5:80', '0.0.0.0', 80)).toBe(true)
    expect(isAllowedHost('[fe80::1]:80', '::', 80)).toBe(true)
    expect(isAllowedHost('rebind.example:80', '0.0.0.0', 80)).toBe(false)
    expect(isAllowedHost('192.168.1.5:80', '192.168.1.5', 80)).toBe(true)
    expect(isAllowedHost('192.168.1.6:80', '192.168.1.5', 80)).toBe(false)
    expect(isAllowedHost('192.168.1.5:81', '192.168.1.5', 80)).toBe(false)
    expect(isAllowedHost(undefined, '127.0.0.1', 80)).toBe(false)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.5')).toBe(false)
  })
})

describe('router, body and errors', () => {
  it('routes by method and path with :params, and tells a wrong method from an unknown path', async () => {
    const s = await setup()
    expect(JSON.parse((await s.call({ path: '/api/things/a%20b', headers: bearer })).body)).toEqual({ id: 'a b' })
    expect((await s.call({ method: 'POST', path: '/api/ping', headers: bearer })).status).toBe(405)
    const unknown = await s.call({ path: '/api/nothing', headers: bearer })
    expect(unknown.status).toBe(404)
    expect(JSON.parse(unknown.body)).toEqual({ error: 'notFound' })
    expect(matchRoute(routes, 'GET', '/api/things/')).toEqual({ kind: 'notFound' })
    expect(matchRoute(routes, 'GET', '/api/things/%E0%A4%A')).toEqual({ kind: 'notFound' })
  })

  it('answers errors as codes, and 500 without the message of the exception', async () => {
    const s = await setup()
    const refused = await s.call({ path: '/api/forbidden', headers: bearer })
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body)).toEqual({ error: 'forbidden' })
    const boom = await s.call({ path: '/api/boom', headers: bearer })
    expect(boom.status).toBe(500)
    expect(JSON.parse(boom.body)).toEqual({ error: 'internal' })
    expect(boom.body).not.toContain('secret')
    expect(s.logged).toEqual(['web.requestFailed:Error'])
  })

  it('answers 400 for a body that is not JSON', async () => {
    const s = await setup()
    const reply = await s.call({ method: 'POST', path: '/api/echo', headers: { ...bearer, ...json }, body: '{nope' })
    expect(reply.status).toBe(400)
    expect(JSON.parse(reply.body)).toEqual({ error: 'invalidJson' })
  })

  it('answers 413 when the body is bigger than the limit, declared or streamed', async () => {
    const s = await setup()
    const big = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)
    const declared = await s.call({ method: 'POST', path: '/api/echo', headers: { ...bearer, ...json }, body: big })
    expect(declared.status).toBe(413)
    expect(JSON.parse(declared.body)).toEqual({ error: 'payloadTooLarge' })
    const session = await s.call({ method: 'POST', path: '/api/session', headers: json, body: big })
    expect(session.status).toBe(413)
    const ok = await s.call({
      method: 'POST',
      path: '/api/echo',
      headers: { ...bearer, ...json },
      body: JSON.stringify({ text: 'a'.repeat(MAX_BODY_BYTES - 100) }),
    })
    expect(ok.status).toBe(200)
  })

  it('sends the security headers on every answer', async () => {
    const s = await setup()
    for (const reply of [
      await s.call({ path: '/' }),
      await s.call({ path: '/api/ping' }),
      await s.call({ path: '/api/ping', headers: bearer }),
      await s.call({ path: '/api/ping', headers: bearer, host: 'evil.example' }),
    ]) {
      expect(reply.headers['x-content-type-options']).toBe('nosniff')
      expect(reply.headers['referrer-policy']).toBe('no-referrer')
      expect(reply.headers['content-security-policy']).toBe(
        "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      )
    }
  })
})

describe('static files', () => {
  it('serves the shell and its assets without a token, with the right content type', async () => {
    const s = await setup()
    const index = await s.call({ path: '/' })
    expect(index.status).toBe(200)
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(index.body).toContain('<title>app</title>')
    const script = await s.call({ path: '/assets/app.js' })
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect((await s.call({ method: 'HEAD', path: '/assets/app.js' })).body).toBe('')
    expect((await s.call({ path: '/assets/missing.js' })).status).toBe(404)
    expect((await s.call({ method: 'POST', path: '/' })).status).toBe(405)
  })

  it('never serves anything outside the directory: dot segments, encoded ones, backslashes, links', async () => {
    const s = await setup()
    symlinkSync(join(s.root, 'secret.txt'), join(s.staticDir, 'link.txt'))
    for (const path of [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/%2e%2e%2fsecret.txt',
      '/..%5csecret.txt',
      '/%00',
      '/link.txt',
      '/%E0%A4%A',
    ]) {
      const reply = await s.call({ path })
      expect([400, 403, 404], path).toContain(reply.status)
      expect(reply.body, path).not.toContain('TOP-SECRET')
    }
  })

  it('answers 503 with the translated "not built" page when the directory is missing, and 404 elsewhere', async () => {
    const s = await setup({ withStatic: false })
    const root = await s.call({ path: '/' })
    expect(root.status).toBe(503)
    expect(root.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(root.body).toContain('The web is not built &#60;yet&#62;')
    expect(root.body).not.toContain('<yet>')
    expect((await s.call({ path: '/assets/app.js' })).status).toBe(404)
    // the API does not depend on the build
    expect((await s.call({ path: '/api/ping', headers: bearer })).status).toBe(200)
  })

  it('serves the web as soon as it is built, without restarting', async () => {
    const s = await setup({ withStatic: false })
    expect((await s.call({ path: '/' })).status).toBe(503)
    mkdirSync(s.staticDir, { recursive: true })
    writeFileSync(join(s.staticDir, 'index.html'), '<title>built</title>')
    expect((await s.call({ path: '/' })).body).toContain('built')
  })
})

/** Opens GET /api/events and collects what arrives. */
function openEvents(s: Setup, headers: Record<string, string> = bearer) {
  const received: string[] = []
  let closed = false
  let status = 0
  const req = http.request({
    host: '127.0.0.1',
    port: s.port,
    path: '/api/events',
    headers: { Host: `127.0.0.1:${s.port}`, ...headers },
    agent: false,
  })
  req.on('response', (res) => {
    status = res.statusCode ?? 0
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => received.push(chunk))
    res.on('close', () => {
      closed = true
    })
  })
  req.on('error', () => {
    closed = true
  })
  req.end()
  const leave = () => {
    req.destroy()
  }
  cleanups.push(leave)
  return { text: () => received.join(''), isClosed: () => closed, status: () => status, leave }
}

describe('GET /api/events (SSE)', () => {
  it('streams the events published on the bus, as typed events', async () => {
    const s = await setup()
    const events = openEvents(s)
    await until(() => events.text().includes(': connected'), 'the stream to open')
    expect(events.status()).toBe(200)
    s.bus.publish('accounts', { n: 1 })
    await until(() => events.text().includes('event: accounts\ndata: {"n":1}\n\n'), 'the accounts event')
  })

  it('stops listening to the bus when the client leaves', async () => {
    const s = await setup()
    const events = openEvents(s)
    await until(() => events.text().includes(': connected'), 'the stream to open')
    expect(s.bus.size).toBe(1)
    events.leave()
    await until(() => s.bus.size === 0, 'the subscription to be dropped')
  })

  it('a publish or a heartbeat after stop() writes nothing and throws nothing', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => uncaught.push(error)
    process.on('uncaughtException', onUncaught)
    cleanups.push(() => {
      process.off('uncaughtException', onUncaught)
    })
    const s = await setup({ heartbeatMs: 2 })
    const events = openEvents(s)
    await until(() => events.text().includes(': connected'), 'the stream to open')
    const stopping = s.server.stop()
    // what a publish in flight does when it lands after the streams were ended
    s.bus.publish('accounts', { n: 1 })
    await stopping
    s.bus.publish('accounts', { n: 2 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(s.bus.size).toBe(0)
    expect(events.text()).not.toContain('"n":2')
    expect(uncaught).toEqual([])
  })

  it('stop() closes the open streams promptly, and the server is really closed', async () => {
    const s = await setup()
    const events = [openEvents(s), openEvents(s)]
    await until(() => events.every((e) => e.text().includes(': connected')), 'the streams to open')
    const began = Date.now()
    await s.server.stop()
    expect(Date.now() - began).toBeLessThan(2_000)
    await until(() => events.every((e) => e.isClosed()), 'the streams to close')
    await expect(s.call({ path: '/' })).rejects.toThrow()
    await s.server.stop() // safe to repeat
  })
})

describe('start', () => {
  it('rejects with the system error when the port is taken', async () => {
    const s = await setup()
    const other = createWebServer({
      host: '127.0.0.1',
      port: s.port,
      token: TOKEN,
      routes: [],
      events: new EventBus(),
      staticDir: s.staticDir,
      notBuilt: NOT_BUILT,
      logger: { error: () => {} },
    })
    await expect(other.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    await other.stop()
  })
})
