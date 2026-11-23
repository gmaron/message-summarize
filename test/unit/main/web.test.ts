import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runMain } from '../../../src/main/app.js'
import { writeBlocked } from '../../../src/main/blocked.js'
import { acquireDaemonLock } from '../../../src/main/daemon-lock.js'
import { acquireLinkLock } from '../../../src/main/link-lock.js'
import { browserCommand } from '../../../src/main/open-url.js'
import { readWebAddress, writeWebAddress } from '../../../src/main/web-address.js'
import { ensureWebSession, ensureWebToken } from '../../../src/main/web-token.js'
import { disposeHarnesses, type Harness, ME, makeHarness, until, waitFor } from '../../support/cli-harness.js'
import { allowNetwork } from '../../support/network-guard.js'

afterEach(() => disposeHarnesses())

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const BASE = { language: 'en', schedules: [], provider: { primary: 'claude-cli' } }
const events = (h: Harness) => h.logs.map((l) => JSON.parse(l) as { event: string; [key: string]: unknown })
const token = (h: Harness) => readFileSync(h.layout.webTokenFile, 'utf8').trim()

async function link(h: Harness): Promise<void> {
  const runtime = h.runtime()
  runtime.identity.bind(ME)
  runtime.close()
  writeFileSync(join(h.account.authDir, 'creds.json'), JSON.stringify({ me: { id: ME } }))
}

/** Runs the daemon and waits for the web to be up. Returns the port and the promise of the exit code. */
async function startDaemon(h: Harness, ...extra: string[]) {
  const finished = run(h, 'daemon', ...extra)
  await waitFor(() => expect(h.out.join('\n')).toContain('Daemon running'))
  const listening = events(h).find((e) => e.event === 'web.listening')
  return { finished, port: listening?.port as number | undefined }
}

const get = async (port: number, path: string, auth: string | null) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers: auth === null ? {} : { Authorization: `Bearer ${auth}` } })

describe('msum daemon: the local web (RF-01, RNF-03)', () => {
  it('serves /api/accounts with the live state of each account, behind the token', async () => {
    const h = await makeHarness({ config: BASE })
    await link(h)
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    const { finished, port } = await startDaemon(h)
    expect(port).toBeGreaterThan(0)
    expect(events(h).find((e) => e.event === 'web.listening')).toMatchObject({ host: '127.0.0.1', port })
    expect(h.out.join('\n')).toContain(`Web listening on http://127.0.0.1:${port}`)

    expect((await get(port as number, '/api/accounts', null)).status).toBe(401)
    expect((await get(port as number, '/api/accounts', 'wrong')).status).toBe(401)
    await waitFor(async () => {
      const reply = await get(port as number, '/api/accounts', token(h))
      expect(reply.status).toBe(200)
      const body = (await reply.json()) as { accounts: Record<string, unknown>[] }
      expect(body.accounts).toEqual([
        {
          id: 'default',
          state: 'connected',
          since: expect.any(Number),
          blockedReason: null,
          blockedAt: null,
          retryAfter: null,
          fix: null,
          maskedNumber: '+99*******1432',
          lastDigest: null,
          nextRun: null,
          timezone: expect.any(String),
          language: 'en',
          configValid: true,
          configIssues: [],
        },
      ])
      // the full number never leaves the process
      expect(JSON.stringify(body)).not.toContain('9913174261432')
    })
    h.shutdown()
    expect(await finished).toBe(0)
  })

  it('reports the next run of the schedules in the time zone of the account, and a block with its reason', async () => {
    const h = await makeHarness({
      config: { ...BASE, timezone: 'America/Argentina/Buenos_Aires', schedules: ['0 9 * * *'] },
      accounts: ['alpha', 'beta'],
    })
    await link(h)
    await writeBlocked(h.accountOf('beta').blockedFile, 'forbidden', 5)
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    const { finished, port } = await startDaemon(h)
    await waitFor(async () => {
      const body = (await (await get(port as number, '/api/accounts', token(h))).json()) as {
        accounts: { id: string; state: string; blockedReason: string | null; nextRun: number | null }[]
      }
      const beta = body.accounts.find((a) => a.id === 'beta')
      expect(beta).toMatchObject({ state: 'blocked', blockedReason: 'forbidden' })
      const alphaView = body.accounts.find((a) => a.id === 'alpha')
      // 09:00 Buenos Aires (UTC-3) the day after the harness clock (2026-11-17 12:00 there)
      expect(alphaView?.nextRun).toBe(Date.parse('2026-11-18T12:00:00Z'))
    })
    h.shutdown()
    expect(await finished).toBe(0)
  })

  it('pushes an accounts snapshot over SSE when an account changes state, and closes the stream on shutdown', async () => {
    const h = await makeHarness({ config: BASE })
    await link(h)
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    const { finished, port } = await startDaemon(h)
    const received: string[] = []
    let closed = false
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/events',
      headers: { Authorization: `Bearer ${token(h)}` },
      agent: false,
    })
    req.on('response', (res) => {
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
    await until(() => received.join('').includes(': connected'), 'the stream to open')
    await waitFor(() => expect(h.connection.status.state).toBe('connected'))
    h.connection.emit({ state: 'reconnecting', attempt: 1, delayMs: 10, reason: 'closed' })
    await until(() => received.join('').includes('event: accounts'), 'the accounts event')
    const data = received.join('').split('event: accounts\ndata: ').at(-1)?.split('\n')[0] as string
    expect(JSON.parse(data)).toMatchObject({ accounts: [{ id: 'default', state: 'reconnecting' }] })
    const began = Date.now()
    h.shutdown()
    expect(await finished).toBe(0)
    expect(Date.now() - began).toBeLessThan(5_000)
    await until(() => closed, 'the stream to be closed by the shutdown')
  })

  it('reuses the token on disk, and never writes it to the logs or the output', async () => {
    const h = await makeHarness({ config: BASE })
    const secret = await ensureWebToken(h.layout)
    const { finished, port } = await startDaemon(h)
    expect(token(h)).toBe(secret)
    if (process.platform !== 'win32') expect(statSync(h.layout.webTokenFile).mode & 0o777).toBe(0o600)
    expect((await get(port as number, '/api/accounts', secret)).status).toBe(200)
    h.shutdown()
    expect(await finished).toBe(0)
    expect(h.logs.join('')).not.toContain(secret)
    expect([...h.out, ...h.err].join('\n')).not.toContain(secret)
  })

  it('keeps the session secret on disk (0600), reuses it, and the cookie follows it and never reaches the logs', async () => {
    const h = await makeHarness({ config: BASE })
    const secret = await ensureWebSession(h.layout)
    const { finished, port } = await startDaemon(h)
    expect(readFileSync(h.layout.webSessionFile, 'utf8').trim()).toBe(secret)
    if (process.platform !== 'win32') expect(statSync(h.layout.webSessionFile).mode & 0o777).toBe(0o600)
    const reply = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token(h) }),
    })
    const cookie = (reply.headers.get('set-cookie') ?? '').split(';')[0] as string
    expect(reply.headers.get('set-cookie')).toContain('Max-Age=2592000')
    const withCookie = await fetch(`http://127.0.0.1:${port}/api/accounts`, { headers: { Cookie: cookie } })
    expect(withCookie.status).toBe(200)
    h.shutdown()
    expect(await finished).toBe(0)
    expect(h.logs.join('')).not.toContain(secret)
    expect([...h.out, ...h.err].join('\n')).not.toContain(secret)
    // the value issued at sign-in (and its MAC alone) never reaches the logs or the output either
    const value = cookie.split('=')[1] as string
    expect(value).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/)
    const everything = [h.logs.join(''), ...h.out, ...h.err].join('\n')
    expect(everything).not.toContain(value)
    expect(everything).not.toContain(value.split('.')[1] as string)
  })

  it('creates the token when the daemon starts for the first time', async () => {
    const h = await makeHarness({ config: BASE })
    expect(existsSync(h.layout.webTokenFile)).toBe(false)
    const { finished, port } = await startDaemon(h)
    expect(token(h)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    if (process.platform !== 'win32') expect(statSync(h.layout.webTokenFile).mode & 0o777).toBe(0o600)
    expect((await get(port as number, '/api/accounts', token(h))).status).toBe(200)
    h.shutdown()
    expect(await finished).toBe(0)
  })

  it('a port that is already in use does not stop the daemon: it says so, and the accounts keep running', async () => {
    const busy = net.createServer()
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve))
    const taken = (busy.address() as net.AddressInfo).port
    try {
      const h = await makeHarness({ config: BASE, web: { port: taken } })
      await link(h)
      h.connection.onStart = () => h.connection.emit({ state: 'connected' })
      const finished = run(h, 'daemon')
      await waitFor(() => expect(h.out.join('\n')).toContain('Daemon running'))
      expect(events(h).find((e) => e.event === 'web.failed')).toMatchObject({
        level: 'error',
        code: 'EADDRINUSE',
        host: '127.0.0.1',
        port: taken,
      })
      expect(h.err.join('\n')).toContain(`The web could not start on 127.0.0.1:${taken} (EADDRINUSE)`)
      expect(events(h).some((e) => e.event === 'web.listening')).toBe(false)
      await waitFor(() => expect(h.connection.calls).toContain('start'))
      h.shutdown()
      expect(await finished).toBe(0)
    } finally {
      busy.close()
    }
  })

  it('records the address it is really bound to (0600) for `open`, and removes it when it stops', async () => {
    const h = await makeHarness({ config: BASE })
    const { finished, port } = await startDaemon(h)
    expect(await readWebAddress(h.layout)).toEqual({ host: '127.0.0.1', port })
    if (process.platform !== 'win32') expect(statSync(h.layout.webAddressFile).mode & 0o777).toBe(0o600)
    expect(await run(h, 'open', '--print')).toBe(0)
    expect(h.out.at(-1)).toContain(`http://127.0.0.1:${port}/#token=`)
    h.shutdown()
    expect(await finished).toBe(0)
    expect(existsSync(h.layout.webAddressFile)).toBe(false)
  })

  it('removes an address a crashed daemon left behind, and leaves none when the web is off or cannot start', async () => {
    const off = await makeHarness({ config: { ...BASE, web: { enabled: false } } })
    await writeWebAddress(off.layout, { host: '127.0.0.1', port: 9999 })
    const offRun = run(off, 'daemon')
    await waitFor(() => expect(off.out.join('\n')).toContain('Daemon running'))
    expect(existsSync(off.layout.webAddressFile)).toBe(false)
    expect(await run(off, 'open')).toBe(1)
    off.shutdown()
    await offRun

    const busy = net.createServer()
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve))
    try {
      const taken = (busy.address() as net.AddressInfo).port
      const h = await makeHarness({ config: { ...BASE, web: { port: taken } }, web: { port: taken } })
      await writeWebAddress(h.layout, { host: '127.0.0.1', port: taken })
      const finished = run(h, 'daemon')
      await waitFor(() => expect(h.out.join('\n')).toContain('Daemon running'))
      expect(existsSync(h.layout.webAddressFile)).toBe(false)
      // the program that holds the port never gets the token
      expect(await run(h, 'open')).toBe(1)
      expect(h.browserOpened).toEqual([])
      h.shutdown()
      await finished
    } finally {
      busy.close()
    }
  })

  it('does not open the database of an account that link holds, and reports it without facts', async () => {
    const h = await makeHarness({ config: BASE, accounts: ['alpha', 'beta'] })
    const alpha = h.runtime('alpha')
    alpha.identity.bind(ME)
    alpha.close()
    const beta = h.runtime('beta')
    beta.identity.bind(ME)
    beta.close()
    const lock = await acquireLinkLock(h.accountOf('alpha'), process.ppid)
    expect(lock.ok).toBe(true)
    const { finished, port } = await startDaemon(h)
    const reply = await get(port as number, '/api/accounts', token(h))
    const body = (await reply.json()) as { accounts: { id: string; maskedNumber: string | null }[] }
    expect(body.accounts.find((a) => a.id === 'alpha')?.maskedNumber).toBeNull()
    expect(body.accounts.find((a) => a.id === 'beta')?.maskedNumber).toBe('+99*******1432')
    h.shutdown()
    await finished
  })

  it('does not recreate the database of an account whose database is gone', async () => {
    const h = await makeHarness({ config: BASE })
    const { finished, port } = await startDaemon(h)
    expect(existsSync(h.account.dbFile)).toBe(false)
    expect((await get(port as number, '/api/accounts', token(h))).status).toBe(200)
    expect(existsSync(h.account.dbFile)).toBe(false)
    h.shutdown()
    await finished
  })

  it('"web.enabled": false starts no server', async () => {
    const h = await makeHarness({ config: { ...BASE, web: { enabled: false } } })
    const finished = run(h, 'daemon')
    await waitFor(() => expect(h.out.join('\n')).toContain('Daemon running'))
    expect(events(h).some((e) => e.event.startsWith('web.'))).toBe(false)
    h.shutdown()
    expect(await finished).toBe(0)
  })

  it('warns when the configured host is not the loopback (the explicit opt-in)', async () => {
    // The network guard of the tests only lets loopback through: this one test declares the wildcard address.
    const revoke = allowNetwork('0.0.0.0')
    try {
      const h = await makeHarness({ config: { ...BASE, web: { host: '0.0.0.0' } }, web: { host: '0.0.0.0', port: 0 } })
      const { finished } = await startDaemon(h)
      expect(h.err.join('\n')).toContain('WARNING: the web listens on 0.0.0.0')
      expect(events(h).find((e) => e.event === 'web.listening')).toMatchObject({ host: '0.0.0.0' })
      h.shutdown()
      expect(await finished).toBe(0)
    } finally {
      revoke()
    }
  })

  it('the web says "not built" at / while there is no build, and the page is in the language of the installation', async () => {
    const h = await makeHarness({ config: { ...BASE, language: 'es' }, web: { staticDir: '/nonexistent/msum-web' } })
    const finished = run(h, 'daemon')
    await waitFor(() => expect(h.out.join('\n')).toContain('Daemon corriendo'))
    const port = events(h).find((e) => e.event === 'web.listening')?.port
    const reply = await fetch(`http://127.0.0.1:${port}/`)
    expect(reply.status).toBe(503)
    expect(await reply.text()).toContain('todavía no está compilada')
    h.shutdown()
    expect(await finished).toBe(0)
  })
})

/** What the running daemon leaves for `open`: the lock and the address its web is bound to. */
async function daemonListening(h: Harness, address: { host: string; port: number }): Promise<void> {
  await acquireDaemonLock(h.layout.lockFile, process.ppid)
  await writeWebAddress(h.layout, address)
}

describe('msum open (RF-82)', () => {
  it('prints the address the daemon recorded, with the token in the fragment, and opens it in the browser', async () => {
    const h = await makeHarness({ config: { ...BASE, web: { port: 1234 } } })
    await daemonListening(h, { host: '127.0.0.1', port: 9123 })
    expect(await run(h, 'open')).toBe(0)
    // the port of the configuration (1234) is not what counts: the recorded one is
    const url = `http://127.0.0.1:9123/#token=${token(h)}`
    expect(h.out).toEqual([`Web address (it holds the access token, do not share it): ${url}`])
    expect(h.browserOpened).toEqual([url])
    expect(h.err).toEqual([])
  })

  it('--print and --no-browser only print', async () => {
    const h = await makeHarness({ config: BASE })
    await daemonListening(h, { host: '127.0.0.1', port: 8787 })
    expect(await run(h, 'open', '--print')).toBe(0)
    expect(await run(h, 'open', '--no-browser')).toBe(0)
    expect(h.browserOpened).toEqual([])
    expect(h.out).toHaveLength(2)
    expect(h.out[0]).toContain(`http://127.0.0.1:8787/#token=${token(h)}`)
  })

  it('reaches a wildcard address through the loopback, and uses the bound address otherwise', async () => {
    const h = await makeHarness({ config: BASE })
    await daemonListening(h, { host: '0.0.0.0', port: 9000 })
    await run(h, 'open', '--print')
    await writeWebAddress(h.layout, { host: '::', port: 9001 })
    await run(h, 'open', '--print')
    await writeWebAddress(h.layout, { host: '::1', port: 9002 })
    await run(h, 'open', '--print')
    await writeWebAddress(h.layout, { host: '192.168.1.5', port: 9003 })
    await run(h, 'open', '--print')
    expect(h.out.map((line) => /http:\/\/[^/]+\//.exec(line)?.[0])).toEqual([
      'http://127.0.0.1:9000/',
      'http://[::1]:9001/',
      'http://[::1]:9002/',
      'http://192.168.1.5:9003/',
    ])
  })

  it('refuses when no daemon holds the lock, even if a crashed one left its address behind', async () => {
    const h = await makeHarness({ config: BASE })
    await writeWebAddress(h.layout, { host: '127.0.0.1', port: 9123 })
    expect(await run(h, 'open')).toBe(1)
    expect(h.err.join('\n')).toContain('runs inside the daemon')
    expect(h.out).toEqual([])
    expect(h.browserOpened).toEqual([])
    expect(existsSync(h.layout.webTokenFile)).toBe(false)
  })

  it('refuses when the daemon runs but its web is not listening, whatever the configuration says', async () => {
    const h = await makeHarness({ config: { ...BASE, web: { port: 9124 } } })
    await acquireDaemonLock(h.layout.lockFile, process.ppid)
    expect(await run(h, 'open')).toBe(1)
    expect(h.err.join('\n')).toContain('its web is not listening')
    expect(h.out).toEqual([])
    expect(h.browserOpened).toEqual([])
  })

  it('refuses an address file that is not valid', async () => {
    const h = await makeHarness({ config: BASE })
    await acquireDaemonLock(h.layout.lockFile, process.ppid)
    for (const content of ['{nope', '{"host":"127.0.0.1","port":0}', '{"host":"","port":80}', '{"port":80}']) {
      writeFileSync(h.layout.webAddressFile, content)
      expect(await run(h, 'open', '--print')).toBe(1)
    }
    expect(h.out).toEqual([])
  })

  it('keeps the address on screen and fails when the browser cannot be started', async () => {
    const h = await makeHarness({
      config: BASE,
      openUrl: async () => {
        throw Object.assign(new Error('spawn open ENOENT'), { code: 'ENOENT' })
      },
    })
    await daemonListening(h, { host: '127.0.0.1', port: 8787 })
    expect(await run(h, 'open')).toBe(1)
    expect(h.out[0]).toContain('#token=')
    expect(h.err.join('\n')).toContain('could not be opened (ENOENT)')
    expect(h.err.join('\n')).not.toContain('spawn open')
  })

  it('reports an invalid configuration like the other commands', async () => {
    const h = await makeHarness({ config: { ...BASE, web: { port: 0 } } })
    expect(await run(h, 'open')).toBe(2)
    expect(h.err.join('\n')).toContain('web.port')
  })

  it('init creates the token with the configuration, and never replaces it', async () => {
    const h = await makeHarness({ config: null })
    expect(await run(h, 'init')).toBe(0)
    const first = token(h)
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await run(h, 'init')).toBe(0)
    expect(token(h)).toBe(first)
  })

  it('picks the command of each system to open a browser', () => {
    expect(browserCommand('http://x', 'darwin')).toEqual({ command: 'open', args: ['http://x'] })
    expect(browserCommand('http://x', 'linux')).toEqual({ command: 'xdg-open', args: ['http://x'] })
    expect(browserCommand('http://x', 'win32')).toEqual({ command: 'cmd', args: ['/c', 'start', '', 'http://x'] })
  })
})
