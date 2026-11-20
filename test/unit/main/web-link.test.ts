import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runMain } from '../../../src/main/app.js'
import { writeBlocked } from '../../../src/main/blocked.js'
import { acquireDaemonLock } from '../../../src/main/daemon-lock.js'
import { acquireLinkLock } from '../../../src/main/link-lock.js'
import { readUnitState } from '../../../src/main/unit-state.js'
import { disposeHarnesses, type Harness, ME, OTHER, until, waitFor } from '../../support/cli-harness.js'
import { disposeWorlds, QR1, QR2, type World, world } from '../../support/web-world.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const lockOf = (w: World, id: string) => w.h.accountOf(id).linkLockFile
const stateOf = async (w: World, id: string) => (await readUnitState(w.h.accountOf(id).stateFile))?.state
const linkState = async (w: World, id: string) => (await w.api('GET', `/api/accounts/${id}/link`)).body
const waitingForQr = async (w: World, id: string) => {
  expect((await w.api('POST', `/api/accounts/${id}/link`)).status).toBe(202)
  await until(() => w.h.connection.calls.includes('start'), 'the connection to start')
}
const startsOf = (w: World) => w.h.connection.calls.filter((call) => call === 'start').length

/** Every file under a directory, with its text, to look for what must not be there. */
function everyFile(dir: string): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...everyFile(path))
    else found.push({ path, text: readFileSync(path).toString('latin1') })
  }
  return found
}

const message = (id: string, chat: string) => ({
  origin: 'history' as const,
  isGroup: false,
  message: {
    id,
    conversationId: `${chat}@s.whatsapp.net`,
    senderId: `${chat}@s.whatsapp.net`,
    senderName: null,
    senderAddress: '+9911963367943',
    fromMe: false,
    timestamp: Date.now() - 60_000,
    kind: 'text' as const,
    text: `hello from ${chat}`,
    transcript: null,
    read: false,
  },
})

describe('POST /api/accounts', () => {
  it('creates an account (default when no id is given), refuses one that exists and a bad id, behind the token', async () => {
    const w = await world()
    expect((await w.api('POST', '/api/accounts', {}, null)).status).toBe(401)
    expect(await w.api('POST', '/api/accounts', {})).toEqual({ status: 201, body: { id: 'default' } })
    expect(existsSync(w.h.accountOf('default').dir)).toBe(true)
    expect(w.installation.accounts().map((row) => row.id)).toEqual(['default'])
    expect(await w.api('POST', '/api/accounts', {})).toEqual({ status: 409, body: { error: 'accountExists' } })
    expect(await w.api('POST', '/api/accounts', { id: 'work-2' })).toEqual({ status: 201, body: { id: 'work-2' } })
    expect((await w.api('POST', '/api/accounts', { id: '../evil' })).body).toEqual({ error: 'invalidAccountId' })
    expect((await w.api('POST', '/api/accounts', { id: 7 })).body).toEqual({ error: 'invalidRequest' })
    expect((await w.api('POST', '/api/accounts', [])).body).toEqual({ error: 'invalidRequest' })
    await waitFor(async () => {
      const list = (await w.api('GET', '/api/accounts')).body.accounts as { id: string; state: string }[]
      expect(list.map((a) => a.id)).toEqual(['default', 'work-2'])
      expect(list.every((a) => a.state === 'idle')).toBe(true)
    })
  })
})

describe('linking an account from the web (RF-01)', () => {
  it('publishes the QR over SSE, answers the current one on GET, and replaces it when WhatsApp rotates it', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect(await linkState(w, 'alpha')).toEqual({ state: 'idle' })
    expect((await w.api('POST', '/api/accounts/alpha/link', undefined, null)).status).toBe(401)
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    expect(await w.api('POST', '/api/accounts/alpha/link')).toEqual({ status: 202, body: { state: 'waitingQr' } })
    await until(() => w.eventsOf('qr').length === 1, 'the qr event')
    // the event only says that there is a new QR: the credential is drawn on request
    expect(w.eventsOf('qr')[0]?.data).toEqual({ account: 'alpha', seq: 1 })
    expect(await linkState(w, 'alpha')).toEqual({ state: 'qr' })
    expect(w.eventsOf('link').map((e) => e.data.state)).toEqual(['waitingQr', 'qr'])

    w.h.connection.emit({ state: 'qr', qr: QR2 })
    await until(() => w.eventsOf('qr').length === 2, 'the rotated qr')
    expect(w.eventsOf('qr')[1]?.data).toEqual({ account: 'alpha', seq: 2 })
    expect(await linkState(w, 'alpha')).toEqual({ state: 'qr' })
    // a rotation is not a change of state
    expect(w.eventsOf('link').map((e) => e.data.state)).toEqual(['waitingQr', 'qr'])

    // the unit says so, in memory and on disk, and the account is not blocked as `notLinked`
    await waitFor(async () => {
      expect(w.host.accountState('alpha')?.state).toBe('linking')
      expect(await stateOf(w, 'alpha')).toBe('linking')
    })
    expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(false)
    expect(existsSync(lockOf(w, 'alpha'))).toBe(true)
    expect(w.host.isLinking('alpha')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 150)) // several looks of the host
    expect(w.host.accountState('alpha')?.state).toBe('linking')
    expect(w.h.logs.join('\n')).not.toContain('"reason":"linking"')
    expect(w.h.logs.join('\n')).not.toContain('"event":"daemon.blocked"')
    const accounts = w.eventsOf('accounts')
    expect(accounts.some((e) => JSON.stringify(e.data).includes('"state":"linking"'))).toBe(true)
  })

  it('draws the current QR as an SVG behind the token, never cached, and it changes when the QR rotates', async () => {
    const w = await world({ accounts: ['alpha'] })
    const svg = (token?: string | null) =>
      fetch(`http://127.0.0.1:${w.port}/api/accounts/alpha/link/qr.svg?v=1`, {
        headers:
          token === null
            ? {}
            : { Authorization: `Bearer ${token ?? readFileSync(w.h.layout.webTokenFile, 'utf8').trim()}` },
      })
    // no link in progress: no QR
    expect((await svg()).status).toBe(404)
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    await until(() => w.eventsOf('qr').length === 1, 'the qr event')
    expect((await svg(null)).status).toBe(401)
    const first = await svg()
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/svg+xml')
    expect(first.headers.get('cache-control')).toBe('no-store')
    const firstText = await first.text()
    expect(firstText).toContain('<svg')
    expect(firstText).not.toContain('QR-SECRET')
    w.h.connection.emit({ state: 'qr', qr: QR2 })
    await until(() => w.eventsOf('qr').length === 2, 'the rotated qr')
    const secondText = await (await svg()).text()
    expect(secondText).toContain('<svg')
    expect(secondText).not.toBe(firstText)
    // an unknown account is a 404 too
    expect((await w.api('GET', '/api/accounts/nope/link/qr.svg')).status).toBe(404)
    // after cancelling there is nothing to draw
    expect((await w.api('DELETE', '/api/accounts/alpha/link')).status).toBe(200)
    expect((await svg()).status).toBe(404)
  })

  it('never writes the QR to disk, to a log or to the output', async () => {
    const w = await world({ accounts: ['alpha'] })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    await until(() => w.eventsOf('qr').length === 1, 'the qr event')
    w.h.connection.emit({ state: 'qr', qr: QR2 })
    await until(() => w.eventsOf('qr').length === 2, 'the rotated qr')
    expect(existsSync(w.h.accountOf('alpha').qrFile)).toBe(false)
    const seen = [...w.h.logs, ...w.h.out, ...w.h.err].join('\n')
    for (const qr of [QR1, QR2]) expect(seen).not.toContain(qr)
    for (const file of everyFile(w.h.layout.dataDir)) {
      expect(file.text, file.path).not.toContain('QR-SECRET')
    }
    // nor does it travel anywhere but the image: not in the accounts list, the link state or any event
    expect(JSON.stringify((await w.api('GET', '/api/accounts')).body)).not.toContain('QR-SECRET')
    expect(JSON.stringify((await w.api('GET', '/api/accounts/alpha/link')).body)).not.toContain('QR-SECRET')
    for (const event of w.sse) {
      expect(JSON.stringify(event), event.event).not.toContain('QR-SECRET')
    }
    expect(w.eventsOf('link').length).toBeGreaterThan(0)
    expect(w.eventsOf('accounts').length).toBeGreaterThan(0)
    expect(await w.api('DELETE', '/api/accounts/alpha/link')).toMatchObject({ status: 200 })
    expect(existsSync(w.h.accountOf('alpha').qrFile)).toBe(false)
  })

  it('on connected binds the account, shows the progress of the sync and goes on as a running unit without reopening the socket', async () => {
    const w = await world({ accounts: ['alpha'] })
    // the flow waits for the history to be quiet: a generous window, so a slow machine does not end it between events
    Object.assign(w.h.ctx.linkTiming, {
      quietMs: 250,
      minAfterConnectMs: 0,
      maxAfterConnectMs: 20_000,
      syncPublishMs: 40,
    })
    await writeBlocked(w.h.accountOf('alpha').blockedFile, 'notLinked', 1)
    w.h.connection.calls.length = 0
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    writeFileSync(join(w.h.accountOf('alpha').authDir, 'creds.json'), JSON.stringify({ me: { id: ME } }))
    w.h.connection.emit({ state: 'connected' })
    await until(() => w.eventsOf('link').some((e) => e.data.state === 'syncing'), 'syncing')
    expect(await linkState(w, 'alpha')).toMatchObject({ state: 'syncing', sync: { done: false } })
    // the block of an account that was freshly linked no longer applies
    expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(false)

    for (const [id, chat] of [
      ['m1', 'chat-a'],
      ['m2', 'chat-a'],
      ['m3', 'chat-b'],
    ] as const) {
      expect(await w.h.connection.receive(message(id, chat))).toBe(true)
    }
    await until(() => w.eventsOf('sync').some((e) => e.data.messages === 3), 'the progress of the sync')
    const last = w.eventsOf('sync').filter((e) => e.data.messages === 3)[0]?.data
    expect(last).toMatchObject({ account: 'alpha', chats: 2, messages: 3, done: false })
    expect(JSON.stringify(w.sse)).not.toContain('hello from') // counts only, never a text

    await until(() => w.eventsOf('link').some((e) => e.data.state === 'done'), 'done')
    const syncs = w.eventsOf('sync')
    expect(syncs.at(-1)?.data).toMatchObject({ chats: 2, messages: 3, done: true })
    // throttled: never more often than the window
    expect(syncs.length).toBeLessThan(6)
    expect(await linkState(w, 'alpha')).toEqual({ state: 'done', sync: { chats: 2, messages: 3, done: true } })
    // the qr is gone from the state once it was scanned
    expect(JSON.stringify(await linkState(w, 'alpha'))).not.toContain('QR-SECRET')

    // the unit took the socket over: one start, no stop, state connected, lock released, schedules loop running
    await waitFor(async () => {
      expect(w.host.accountState('alpha')?.state).toBe('connected')
      expect(await stateOf(w, 'alpha')).toBe('connected')
    })
    expect(w.host.running).toEqual(['alpha'])
    expect(w.h.connection.calls).toEqual(['clearSession', 'start']) // the block was of a kind linking replaces
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
    expect(w.host.isLinking('alpha')).toBe(false)
    await waitFor(async () => {
      const list = (await w.api('GET', '/api/accounts')).body.accounts as { maskedNumber: string | null }[]
      expect(list[0]?.maskedNumber).toBe('+99*******1432')
    })
    // the number appeared in an `accounts` snapshot without anything else changing state
    expect(w.eventsOf('accounts').some((e) => JSON.stringify(e.data).includes('+99*******1432'))).toBe(true)
    // and the unit works as any other: what arrives is captured
    expect(await w.h.connection.receive(message('m4', 'chat-c'))).toBe(true)
    expect(w.h.connection.sent).toEqual([])
  })

  it('a scanned phone that is another account clears the session, reports it and leaves the account idle', async () => {
    const w = await world({ accounts: ['alpha'] })
    const runtime = w.h.runtime('alpha')
    runtime.identity.bind(OTHER)
    runtime.close()
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    writeFileSync(join(w.h.accountOf('alpha').authDir, 'creds.json'), JSON.stringify({ me: { id: ME } }))
    w.h.connection.emit({ state: 'connected' })
    await until(() => w.eventsOf('link').some((e) => e.data.state === 'failed'), 'the failure')
    expect(w.eventsOf('link').at(-1)?.data).toEqual({ account: 'alpha', state: 'failed', error: 'mismatch' })
    expect(await linkState(w, 'alpha')).toEqual({ state: 'failed', error: 'mismatch' })
    expect(w.h.connection.calls).toContain('clearSession')
    expect(readdirSync(w.h.accountOf('alpha').authDir)).toEqual([])
    await waitFor(() => expect(w.host.accountState('alpha')?.state).toBe('idle'))
    expect(w.host.running).toEqual([])
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
    expect(w.eventsOf('sync')).toEqual([])
  })

  it('a socket with no phone number fails as noAccount', async () => {
    const w = await world({ accounts: ['alpha'] })
    w.h.connection.user = undefined
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'connected' })
    await waitingForQr(w, 'alpha')
    await until(() => w.eventsOf('link').some((e) => e.data.state === 'failed'), 'the failure')
    expect(w.eventsOf('link').at(-1)?.data).toMatchObject({ error: 'noAccount' })
    expect(w.h.connection.calls).toContain('clearSession')
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
  })

  it('a QR that nobody scans times out: the connection is stopped, the lock released and the partial session deleted', async () => {
    const w = await world({ accounts: ['alpha'] })
    Object.assign(w.h.ctx.linkTiming, { connectTimeoutMs: 80 })
    // what a link interrupted before the phone confirmed it leaves: credentials with no registered account
    writeFileSync(join(w.h.accountOf('alpha').authDir, 'creds.json'), JSON.stringify({ noiseKey: 'x' }))
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    await until(() => w.eventsOf('link').some((e) => e.data.state === 'failed'), 'the timeout')
    expect(w.eventsOf('link').at(-1)?.data).toEqual({ account: 'alpha', state: 'failed', error: 'timeout' })
    expect(w.h.connection.calls).toContain('stop')
    expect(w.h.connection.calls).toContain('clearSession')
    expect(readdirSync(w.h.accountOf('alpha').authDir)).toEqual([])
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
    expect(w.installation.accounts().map((row) => row.id)).toEqual(['alpha']) // the account stays, empty
    expect(JSON.stringify(await linkState(w, 'alpha'))).not.toContain('QR-SECRET')
    await waitFor(() => expect(w.host.accountState('alpha')?.state).toBe('idle'))
  })

  it('reports a logged-out or failed socket by code', async () => {
    const w = await world({ accounts: ['alpha'] })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    w.h.connection.emit({ state: 'loggedOut' })
    await until(() => w.eventsOf('link').some((e) => e.data.error === 'loggedOut'), 'loggedOut')
    await waitFor(() => expect(existsSync(lockOf(w, 'alpha'))).toBe(false))
    w.sse.length = 0
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'error', reason: 'forbidden' })
    await waitingForQr(w, 'alpha')
    await until(() => w.eventsOf('link').some((e) => e.data.error === 'forbidden'), 'forbidden')
  })

  it('DELETE cancels a link in progress: connection stopped, lock released, nothing left; 409 when there is none', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect(await w.api('DELETE', '/api/accounts/alpha/link')).toEqual({ status: 409, body: { error: 'notLinking' } })
    expect((await w.api('DELETE', '/api/accounts/ghost/link')).status).toBe(404)
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    expect(await w.api('DELETE', '/api/accounts/alpha/link')).toEqual({ status: 200, body: { ok: true } })
    await until(() => w.eventsOf('link').at(-1)?.data.error === 'cancelled', 'the cancelled event')
    expect(w.eventsOf('link').at(-1)?.data).toEqual({ account: 'alpha', state: 'failed', error: 'cancelled' })
    expect(await linkState(w, 'alpha')).toEqual({ state: 'failed', error: 'cancelled' })
    expect(w.h.connection.calls).toContain('stop')
    expect(w.h.connection.calls).toContain('clearSession')
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
    expect(w.host.isLinking('alpha')).toBe(false)
    // and it can be linked again
    expect((await w.api('POST', '/api/accounts/alpha/link')).status).toBe(202)
  })
})

describe('what refuses a link from the web', () => {
  it('inUse: a linked account the daemon is running', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'connected' })
    await w.host.start()
    await waitFor(() => expect(w.host.accountState('alpha')?.state).toBe('connected'))
    expect(await w.api('POST', '/api/accounts/alpha/link')).toEqual({ status: 409, body: { error: 'inUse' } })
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
    expect(startsOf(w)).toBe(1)
    expect(w.h.connection.calls).not.toContain('stop')
    expect(w.host.accountState('alpha')?.state).toBe('connected')
  })

  it('beingLinked: a `msum link` holds the lock; nothing is touched', async () => {
    const w = await world({ accounts: ['alpha'] })
    const cli = await acquireLinkLock(w.h.accountOf('alpha')) // this process: a live pid that is not the host's
    expect(cli.ok).toBe(true)
    expect(await w.api('POST', '/api/accounts/alpha/link')).toEqual({ status: 409, body: { error: 'beingLinked' } })
    expect(w.h.connection.calls).toEqual([])
    expect(existsSync(lockOf(w, 'alpha'))).toBe(true) // the other process's lock is not released by the refusal
    expect(w.host.isLinking('alpha')).toBe(false)
    if (cli.ok) await cli.release()
    expect((await w.api('POST', '/api/accounts/alpha/link')).status).toBe(202)
  })

  it('alreadyLinking: a second request while the first link runs', async () => {
    const w = await world({ accounts: ['alpha'] })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    expect(await w.api('POST', '/api/accounts/alpha/link')).toEqual({ status: 409, body: { error: 'alreadyLinking' } })
    expect(startsOf(w)).toBe(1)
  })

  it('needsRetry: a session that is blocked for a reason retrying fixes', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], blocked: { alpha: 'forbidden' } })
    await waitFor(() => expect(w.host.accountState('alpha')?.state).toBe('blocked'))
    expect(await w.api('POST', '/api/accounts/alpha/link')).toEqual({ status: 409, body: { error: 'needsRetry' } })
    expect(w.h.connection.calls).toEqual([])
    expect(existsSync(join(w.h.accountOf('alpha').authDir, 'creds.json'))).toBe(true)
  })

  it('404 for an account that does not exist or an id that is not one', async () => {
    const w = await world()
    expect((await w.api('POST', '/api/accounts/ghost/link')).status).toBe(404)
    expect((await w.api('POST', '/api/accounts/..%2Fx/link')).status).toBe(404)
    expect((await w.api('GET', '/api/accounts/ghost/link')).status).toBe(404)
  })
})

describe('relinking and retrying from the web (RF-04)', () => {
  it('relinks an account blocked as logged out: the old session goes first, and the block goes when it is linked', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], blocked: { alpha: 'loggedOut' } })
    await waitFor(() =>
      expect(w.host.accountState('alpha')).toMatchObject({ state: 'blocked', blockedReason: 'loggedOut' }),
    )
    w.h.connection.onStart = () => {
      // the old session was cleared BEFORE connecting
      expect(w.h.connection.calls).toEqual(['clearSession', 'start'])
      expect(existsSync(join(w.h.accountOf('alpha').authDir, 'creds.json'))).toBe(false)
      w.h.connection.emit({ state: 'qr', qr: QR1 })
    }
    expect((await w.api('POST', '/api/accounts/alpha/link')).status).toBe(202)
    await until(() => w.eventsOf('qr').length === 1, 'the qr')
    writeFileSync(join(w.h.accountOf('alpha').authDir, 'creds.json'), JSON.stringify({ me: { id: ME } }))
    w.h.connection.emit({ state: 'connected' })
    await until(() => w.eventsOf('link').some((e) => e.data.state === 'done'), 'done')
    expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(false)
    await waitFor(() => expect(w.host.accountState('alpha')).toMatchObject({ state: 'connected', blockedReason: null }))
    expect(w.h.connection.calls.filter((call) => call === 'stop')).toEqual([])
  })

  it('POST retry clears a block retrying fixes, and says why it cannot otherwise', async () => {
    const w = await world({
      accounts: ['alpha', 'beta', 'gamma'],
      linked: ['alpha', 'beta'],
      blocked: { alpha: 'forbidden', beta: 'loggedOut' },
    })
    await waitFor(() => expect(w.host.accountState('alpha')?.state).toBe('blocked'))
    await waitFor(() => expect(w.host.accountState('beta')?.state).toBe('blocked'))
    expect(await w.api('POST', '/api/accounts/beta/retry')).toEqual({ status: 409, body: { error: 'needsRelink' } })
    expect(await w.api('POST', '/api/accounts/gamma/retry')).toEqual({ status: 409, body: { error: 'notBlocked' } })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'connected' })
    expect(await w.api('POST', '/api/accounts/alpha/retry')).toEqual({ status: 200, body: { ok: true } })
    expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(false)
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
    await waitFor(() => expect(w.host.accountState('alpha')?.state).toBe('connected'))
    expect(w.host.accountState('beta')?.state).toBe('blocked')
    const cli = await acquireLinkLock(w.h.accountOf('beta'))
    expect(await w.api('POST', '/api/accounts/beta/retry')).toEqual({ status: 409, body: { error: 'beingLinked' } })
    if (cli.ok) await cli.release()
  })
})

describe('the lock while the daemon links', () => {
  it('refuses `msum link` and `msum unlink` of that account with their usual messages, and releases it at the end', async () => {
    const w = await world({ accounts: ['alpha'] })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    expect(await run(w.h, 'link', '--account', 'alpha')).toBe(1)
    expect(w.h.err.join('\n')).toContain('is being linked or unlinked by another process')
    expect(await run(w.h, 'unlink', '--account', 'alpha', '--yes')).toBe(1)
    expect(w.h.err.filter((line) => line.includes('is being linked or unlinked by another process'))).toHaveLength(2)
    expect(existsSync(lockOf(w, 'alpha'))).toBe(true) // the refusals did not release the host's lock
    expect(w.h.connection.calls).toEqual(['start']) // and the CLI never connected
    await w.api('DELETE', '/api/accounts/alpha/link')
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
  })

  it('shows the state of an account the daemon is linking in `msum status`', async () => {
    const w = await world({ accounts: ['alpha'] })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    await waitFor(async () => expect(await stateOf(w, 'alpha')).toBe('linking'))
    const daemon = await acquireDaemonLock(w.h.layout.lockFile, process.ppid)
    try {
      expect(await run(w.h, 'status')).toBe(0)
      expect(w.h.out.join('\n')).toContain('linking (from the web)')
    } finally {
      if (daemon.ok) await daemon.release()
    }
  })

  it('keeps `msum link` refused for an account in use, with the daemon running', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'connected' })
    await w.host.start()
    await waitFor(() => expect(w.host.accountState('alpha')?.state).toBe('connected'))
    // no daemon lock file exists in this setup (the host runs without the command): the lock check is the host's own
    expect(await w.api('POST', '/api/accounts/alpha/link')).toMatchObject({ status: 409 })
  })

  it('refreshes the lock while linking (its heartbeat)', async () => {
    const w = await world({ accounts: ['alpha'] })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    const first = statSync(lockOf(w, 'alpha')).mtimeMs
    await until(() => statSync(lockOf(w, 'alpha')).mtimeMs > first, 'the heartbeat')
  })

  it('a shutdown during the link stops the connection and releases the lock inside the budget', async () => {
    const w = await world({ accounts: ['alpha'] })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    const began = Date.now()
    await w.web.stop()
    await w.host.stop()
    expect(Date.now() - began).toBeLessThan(1_000)
    expect(w.h.connection.calls).toContain('stop')
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
    expect(w.host.isLinking('alpha')).toBe(false)
    expect(readdirSync(w.h.accountOf('alpha').authDir)).toEqual([])
    expect(await w.host.startLink('alpha')).toEqual({ ok: false, reason: 'unavailable' })
  })
})

/** A link that gets as far as syncing, with a window that is long enough for the test to act inside it. */
async function syncing(w: World, id: string): Promise<void> {
  Object.assign(w.h.ctx.linkTiming, { quietMs: 5_000, minAfterConnectMs: 0, maxAfterConnectMs: 20_000 })
  w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
  await waitingForQr(w, id)
  writeFileSync(join(w.h.accountOf(id).authDir, 'creds.json'), JSON.stringify({ me: { id: ME } }))
  w.h.connection.emit({ state: 'connected' })
  await until(() => w.eventsOf('link').some((e) => e.data.state === 'syncing'), 'syncing')
}

describe('progress of the initial history sync (RF-02)', () => {
  const syncEvents = (w: World) => w.eventsOf('sync').map((e) => e.data)

  it('publishes a percent that never goes back and stays within 0 to 100, in the events and in the snapshot', async () => {
    const w = await world({ accounts: ['alpha'] })
    Object.assign(w.h.ctx.linkTiming, { syncPublishMs: 0 })
    await syncing(w, 'alpha')
    // no percent is claimed before the platform reports one
    expect(await linkState(w, 'alpha')).toMatchObject({ state: 'syncing', sync: { done: false } })
    expect(((await linkState(w, 'alpha')) as { sync: { percent?: number } }).sync.percent).toBeUndefined()
    w.h.connection.emitHistory({ percent: 40, complete: false })
    await until(() => syncEvents(w).some((d) => d.percent === 40), 'the first percent')
    w.h.connection.emitHistory({ percent: 25, complete: false }) // out of order: ignored
    w.h.connection.emitHistory({ percent: null, complete: false })
    w.h.connection.emitHistory({ percent: 250, complete: false }) // clamped
    await until(() => syncEvents(w).some((d) => d.percent === 100), 'the clamped percent')
    const seen = syncEvents(w)
      .map((d) => d.percent)
      .filter((p): p is number => typeof p === 'number')
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.every((p, i) => p >= 0 && p <= 100 && (i === 0 || p >= (seen[i - 1] ?? 0)))).toBe(true)
    expect(seen).not.toContain(25)
    expect(await linkState(w, 'alpha')).toMatchObject({ state: 'syncing', sync: { percent: 100 } })
    await w.api('DELETE', '/api/accounts/alpha/link')
  })

  it('ends the wait as soon as the history reports complete, long before the quiet heuristic would', async () => {
    const w = await world({ accounts: ['alpha'] })
    await syncing(w, 'alpha')
    // a minimum wait of 10 s that a complete history skips, and a short quiet period
    Object.assign(w.h.ctx.linkTiming, { quietMs: 100, minAfterConnectMs: 10_000 })
    const t0 = Date.now()
    w.h.connection.emitHistory({ percent: 100, complete: true, explicit: true })
    await until(() => w.eventsOf('link').some((e) => e.data.state === 'done'), 'done')
    expect(Date.now() - t0).toBeLessThan(3_000)
    const last = syncEvents(w).at(-1)
    expect(last).toMatchObject({ account: 'alpha', done: true, percent: 100 })
    expect(await linkState(w, 'alpha')).toMatchObject({ state: 'done', sync: { done: true, percent: 100 } })
  })

  it('also ends when the completion was inferred (paused), without inventing a percent', async () => {
    const w = await world({ accounts: ['alpha'] })
    await syncing(w, 'alpha')
    Object.assign(w.h.ctx.linkTiming, { quietMs: 100, minAfterConnectMs: 10_000 })
    w.h.connection.emitHistory({ percent: 60, complete: false })
    w.h.connection.emitHistory({ percent: null, complete: true, explicit: false })
    await until(() => w.eventsOf('link').some((e) => e.data.state === 'done'), 'done')
    expect(syncEvents(w).at(-1)).toMatchObject({ done: true, percent: 60 })
  })

  it('after the history reports complete it still waits for the quiet period (a late chunk is captured first)', async () => {
    const w = await world({ accounts: ['alpha'] })
    await syncing(w, 'alpha')
    // First a quiet period that cannot pass: a complete history alone must not end the wait, however slow the machine.
    const quietMs = 1_000
    Object.assign(w.h.ctx.linkTiming, { quietMs: 3_600_000, minAfterConnectMs: 10_000 })
    const isDone = () => w.eventsOf('link').some((e) => e.data.state === 'done')
    w.h.connection.emitHistory({ percent: 100, complete: true, explicit: true })
    const reportedAt = Date.now()
    await until(() => Date.now() - reportedAt >= 200, 'some polls of the flow') // many polls (5 ms each)
    expect(isDone()).toBe(false)
    // Then a normal one: the late chunk is captured first, and the wait ends a full quiet period after it.
    Object.assign(w.h.ctx.linkTiming, { quietMs })
    const beforeLate = Date.now()
    expect(await w.h.connection.receive(message('LATE', 'ana'))).toBe(true)
    await until(isDone, 'done')
    expect(Date.now() - beforeLate).toBeGreaterThanOrEqual(quietMs)
    expect(syncEvents(w).at(-1)).toMatchObject({ done: true, messages: 1 })
  })

  it('falls back to the quiet heuristic when no status ever comes', async () => {
    const w = await world({ accounts: ['alpha'] })
    Object.assign(w.h.ctx.linkTiming, { quietMs: 20, minAfterConnectMs: 0, maxAfterConnectMs: 5_000 })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    writeFileSync(join(w.h.accountOf('alpha').authDir, 'creds.json'), JSON.stringify({ me: { id: ME } }))
    w.h.connection.emit({ state: 'connected' })
    await until(() => w.eventsOf('link').some((e) => e.data.state === 'done'), 'done by quiet period')
    const last = syncEvents(w).at(-1)
    expect(last).toMatchObject({ done: true })
    expect(last?.percent).toBeUndefined()
  })
})

describe('a connection that ends after the account was bound (ban protection)', () => {
  it.each([
    ['forbidden', { state: 'error', reason: 'forbidden' } as const, 'forbidden'],
    ['replaced', { state: 'error', reason: 'replaced' } as const, 'replaced'],
    ['socketFailed', { state: 'error', reason: 'socketFailed' } as const, 'socketFailed'],
    ['loggedOut', { state: 'loggedOut' } as const, 'loggedOut'],
  ])(
    '%s during the sync blocks the account like a daemon would, and opens no second socket',
    async (_name, status, reason) => {
      const atMarker: string[][] = []
      const holder: { w: World | null } = { w: null }
      const w = await world({
        accounts: ['alpha'],
        writeMarker: async (file, why, at) => {
          atMarker.push([...(holder.w?.h.connection.calls ?? [])])
          await writeBlocked(file, why, at)
        },
      })
      holder.w = w
      await syncing(w, 'alpha')
      w.h.connection.emit(status)
      await until(() => w.eventsOf('link').some((e) => e.data.state === 'failed'), 'the failure')
      expect(w.eventsOf('link').at(-1)?.data).toMatchObject({ error: reason })
      await waitFor(() => expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(true))
      expect(JSON.parse(readFileSync(w.h.accountOf('alpha').blockedFile, 'utf8'))).toMatchObject({ reason })
      // the socket was stopped before the marker was written, and the lock goes after
      expect(atMarker[0]).toContain('stop')
      await new Promise((resolve) => setTimeout(resolve, 200)) // many looks of the host
      expect(startsOf(w)).toBe(1)
      expect(w.host.running).toEqual([])
      expect(w.host.accountState('alpha')).toMatchObject({ state: 'blocked', blockedReason: reason })
      expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
    },
  )
})

describe('one operation per account at a time, with the real pid (same-pid locks)', () => {
  it('a retry is refused while a link runs, and its refusal does not release the link lock', async () => {
    const w = await world({ accounts: ['alpha'], ownPid: true })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    expect(await w.api('POST', '/api/accounts/alpha/retry')).toEqual({ status: 409, body: { error: 'alreadyLinking' } })
    expect(existsSync(lockOf(w, 'alpha'))).toBe(true)
    expect(w.h.connection.calls).toEqual(['start'])
    await w.api('DELETE', '/api/accounts/alpha/link')
  })

  it('a link and a retry that come together: one wins, the other is told it is busy', async () => {
    const w = await world({ accounts: ['alpha'], ownPid: true })
    const retry = w.host.retryAccount('alpha')
    expect(await w.host.startLink('alpha')).toEqual({ ok: false, reason: 'busy' })
    expect(await retry).toEqual({ ok: false, reason: 'notBlocked' })
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
    expect(w.h.connection.calls).toEqual([])
    // and the other way round
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    const link = w.host.startLink('alpha')
    expect(await w.host.retryAccount('alpha')).toEqual({ ok: false, reason: 'alreadyLinking' })
    expect(await link).toEqual({ ok: true })
    expect(existsSync(lockOf(w, 'alpha'))).toBe(true)
    await w.host.cancelLink('alpha')
  })
})

describe('a link that is cancelled or stopped before its flow exists', () => {
  it('a shutdown during a slow connection factory opens no socket, waits for the link and releases the lock', async () => {
    const w = await world({ accounts: ['alpha'] })
    w.factory.delayMs = 250
    const order: string[] = []
    const starting = w.host.startLink('alpha').then((result) => {
      order.push('link')
      return result
    })
    await until(() => w.factory.calls === 1, 'the factory to be called')
    await w.host.stop()
    order.push('stopped')
    expect(await starting).toEqual({ ok: false, reason: 'unavailable' })
    expect(order).toEqual(['link', 'stopped']) // the shutdown waited for it
    expect(w.h.connection.calls).toEqual([])
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
    expect(w.host.isLinking('alpha')).toBe(false)
  })

  it('a cancel during a slow connection factory waits for it and opens no socket', async () => {
    const w = await world({ accounts: ['alpha'] })
    w.factory.delayMs = 150
    const starting = w.host.startLink('alpha')
    await until(() => w.factory.calls === 1, 'the factory to be called')
    expect(await w.host.cancelLink('alpha')).toBe(true)
    expect(await starting).toEqual({ ok: false, reason: 'cancelled' })
    expect(w.h.connection.calls).toEqual([])
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
    expect(await linkState(w, 'alpha')).toEqual({ state: 'failed', error: 'cancelled' })
  })
})

describe('cancelling once the account is bound', () => {
  it('stops waiting for the history and keeps the socket: the unit takes it over, nothing is closed or reopened', async () => {
    const w = await world({ accounts: ['alpha'] })
    await syncing(w, 'alpha')
    expect(await w.api('DELETE', '/api/accounts/alpha/link')).toEqual({ status: 200, body: { ok: true } })
    await until(() => w.eventsOf('link').some((e) => e.data.state === 'done'), 'done')
    expect(w.eventsOf('link').at(-1)?.data).toEqual({ account: 'alpha', state: 'done' })
    await waitFor(() => expect(w.host.accountState('alpha')?.state).toBe('connected'))
    expect(w.host.running).toEqual(['alpha'])
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(w.h.connection.calls).toEqual(['start']) // never stopped, never started again
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
  })
})

describe('the handover of the socket', () => {
  it('a loggedOut in the moment between the link and the unit blocks the account', async () => {
    const w = await world({ accounts: ['alpha'] })
    Object.assign(w.h.ctx.linkTiming, { quietMs: 20, minAfterConnectMs: 0, maxAfterConnectMs: 2_000 })
    // the last progress of the sync is published after the flow stopped watching for its end, before the unit exists
    w.host.onLink((event) => {
      if (event.type === 'sync' && event.done) w.h.connection.emit({ state: 'loggedOut' })
    })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    await waitingForQr(w, 'alpha')
    writeFileSync(join(w.h.accountOf('alpha').authDir, 'creds.json'), JSON.stringify({ me: { id: ME } }))
    w.h.connection.emit({ state: 'connected' })
    // The marker is written in place, so it can be seen empty for a moment: read it until it is complete.
    await waitFor(() =>
      expect(JSON.parse(readFileSync(w.h.accountOf('alpha').blockedFile, 'utf8'))).toMatchObject({
        reason: 'loggedOut',
      }),
    )
    await waitFor(() => expect(w.host.accountState('alpha')?.state).toBe('blocked'))
    expect(w.host.running).toEqual([])
    expect(startsOf(w)).toBe(1)
  })
})

describe('a link that cannot start', () => {
  it('says so: a failed snapshot and a failed event with the code `failed`, the lock released', async () => {
    const w = await world({ accounts: ['alpha'] })
    w.factory.fails = true
    expect((await w.api('POST', '/api/accounts/alpha/link')).status).toBe(500)
    expect(await linkState(w, 'alpha')).toEqual({ state: 'failed', error: 'failed' })
    await until(() => w.eventsOf('link').some((e) => e.data.state === 'failed'), 'the failed event')
    expect(w.eventsOf('link').at(-1)?.data).toEqual({ account: 'alpha', state: 'failed', error: 'failed' })
    expect(existsSync(lockOf(w, 'alpha'))).toBe(false)
    expect(w.host.isLinking('alpha')).toBe(false)
  })

  it('keeps a block that was only in memory when the start fails after it was forgotten', async () => {
    const w = await world({
      accounts: ['alpha'],
      linked: ['alpha'],
      start: false,
      writeMarker: async () => {
        throw new Error('disk full')
      },
    })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'connected' })
    await w.host.start()
    await waitFor(() => expect(w.host.accountState('alpha')?.state).toBe('connected'))
    w.h.connection.emit({ state: 'loggedOut' }) // blocks; the marker cannot be written: the block is in memory only
    await waitFor(() =>
      expect(w.host.accountState('alpha')).toMatchObject({ state: 'blocked', blockedReason: 'loggedOut' }),
    )
    expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(false)
    const startsBefore = startsOf(w)
    // the factory works, and clearing the old session throws: after the block was forgotten
    const clear = w.h.connection.clearSession
    void clear
    Object.assign(w.h.ctx, {
      connectionFactory: async () => {
        w.h.connection.clearSession = async () => {
          throw new Error('cannot clear')
        }
        return w.h.connection
      },
    })
    expect((await w.api('POST', '/api/accounts/alpha/link')).status).toBe(500)
    expect(w.host.accountState('alpha')).toMatchObject({ state: 'blocked', blockedReason: 'loggedOut' })
    await new Promise((resolve) => setTimeout(resolve, 150)) // looks of the host: no unit on a dead session
    expect(w.host.running).toEqual([])
    expect(startsOf(w)).toBe(startsBefore)
  })
})

describe('POST /api/accounts, the edges', () => {
  it('two requests for the same id: one creates it, the other gets 409', async () => {
    const w = await world()
    const replies = await Promise.all([
      w.api('POST', '/api/accounts', { id: 'twin' }),
      w.api('POST', '/api/accounts', { id: 'twin' }),
    ])
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409])
    expect(w.installation.accounts().map((row) => row.id)).toEqual(['twin'])
  })

  it('503 when the daemon is stopping', async () => {
    const w = await world()
    await w.host.stop()
    expect(await w.api('POST', '/api/accounts', { id: 'late' })).toEqual({
      status: 503,
      body: { error: 'unavailable' },
    })
    expect(w.installation.accounts()).toEqual([])
  })

  it('422 for an account the daemon does not run (--account), so its link would not be a 404', async () => {
    const w = await world({ accounts: ['alpha'], only: 'alpha' })
    expect(await w.api('POST', '/api/accounts', { id: 'beta' })).toEqual({ status: 422, body: { error: 'restricted' } })
    expect(w.installation.accounts().map((row) => row.id)).toEqual(['alpha'])
  })
})
