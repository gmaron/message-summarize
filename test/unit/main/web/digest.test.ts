import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../../../../src/domain/result.js'
import { writeBlocked } from '../../../../src/main/installation/blocked.js'
import { acquireLinkLock } from '../../../../src/main/link/lock.js'
import {
  disposeHarnesses,
  FakeSummarizer,
  NOW,
  SUMMARY,
  seedMessages,
  until,
  waitFor,
} from '../../../support/cli-harness.js'
import { disposeWorlds, QR1, type World, world } from '../../../support/web-world.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

const PRIVATE_TEXT = 'PRIVATE-CHAT-TEXT: dinner with Ana on friday'

/** A summarizer that waits until the test lets it answer. */
function gated() {
  let open: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  const summarizer = new FakeSummarizer(async () => {
    await wait
    return ok(SUMMARY)
  })
  return { summarizer, open }
}

async function seed(w: World, id: string): Promise<void> {
  const runtime = w.h.runtime(id)
  try {
    await seedMessages(runtime, [{ id: `${id}-1`, text: PRIVATE_TEXT, timestamp: Date.now() - 3_600_000 }])
  } finally {
    runtime.close()
  }
}

const started = (w: World, id: string) => until(() => w.host.daemonOf(id) !== undefined, `the unit of ${id}`)
/** Connects the unit and waits until its connection counts as settled (the messages of the offline sync are in). */
async function settle(w: World, id: string): Promise<void> {
  w.h.connection.emit({ state: 'connected' })
  await until(() => w.host.daemonOf(id)?.settled === true, `the connection of ${id} to settle`)
}
const digestEvents = (w: World, id: string) => w.eventsOf('digest').filter((e) => e.data.account === id)
const states = (w: World, id: string) => digestEvents(w, id).map((e) => e.data.state)

/** The last `accounts` snapshot's view of an account. */
function latest(w: World, id: string): Record<string, unknown> | undefined {
  const events = w.eventsOf('accounts')
  const accounts = events.at(-1)?.data.accounts as Record<string, unknown>[] | undefined
  return accounts?.find((a) => a.id === id)
}

function everyFile(dir: string): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...everyFile(path))
    else found.push({ path, text: readFileSync(path).toString('latin1') })
  }
  return found
}

describe('POST /api/accounts/:id/digest (summarize now, RF-63)', () => {
  it('answers 202 at once, publishes started and done with the counts, queues the parts and moves lastDigest', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha')
    await started(w, 'alpha')
    await settle(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/digest', undefined, null)).status).toBe(401)
    expect(latest(w, 'alpha')?.lastDigest ?? null).toBeNull()

    expect(await w.api('POST', '/api/accounts/alpha/digest')).toEqual({ status: 202, body: { state: 'started' } })
    await until(() => states(w, 'alpha').includes('done'), 'the digest to finish')
    expect(states(w, 'alpha')).toEqual(['started', 'done'])
    const done = digestEvents(w, 'alpha')[1]?.data
    expect(done).toMatchObject({ account: 'alpha', state: 'done', summarized: 1, failed: 0 })
    const parts = done?.parts as number
    expect(parts).toBeGreaterThanOrEqual(1)
    const runtime = w.h.runtime('alpha')
    try {
      expect(await runtime.store.getPointer()).not.toBeNull()
    } finally {
      runtime.close()
    }
    // the snapshot after the commit carries the new last digest
    await waitFor(() => expect(typeof latest(w, 'alpha')?.lastDigest).toBe('number'))
    expect(w.h.logs.join('\n')).toContain('"trigger":"manual"')

    // the unit delivers what was queued, to the own chat
    await until(() => w.h.connection.sent.length === parts, 'the delivery')
    expect(w.h.connection.sent.join('\n')).toContain(SUMMARY.resumen)
  })

  it('is deferred, like a scheduled tick, while the unit is not connected: it runs once after the connection settles', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha')
    await started(w, 'alpha')
    // offline: running now would move the pointer past the messages the sync has yet to bring
    expect(await w.api('POST', '/api/accounts/alpha/digest')).toEqual({ status: 202, body: { state: 'deferred' } })
    expect(await w.api('POST', '/api/accounts/alpha/digest')).toEqual({ status: 202, body: { state: 'deferred' } })
    await until(() => states(w, 'alpha').length === 2, 'the deferred events')
    expect(states(w, 'alpha')).toEqual(['deferred', 'deferred'])
    expect(w.eventsOf('digest')[0]?.data).toEqual({ account: 'alpha', state: 'deferred' })
    expect(w.summarizer().requests).toHaveLength(0)
    w.h.connection.emit({ state: 'connected' })
    await until(() => states(w, 'alpha').includes('done'), 'the digest after the connection settled')
    expect(states(w, 'alpha')).toEqual(['deferred', 'deferred', 'started', 'done'])
    await new Promise((resolve) => setTimeout(resolve, 250)) // nothing runs a second time
    expect(states(w, 'alpha').filter((state) => state === 'started')).toHaveLength(1)
    expect(w.summarizer().requests).toHaveLength(1)
  })

  it('is deferred while the connection is open but not settled, and runs when it is', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], timing: { missedRunDelayMs: 400 } })
    await seed(w, 'alpha')
    await started(w, 'alpha')
    w.h.connection.emit({ state: 'connected' })
    expect(await w.api('POST', '/api/accounts/alpha/digest')).toEqual({ status: 202, body: { state: 'deferred' } })
    await until(() => states(w, 'alpha').includes('done'), 'the digest once settled')
    expect(states(w, 'alpha')).toEqual(['deferred', 'started', 'done'])
    expect(w.host.daemonOf('alpha')?.settled).toBe(true)
  })

  it('runs at once when the connection is settled', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], timing: { missedRunDelayMs: 100 } })
    await seed(w, 'alpha')
    await started(w, 'alpha')
    await settle(w, 'alpha')
    expect(await w.api('POST', '/api/accounts/alpha/digest')).toEqual({ status: 202, body: { state: 'started' } })
    await until(() => states(w, 'alpha').includes('done'), 'the digest')
    expect(states(w, 'alpha')).toEqual(['started', 'done'])
    await until(() => w.h.connection.sent.length > 0, 'the delivery')
  })

  it('a deferred request while a digest runs is still a 409 busy', async () => {
    const gate = gated()
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], summarizer: gate.summarizer })
    await seed(w, 'alpha')
    await started(w, 'alpha')
    const daemon = w.host.daemonOf('alpha')
    if (daemon === undefined) throw new Error('no unit')
    const running = daemon.runScheduledDigest('schedule')
    await until(() => gate.summarizer.requests.length === 1, 'the digest to be asked')
    expect(w.h.connection.status.state).not.toBe('connected') // not settled either
    expect(await w.api('POST', '/api/accounts/alpha/digest')).toEqual({ status: 409, body: { error: 'busy' } })
    gate.open()
    await running
  })

  it('reports `empty` when there is nothing to summarize', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await started(w, 'alpha')
    await settle(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/digest')).status).toBe(202)
    await until(() => states(w, 'alpha').includes('empty'), 'the empty digest')
    expect(digestEvents(w, 'alpha')[1]?.data).toMatchObject({ state: 'empty', summarized: 0, parts: 0 })
  })

  it('is a 409 busy at once while a digest runs, a scheduled one included, and a second run never starts', async () => {
    const gate = gated()
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], summarizer: gate.summarizer })
    await seed(w, 'alpha')
    await started(w, 'alpha')
    await settle(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/digest')).status).toBe(202)
    await until(() => gate.summarizer.requests.length === 1, 'the summarizer to be asked')
    expect(await w.api('POST', '/api/accounts/alpha/digest')).toEqual({ status: 409, body: { error: 'busy' } })
    gate.open()
    await until(() => states(w, 'alpha').includes('done'), 'the digest to finish')
    expect(gate.summarizer.requests).toHaveLength(1)

    // a scheduled run in progress makes it busy too, and publishes the same events
    const second = gated()
    const w2 = await world({ accounts: ['beta'], linked: ['beta'], summarizer: second.summarizer })
    await seed(w2, 'beta')
    await started(w2, 'beta')
    await settle(w2, 'beta')
    const daemon = w2.host.daemonOf('beta')
    if (daemon === undefined) throw new Error('no unit')
    const scheduled = daemon.runScheduledDigest('schedule')
    await until(() => second.summarizer.requests.length === 1, 'the scheduled digest to be asked')
    expect(await w2.api('POST', '/api/accounts/beta/digest')).toEqual({ status: 409, body: { error: 'busy' } })
    second.open()
    expect(await scheduled).toBe('ran')
    await until(() => states(w2, 'beta').includes('done'), 'the scheduled digest events')
    expect(states(w2, 'beta')).toEqual(['started', 'done'])
  })

  it('publishes the events of a scheduled and of a missed run too, and `busy` for one that is skipped', async () => {
    const gate = gated()
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], summarizer: gate.summarizer })
    await seed(w, 'alpha')
    await started(w, 'alpha')
    const daemon = w.host.daemonOf('alpha')
    if (daemon === undefined) throw new Error('no unit')
    const first = daemon.runScheduledDigest('missed')
    await until(() => gate.summarizer.requests.length === 1, 'the digest to be asked')
    expect(await daemon.runScheduledDigest('schedule')).toBe('busy')
    gate.open()
    expect(await first).toBe('ran')
    await until(() => states(w, 'alpha').includes('done'), 'the events')
    expect(states(w, 'alpha')).toEqual(['started', 'busy', 'done'])
  })

  it('is a 409 notRunning when the account has no running unit, and a 404 for one that does not exist', async () => {
    const w = await world({
      accounts: ['alpha', 'beta', 'gamma'],
      linked: ['alpha', 'gamma'],
      blocked: { gamma: 'forbidden' },
    })
    await started(w, 'alpha')
    // not linked: no unit
    expect(await w.api('POST', '/api/accounts/beta/digest')).toEqual({ status: 409, body: { error: 'notRunning' } })
    // blocked: no unit either
    expect(await w.api('POST', '/api/accounts/gamma/digest')).toEqual({ status: 409, body: { error: 'notRunning' } })
    expect(await w.api('POST', '/api/accounts/ghost/digest')).toEqual({ status: 404, body: { error: 'notFound' } })
    expect((await w.api('POST', '/api/accounts/..%2Fx/digest')).status).toBe(404)
    expect(w.eventsOf('digest')).toEqual([])
    // a daemon that is stopping runs nothing new
    await w.host.stop()
    expect(await w.api('POST', '/api/accounts/alpha/digest')).toEqual({ status: 409, body: { error: 'notRunning' } })
  })

  it('reports noProvider as a failed event with the code, and nothing is queued', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], summarizer: null })
    await started(w, 'alpha')
    await settle(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/digest')).status).toBe(202)
    await until(() => states(w, 'alpha').includes('failed'), 'the failure')
    expect(digestEvents(w, 'alpha')[1]?.data).toEqual({ account: 'alpha', state: 'failed', error: 'noProvider' })
    const runtime = w.h.runtime('alpha')
    try {
      expect(runtime.store.pendingOutbox()).toEqual([])
    } finally {
      runtime.close()
    }
  })

  it('reports a promptFile that cannot be read with its code', async () => {
    const w = await world({
      accounts: ['alpha'],
      linked: ['alpha'],
      config: {
        language: 'en',
        timezone: 'UTC',
        provider: { primary: 'claude-cli' },
        promptFile: 'missing-prompt.txt',
      },
    })
    await started(w, 'alpha')
    await settle(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/digest')).status).toBe(202)
    await until(() => states(w, 'alpha').includes('failed'), 'the failure')
    expect(digestEvents(w, 'alpha')[1]?.data).toEqual({ account: 'alpha', state: 'failed', error: 'promptFile' })
    // the path does not travel in the event nor reach the logs of the digest
    expect(JSON.stringify(w.sse)).not.toContain('missing-prompt')
  })

  it('a shutdown during a digest stays inside the budget', async () => {
    const gate = gated()
    const w = await world({
      accounts: ['alpha'],
      linked: ['alpha'],
      summarizer: gate.summarizer,
      timing: { shutdownGraceMs: 300 },
    })
    await seed(w, 'alpha')
    await started(w, 'alpha')
    await settle(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/digest')).status).toBe(202)
    await until(() => gate.summarizer.requests.length === 1, 'the summarizer to be asked')
    const begun = Date.now()
    await w.web.stop()
    await w.host.stop()
    expect(Date.now() - begun).toBeLessThan(1_500)
    gate.open()
  })
})

describe('preview (RF-64)', () => {
  it('answers 202, then GET gives the parts; the pointer and the outbox are untouched and the event has no content', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha')
    await started(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/preview', undefined, null)).status).toBe(401)
    expect((await w.api('GET', '/api/accounts/alpha/preview', undefined, null)).status).toBe(401)
    expect(await w.api('GET', '/api/accounts/alpha/preview')).toEqual({ status: 200, body: { state: 'none' } })
    expect(await w.api('POST', '/api/accounts/ghost/preview')).toEqual({ status: 404, body: { error: 'notFound' } })

    expect(await w.api('POST', '/api/accounts/alpha/preview')).toEqual({ status: 202, body: { state: 'running' } })
    await until(() => w.eventsOf('preview').length === 1, 'the preview event')
    expect(w.eventsOf('preview')[0]?.data).toEqual({ account: 'alpha', state: 'done' })
    const view = (await w.api('GET', '/api/accounts/alpha/preview')).body
    expect(view).toMatchObject({ state: 'done', summarized: 1, failed: 0 })
    expect(typeof view.generatedAt).toBe('number')
    expect((view.parts as string[]).join('\n')).toContain(SUMMARY.resumen)

    const runtime = w.h.runtime('alpha')
    try {
      expect(await runtime.store.getPointer()).toBeNull()
      expect(runtime.store.pendingOutbox()).toEqual([])
    } finally {
      runtime.close()
    }
    // no digest event (it was not a digest), and the private text is nowhere but in the answer of GET
    expect(w.eventsOf('digest')).toEqual([])
    expect(JSON.stringify(w.sse)).not.toContain(SUMMARY.resumen)
    expect(JSON.stringify(w.sse)).not.toContain(PRIVATE_TEXT)
    const logs = w.h.logs.join('\n')
    expect(logs).not.toContain(SUMMARY.resumen)
    expect(logs).not.toContain('PRIVATE-CHAT-TEXT')
    expect(logs).toContain('"event":"preview.finished"')
    // never written anywhere (the message text is in the database; the summary exists only in memory)
    for (const file of everyFile(w.h.layout.dataDir)) expect(file.text, file.path).not.toContain(SUMMARY.resumen)
    // a real digest is still possible afterwards: the window is the same
    await settle(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/digest')).status).toBe(202)
    await until(() => states(w, 'alpha').includes('done'), 'the digest')
    expect(digestEvents(w, 'alpha')[1]?.data).toMatchObject({ summarized: 1 })
  })

  it('is a 409 busy while one runs, shows running, and a new preview discards the previous result', async () => {
    const gate = gated()
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], summarizer: gate.summarizer })
    await seed(w, 'alpha')
    await started(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/preview')).status).toBe(202)
    expect(await w.api('POST', '/api/accounts/alpha/preview')).toEqual({ status: 409, body: { error: 'busy' } })
    expect(await w.api('GET', '/api/accounts/alpha/preview')).toEqual({ status: 200, body: { state: 'running' } })
    gate.open()
    await until(() => w.eventsOf('preview').length === 1, 'the preview')
    expect((await w.api('GET', '/api/accounts/alpha/preview')).body.state).toBe('done')
    // another one: the earlier result is gone while it runs
    expect((await w.api('POST', '/api/accounts/alpha/preview')).status).toBe(202)
    const during = (await w.api('GET', '/api/accounts/alpha/preview')).body
    expect(during.state === 'running' || during.state === 'done').toBe(true)
    await until(() => w.eventsOf('preview').length === 2, 'the second preview')
  })

  it('works without a unit (a temporary runtime), also for an account with no database or no messages', async () => {
    const w = await world({ accounts: ['alpha', 'beta', 'gamma'] })
    await seed(w, 'alpha') // not linked: it has a database and no unit
    expect(w.host.daemonOf('alpha')).toBeUndefined()
    expect((await w.api('POST', '/api/accounts/alpha/preview')).status).toBe(202)
    await until(() => w.eventsOf('preview').length === 1, 'the preview')
    expect((await w.api('GET', '/api/accounts/alpha/preview')).body).toMatchObject({ state: 'done', summarized: 1 })
    // no unit was created, no connection opened and nothing queued
    expect(w.host.daemonOf('alpha')).toBeUndefined()
    expect(w.factory.calls).toBe(0)
    // an account whose database does not exist has nothing to summarize: none is created for it
    expect(existsSync(w.h.accountOf('gamma').dbFile)).toBe(false)
    expect((await w.api('POST', '/api/accounts/gamma/preview')).status).toBe(202)
    await until(() => w.eventsOf('preview').length === 2, 'the second preview')
    expect(w.eventsOf('preview')[1]?.data).toEqual({ account: 'gamma', state: 'empty' })
    expect(await w.api('GET', '/api/accounts/gamma/preview')).toMatchObject({ body: { state: 'empty', parts: [] } })
    expect(existsSync(w.h.accountOf('gamma').dbFile)).toBe(false)
  })

  it('reports noProvider as a failed event with the code', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], summarizer: null })
    await started(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/preview')).status).toBe(202)
    await until(() => w.eventsOf('preview').length === 1, 'the preview')
    expect(w.eventsOf('preview')[0]?.data).toEqual({ account: 'alpha', state: 'failed', error: 'noProvider' })
    expect((await w.api('GET', '/api/accounts/alpha/preview')).body).toMatchObject({
      state: 'failed',
      error: 'noProvider',
    })
  })

  it('is refused while a link of this host or another process holds the account, and for an invalid configuration', async () => {
    const w = await world({ accounts: ['alpha', 'beta', 'gamma'] })
    // another process holds the lock
    const lock = await acquireLinkLock(w.h.accountOf('beta'), process.ppid)
    if (!lock.ok) throw new Error('lock refused')
    expect(await w.api('POST', '/api/accounts/beta/preview')).toEqual({ status: 409, body: { error: 'beingLinked' } })
    await lock.release()
    // the host itself is linking it
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    expect((await w.api('POST', '/api/accounts/alpha/link')).status).toBe(202)
    expect(await w.api('POST', '/api/accounts/alpha/preview')).toEqual({ status: 409, body: { error: 'busy' } })
    expect((await w.api('DELETE', '/api/accounts/alpha/link')).status).toBe(200)
    // an account whose own configuration is not valid
    const { writeFileSync } = await import('node:fs')
    writeFileSync(w.h.accountOf('gamma').configFile, '{ not json')
    expect(await w.api('POST', '/api/accounts/gamma/preview')).toEqual({
      status: 422,
      body: { error: 'invalidConfig' },
    })
    // none of the refusals left a result behind
    expect((await w.api('GET', '/api/accounts/beta/preview')).body).toEqual({ state: 'none' })
  })

  it('does not outlive its account: deleted and created again with the same id, the old summary is not served', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha')
    await started(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/preview')).status).toBe(202)
    await until(() => w.eventsOf('preview').length === 1, 'the preview')
    expect((await w.api('GET', '/api/accounts/alpha/preview')).body.state).toBe('done')
    await w.host.stop() // nothing of the account is open: it can be deleted (what `msum unlink` leaves)
    await w.installation.deleteAccount('alpha')
    await new Promise((resolve) => setTimeout(resolve, 10))
    await w.installation.createAccount('alpha')
    expect(await w.api('GET', '/api/accounts/alpha/preview')).toEqual({ status: 200, body: { state: 'none' } })
  })

  it('a new link of the account drops its preview', async () => {
    const w = await world({ accounts: ['alpha'] })
    await seed(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/preview')).status).toBe(202)
    await until(() => w.eventsOf('preview').length === 1, 'the preview')
    expect((await w.api('GET', '/api/accounts/alpha/preview')).body.state).toBe('done')
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    expect((await w.api('POST', '/api/accounts/alpha/link')).status).toBe(202)
    expect((await w.api('GET', '/api/accounts/alpha/preview')).body).toEqual({ state: 'none' })
    expect((await w.api('DELETE', '/api/accounts/alpha/link')).status).toBe(200)
  })

  it('is discarded after its time to live', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], previewTtlMs: 80 })
    await seed(w, 'alpha')
    await started(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/preview')).status).toBe(202)
    await until(() => w.eventsOf('preview').length === 1, 'the preview')
    await until(async () => (await w.api('GET', '/api/accounts/alpha/preview')).body.state === 'none', 'the expiry')
  })

  it('a shutdown during a preview stays inside the budget and keeps nothing', async () => {
    const gate = gated()
    const w = await world({
      accounts: ['alpha', 'beta'],
      linked: ['alpha'],
      summarizer: gate.summarizer,
      timing: { shutdownGraceMs: 300 },
    })
    await seed(w, 'alpha')
    await seed(w, 'beta')
    await started(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/preview')).status).toBe(202) // on the unit's runtime
    expect((await w.api('POST', '/api/accounts/beta/preview')).status).toBe(202) // on a temporary runtime
    await until(() => gate.summarizer.requests.length === 2, 'both previews to be asked')
    const begun = Date.now()
    await w.web.stop()
    await w.host.stop()
    expect(Date.now() - begun).toBeLessThan(1_500)
    gate.open()
    await new Promise((resolve) => setTimeout(resolve, 100))
    // what finished after the stop was neither announced nor kept
    expect(w.eventsOf('preview')).toEqual([])
    expect(w.h.logs.join('\n')).not.toContain('"event":"preview.finished"')
  })
})

describe('the accounts snapshot follows the digest and the blocked reason (RF-71)', () => {
  it('publishes a snapshot when a block changes its reason while the account stays blocked', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], blocked: { alpha: 'forbidden' } })
    await waitFor(() =>
      expect(latest(w, 'alpha')?.blockedReason ?? w.host.accountState('alpha')?.blockedReason).toBe('forbidden'),
    )
    await writeBlocked(w.h.accountOf('alpha').blockedFile, 'replaced', 7)
    await waitFor(() => expect(latest(w, 'alpha')?.blockedReason).toBe('replaced'))
    expect(latest(w, 'alpha')?.state).toBe('blocked')
  })

  it('a digest moves lastDigest in the snapshot without anything else changing', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha')
    await started(w, 'alpha')
    await settle(w, 'alpha')
    expect(NOW).toBeGreaterThan(0)
    const before = w.eventsOf('accounts').length
    expect((await w.api('POST', '/api/accounts/alpha/digest')).status).toBe(202)
    await until(() => states(w, 'alpha').includes('done'), 'the digest')
    await waitFor(() => {
      expect(w.eventsOf('accounts').length).toBeGreaterThan(before)
      expect(typeof latest(w, 'alpha')?.lastDigest).toBe('number')
    })
  })
})

describe('the test harness gives every unit a clean connection status', () => {
  it('does not feed a status left by an earlier unit to the one that starts next', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    w.h.connection.status = { state: 'loggedOut' } // what a previous unit of the shared fake left behind
    await w.host.start()
    await started(w, 'alpha')
    expect(w.host.accountState('alpha')?.state).not.toBe('blocked')
    expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(false)
    expect(w.h.connection.status).toEqual({ state: 'stopped' })
  })
})
