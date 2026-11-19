import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ok } from '../../../src/domain/result.js'
import { ALL_WEEKDAYS, makeSchedule } from '../../../src/domain/schedule.js'
import { type Installation, openInstallation } from '../../../src/main/accounts.js'
import { runMain } from '../../../src/main/app.js'
import { type BlockedReason, writeBlocked } from '../../../src/main/blocked.js'
import { DaemonHost, type DaemonHostTiming } from '../../../src/main/daemon-host.js'
import { acquireDaemonLock } from '../../../src/main/daemon-lock.js'
import { acquireLinkLock } from '../../../src/main/link-lock.js'
import { readUnitState, writeUnitState } from '../../../src/main/unit-state.js'
import {
  BA,
  disposeHarnesses,
  FakeConnection,
  FakeSummarizer,
  type Harness,
  makeHarness,
  NOW,
  SUMMARY,
  until,
  waitFor,
} from '../../support/cli-harness.js'
import { isWindows } from '../../support/platform.js'

const JID: Record<string, string> = {
  alpha: '5491100000011@s.whatsapp.net',
  beta: '5491100000022@s.whatsapp.net',
  gamma: '5491100000033@s.whatsapp.net',
  delta: '5491100000044@s.whatsapp.net',
  idle: '5491100000055@s.whatsapp.net',
  blocked: '5491100000066@s.whatsapp.net',
  stranger: '5491100000099@s.whatsapp.net',
}
const BASE = { language: 'en', timezone: 'UTC', provider: { primary: 'claude-cli' } }
const TIMING: DaemonHostTiming = {
  scheduleReloadMs: 20,
  sweepMs: 40,
  missedRunDelayMs: 100,
  shutdownGraceMs: 1_000,
  unitBackoffMs: 30,
  unitBackoffMaxMs: 60,
}

interface World {
  readonly h: Harness
  readonly conns: Map<string, FakeConnection>
  readonly installation: Installation
  readonly host: DaemonHost
  /** Factory calls the host made (not `link`) per account. */
  readonly hostCalls: string[]
  /** Every runtime the host opened, per account, to see which ones were closed. */
  readonly runtimes: { id: string; db: { isOpen: boolean; close(): void } }[]
  linked(id: string): void
  connection(id: string): FakeConnection
}

const worlds: World[] = []

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.host.stop()
    // A unit whose socket never answered the stop is never closed by the host (it gives up after its budget). Windows
    // cannot delete a directory with an open database file, so what is still open is closed here.
    for (const r of w.runtimes) if (r.db.isOpen) r.db.close()
    w.installation.close()
  }
  disposeHarnesses()
})

interface WorldOptions {
  readonly linked?: readonly string[]
  readonly summarizer?: FakeSummarizer | null
  readonly timing?: DaemonHostTiming
  readonly only?: string | null
  /** Connections connect as soon as they start. Default true. */
  readonly autoConnect?: boolean
  /** Replaces the writer of `blocked.json`, to see when it is called and to make it fail. */
  readonly writeMarker?: (file: string, reason: BlockedReason, at: number) => Promise<void>
  /** Replaces the writer of `state.json`, to make it fail. */
  readonly writeUnitState?: typeof writeUnitState
}

/** An installation with fake sockets, one per account, and a daemon host over it (not started). */
async function world(ids: readonly string[], options: WorldOptions = {}): Promise<World> {
  const h = await makeHarness({
    config: BASE,
    accounts: ids,
    liveClock: true,
    summarizer: options.summarizer === undefined ? new FakeSummarizer() : options.summarizer,
  })
  const conns = new Map<string, FakeConnection>()
  const connection = (id: string): FakeConnection => {
    let conn = conns.get(id)
    if (conn === undefined) {
      conn = new FakeConnection()
      conn.user = { id: JID[id] as string }
      if (options.autoConnect !== false) {
        const made = conn
        made.onStart = () => made.emit({ state: 'connected' })
      }
      conns.set(id, conn)
    }
    return conn
  }
  const hostCalls: string[] = []
  const runtimes: World['runtimes'] = []
  Object.assign(h.ctx, {
    connectionFactory: async (
      runtime: { layout: { id: string }; capture: never; db: { isOpen: boolean; close(): void } },
      hooks: { capture?: unknown },
    ) => {
      const conn = connection(runtime.layout.id)
      if (hooks.capture === undefined) {
        hostCalls.push(runtime.layout.id)
        runtimes.push({ id: runtime.layout.id, db: runtime.db })
      }
      conn.capture = (hooks.capture ?? runtime.capture) as never
      return conn
    },
  })
  const opened = await openInstallation({ layout: h.layout, clock: h.clock })
  if (!opened.ok) throw new Error('refused')
  const w: World = {
    h,
    conns,
    installation: opened.installation,
    hostCalls,
    runtimes,
    connection,
    host: new DaemonHost({
      ctx: h.ctx,
      installation: opened.installation,
      onlyAccount: options.only ?? null,
      language: 'en',
      timing: { ...TIMING, ...options.timing },
      ...(options.writeMarker === undefined ? {} : { writeMarker: options.writeMarker }),
      ...(options.writeUnitState === undefined ? {} : { writeUnitState: options.writeUnitState }),
    }),
    linked: (id) => link(h, id),
  }
  for (const id of ids) connection(id)
  for (const id of options.linked ?? []) link(h, id)
  worlds.push(w)
  return w
}

/** Binds the account to its number and gives it a registered session: what a finished `link` leaves. */
function link(h: Harness, id: string): void {
  const runtime = h.runtime(id)
  runtime.identity.bind(JID[id] as string)
  runtime.close()
  writeFileSync(join(h.accountOf(id).authDir, 'creds.json'), JSON.stringify({ me: { id: JID[id] } }))
}

type LogLine = { event: string; level: string; account?: string; [key: string]: unknown }
const logs = (h: Harness): LogLine[] => h.logs.map((line) => JSON.parse(line) as LogLine)
const named = (h: Harness, event: string, account?: string): LogLine[] =>
  logs(h).filter((e) => e.event === event && (account === undefined || e.account === account))
const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const startsOf = (conn: FakeConnection): number => conn.calls.filter((call) => call === 'start').length
const started = (w: World, id: string) => until(() => named(w.h, 'account.started', id).length > 0, `${id} started`)
const stateOf = async (w: World, id: string) => (await readUnitState(w.h.accountOf(id).stateFile))?.state

/** A message that arrives through a socket. */
const incoming = (id: string, conversation: string, text: string) => ({
  origin: 'live' as const,
  isGroup: false,
  message: {
    id,
    conversationId: `${conversation}@s.whatsapp.net`,
    senderId: `${conversation}@s.whatsapp.net`,
    senderName: null,
    senderAddress: '+5491100000001',
    fromMe: false,
    timestamp: Date.now() - 1_000,
    kind: 'text' as const,
    text,
    transcript: null,
    read: false,
  },
})

const queue = (h: Harness, id: string, ...parts: string[]) => {
  const runtime = h.runtime(id)
  return runtime.store
    .commit({ previousPointer: null, pointer: Date.now(), digest: null, parts })
    .finally(() => runtime.close())
}

describe('one daemon, several accounts (RF-03)', () => {
  it('runs two accounts at once, each with its own connection, state and logs', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'] })
    await w.host.start()
    await Promise.all([started(w, 'alpha'), started(w, 'beta')])
    expect(w.host.running).toEqual(['alpha', 'beta'])
    expect(startsOf(w.connection('alpha'))).toBe(1)
    expect(startsOf(w.connection('beta'))).toBe(1)
    expect(named(w.h, 'daemon.started')).toEqual([expect.objectContaining({ count: 2 })])
    await waitFor(async () => {
      expect(await stateOf(w, 'alpha')).toBe('connected')
      expect(await stateOf(w, 'beta')).toBe('connected')
    })

    // each socket feeds its own account's database
    expect(await w.connection('alpha').receive(incoming('a1', 'chat-a', 'ALPHA ONLY'))).toBe(true)
    expect(await w.connection('beta').receive(incoming('b1', 'chat-b', 'BETA ONLY'))).toBe(true)
    const alpha = w.h.runtime('alpha')
    const beta = w.h.runtime('beta')
    try {
      expect(await alpha.repository.findConversation('chat-a@s.whatsapp.net')).not.toBeNull()
      expect(await alpha.repository.findConversation('chat-b@s.whatsapp.net')).toBeNull()
      expect(await beta.repository.findConversation('chat-b@s.whatsapp.net')).not.toBeNull()
      expect(await beta.repository.findConversation('chat-a@s.whatsapp.net')).toBeNull()
    } finally {
      alpha.close()
      beta.close()
    }

    // every line of a unit carries its account; the daemon's own lines carry none
    const unitLines = logs(w.h).filter((e) => e.event.startsWith('account.') || e.event === 'connection.status')
    expect(unitLines.length).toBeGreaterThan(4)
    for (const line of unitLines) expect(['alpha', 'beta']).toContain(line.account)
    expect(w.h.logs.join('')).not.toContain('5491100000011')
  })

  it('--account runs only that account, ignoring the others', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'], only: 'alpha' })
    await w.host.start()
    await started(w, 'alpha')
    await waitFor(async () => expect(await stateOf(w, 'alpha')).toBe('connected'))
    expect(w.host.running).toEqual(['alpha'])
    expect(w.connection('beta').calls).toEqual([])
    expect(named(w.h, 'daemon.started')[0]).toMatchObject({ count: 1 })
  })

  it('leaves an account that is not linked idle: no unit, no socket, said once', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha'] })
    await w.host.start()
    await started(w, 'alpha')
    await waitFor(async () => expect(await stateOf(w, 'beta')).toBe('idle'))
    expect(w.host.running).toEqual(['alpha'])
    expect(w.connection('beta').calls).toEqual([])
    expect(w.hostCalls).toEqual(['alpha'])
    expect(existsSync(w.h.accountOf('beta').blockedFile)).toBe(false)
    // several polls later it is still said only once
    await until(() => w.h.err.join('\n').includes('"beta" is not linked'), 'the notice')
    await started(w, 'alpha')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(w.h.err.filter((line) => line.includes('"beta" is not linked'))).toHaveLength(1)
    expect(named(w.h, 'account.idle', 'beta')).toHaveLength(1)
  })
})

describe('RF-51 across the accounts of one daemon', () => {
  it("delivers each account's digest through its own socket to its own chat, never through the other's", async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'] })
    await queue(w.h, 'alpha', 'ALPHA DIGEST')
    await queue(w.h, 'beta', 'BETA DIGEST')
    await w.host.start()
    await waitFor(() => {
      expect(w.connection('alpha').sent).toEqual(['ALPHA DIGEST'])
      expect(w.connection('beta').sent).toEqual(['BETA DIGEST'])
    })
    // the outboxes are separate and both are empty now
    for (const id of ['alpha', 'beta']) {
      const runtime = w.h.runtime(id)
      expect(await runtime.outbox.pending()).toEqual([])
      runtime.close()
    }
  })

  it("an account whose socket is another phone's sends nothing, and the other account is not touched", async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'] })
    // beta's session turns out to be a stranger's phone (or alpha's): the account does not match what was linked
    w.connection('beta').user = { id: JID.alpha as string }
    await queue(w.h, 'beta', 'BETA PRIVATE')
    await queue(w.h, 'alpha', 'ALPHA PRIVATE')
    await w.host.start()
    await waitFor(() => {
      expect(w.connection('alpha').sent).toEqual(['ALPHA PRIVATE'])
      expect(existsSync(w.h.accountOf('beta').blockedFile)).toBe(true)
    })
    expect(w.connection('beta').sent).toEqual([])
    expect(w.connection('alpha').sent).not.toContain('BETA PRIVATE')
    const beta = w.h.runtime('beta')
    expect((await beta.outbox.pending()).map((p) => p.text)).toEqual(['BETA PRIVATE'])
    beta.close()
  })
})

describe('an account that is blocked does not stop the others', () => {
  it('writes its own blocked.json, idles, and the other account keeps capturing and sending', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'], autoConnect: false })
    const alpha = w.connection('alpha')
    const beta = w.connection('beta')
    alpha.onStart = () => alpha.emit({ state: 'connected' })
    beta.onStart = () => beta.emit({ state: 'loggedOut' })
    await w.host.start()
    await waitFor(() => {
      expect(JSON.parse(readFileSync(w.h.accountOf('beta').blockedFile, 'utf8')).reason).toBe('loggedOut')
    })
    expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(false)
    await waitFor(async () => {
      expect(await stateOf(w, 'beta')).toBe('blocked')
      expect(await stateOf(w, 'alpha')).toBe('connected')
    })
    expect(named(w.h, 'daemon.blocked', 'beta')).toHaveLength(1)
    // alpha still works after beta blocked
    expect(await alpha.receive(incoming('a2', 'chat-a2', 'STILL CAPTURING'))).toBe(true)
    await queue(w.h, 'alpha', 'STILL SENDING')
    await waitFor(() => expect(alpha.sent).toEqual(['STILL SENDING']))
    // and the blocked account is left alone on every poll: no new socket
    const before = startsOf(beta)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(startsOf(beta)).toBe(before)
    // a blocked account has no unit at all: its socket and its database were released
    expect(w.host.running).toEqual(['alpha'])
  })

  it('an account that was blocked when the daemon started is not started, and is said once', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'] })
    await writeBlocked(w.h.accountOf('beta').blockedFile, 'replaced', NOW)
    await w.host.start()
    await started(w, 'alpha')
    await waitFor(async () => expect(await stateOf(w, 'beta')).toBe('blocked'))
    expect(w.connection('beta').calls).toEqual([])
    expect(w.h.err.join('\n')).toContain('Another session with the same credentials')
    expect(w.h.err.join('\n')).toContain('msum retry --account beta')
    expect(named(w.h, 'daemon.blocked', 'beta')).toHaveLength(1)
  })
})

describe('a failure inside one account is not the daemon failing', () => {
  it('a throw while handling the events of one socket restarts that unit, with the other untouched', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'] })
    const alpha = w.connection('alpha')
    const original = alpha.selfChat.bind(alpha)
    let thrown = false
    alpha.selfChat = () => {
      if (!thrown) {
        thrown = true
        throw new RangeError('chat text that must not be logged')
      }
      return original()
    }
    await w.host.start()
    await until(() => named(w.h, 'account.crashed', 'alpha').length > 0, 'the crash to be logged')
    expect(named(w.h, 'account.crashed', 'alpha')[0]).toMatchObject({ level: 'error', code: 'RangeError', attempt: 1 })
    expect(w.h.logs.join('')).not.toContain('must not be logged')
    // restarted after the wait, and connected
    await waitFor(async () => {
      expect(startsOf(alpha)).toBe(2)
      expect(await stateOf(w, 'alpha')).toBe('connected')
    })
    // beta never noticed
    expect(w.connection('beta').calls).toEqual(['start'])
    expect(named(w.h, 'account.crashed', 'beta')).toEqual([])
    expect(await stateOf(w, 'beta')).toBe('connected')
  })

  it('a socket that fails to start is retried with a growing wait, and the process goes on', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'], autoConnect: false })
    const alpha = w.connection('alpha')
    const beta = w.connection('beta')
    beta.onStart = () => beta.emit({ state: 'connected' })
    let attempts = 0
    alpha.onStart = () => {
      attempts++
      if (attempts < 3) throw new Error('could not open the socket')
      alpha.emit({ state: 'connected' })
    }
    await w.host.start()
    await waitFor(async () => {
      expect(attempts).toBe(3)
      expect(await stateOf(w, 'alpha')).toBe('connected')
    })
    const crashes = named(w.h, 'account.crashed', 'alpha')
    expect(crashes.map((c) => c.attempt)).toEqual([1, 2])
    expect(crashes.map((c) => c.delayMs)).toEqual([30, 60]) // doubling, up to the maximum
    expect(startsOf(beta)).toBe(1)
    expect(w.host.running).toEqual(['alpha', 'beta'])
  })
})

describe('the daemon follows the installation while it runs', () => {
  it('starts an account linked later and stops one that was removed', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha'] })
    await w.host.start()
    await started(w, 'alpha')
    await waitFor(async () => expect(await stateOf(w, 'beta')).toBe('idle'))
    expect(w.connection('beta').calls).toEqual([])

    // beta is linked (what a finished `link` leaves): the next look starts it
    w.linked('beta')
    await started(w, 'beta')
    await waitFor(async () => expect(await stateOf(w, 'beta')).toBe('connected'))
    expect(w.host.running).toEqual(['alpha', 'beta'])

    // a brand new account, registered and linked while it runs
    await w.installation.createAccount('gamma')
    w.linked('gamma')
    await started(w, 'gamma')

    // an account removed from the registry (only the row, no lock) is stopped for that reason
    w.installation.registry.remove('gamma')
    await until(() => named(w.h, 'account.unitStopped', 'gamma').length > 0, 'gamma to be stopped')
    expect(named(w.h, 'account.unitStopped', 'gamma')[0]).toMatchObject({ reason: 'removed' })
    expect(w.connection('gamma').calls).toContain('stop')
    expect(w.host.running).toEqual(['alpha', 'beta'])
    expect(w.connection('alpha').calls).toEqual(['start'])
  })
})

describe('linking while the daemon runs', () => {
  it('never starts an account between `link` writing its credentials and finishing', async () => {
    const w = await world(['alpha', 'beta', 'gamma'], { linked: ['alpha'] })
    await w.host.start()
    await started(w, 'alpha')

    // `link` of beta, as it runs: the lock first, then the credentials and the number
    const lock = await acquireLinkLock(w.h.accountOf('beta'))
    expect(lock.ok).toBe(true)
    w.linked('beta')
    // gamma appears after beta's credentials exist; when the daemon starts it, a look that included beta has happened
    w.linked('gamma')
    await started(w, 'gamma')
    expect(w.hostCalls).not.toContain('beta')
    expect(named(w.h, 'account.started', 'beta')).toEqual([])
    expect(await stateOf(w, 'beta')).toBe('idle')

    // `link` finishes: the lock goes, the next look starts beta
    if (lock.ok) await lock.release()
    await started(w, 'beta')
    expect(w.hostCalls.filter((id) => id === 'beta')).toHaveLength(1)
  })

  it('never stops a unit that is running because a lock shows up on its account', async () => {
    const w = await world(['alpha', 'beta', 'gamma'], { linked: ['alpha', 'beta'] })
    await w.host.start()
    await Promise.all([started(w, 'alpha'), started(w, 'beta')])
    const lock = await acquireLinkLock(w.h.accountOf('beta'))
    // many looks with the lock held: gamma appears and starts, so each look included beta
    w.linked('gamma')
    await started(w, 'gamma')
    expect(w.host.running).toEqual(['alpha', 'beta', 'gamma'])
    expect(w.connection('beta').calls).toEqual(['start'])
    expect(named(w.h, 'account.unitStopped', 'beta')).toEqual([])
    if (lock.ok) await lock.release()
  })

  const widenTheWindow = async (
    w: World,
    daemonLock: { held: Awaited<ReturnType<typeof acquireDaemonLock>> | null },
  ) => {
    // right after the command took the lock: a daemon is now running, and many looks happen while the lock is held
    const fresh = ['gamma', 'delta']
    Object.assign(w.h.ctx, {
      afterLock: async () => {
        daemonLock.held ??= await acquireDaemonLock(w.h.layout.lockFile, process.pid)
        // a new account each time, so that each window sees a look that includes alpha
        const next = fresh.shift() as string
        await w.installation.createAccount(next)
        w.linked(next)
        await started(w, next)
        expect(existsSync(w.h.accountOf('alpha').linkLockFile)).toBe(true) // the lock is held during the looks
      },
    })
  }

  it('a refused `link` or `unlink` of an account in use never restarts its healthy unit', async () => {
    const w = await world(['alpha'], { linked: ['alpha'] })
    await w.host.start()
    await started(w, 'alpha')
    const daemonLock: { held: Awaited<ReturnType<typeof acquireDaemonLock>> | null } = { held: null }
    await widenTheWindow(w, daemonLock)
    // the daemon was not running when the commands began, so the early check passes and the lock check is the one that refuses
    expect(await run(w.h, 'link', '--account', 'alpha')).toBe(1)
    expect(w.h.err.join('\n')).toContain('being used by the running daemon')
    expect(existsSync(w.h.accountOf('alpha').linkLockFile)).toBe(false) // released after the refusal
    expect(await run(w.h, 'unlink', '--account', 'alpha', '--yes')).toBe(1)
    expect(w.h.err.join('\n')).toContain('being used by the running daemon')
    // the same, now with the daemon already running: refused before anything is taken
    Object.assign(w.h.ctx, { afterLock: undefined })
    w.h.err.length = 0
    expect(await run(w.h, 'link', '--account', 'alpha')).toBe(1)
    expect(await run(w.h, 'unlink', '--account', 'alpha', '--yes')).toBe(1)
    expect(existsSync(w.h.accountOf('alpha').dir)).toBe(true)
    expect(w.host.running).toContain('alpha')
    expect(w.connection('alpha').calls).toEqual(['start'])
    expect(named(w.h, 'account.unitStopped', 'alpha')).toEqual([])
    expect(named(w.h, 'account.started', 'alpha')).toHaveLength(1)
    if (daemonLock.held?.ok) await daemonLock.held.release()
  })

  it('an early refusal does not even take the lock', async () => {
    const w = await world(['alpha'], { linked: ['alpha'] })
    await w.host.start()
    await started(w, 'alpha')
    const daemonLock = await acquireDaemonLock(w.h.layout.lockFile, process.pid)
    let tookLock = 0
    Object.assign(w.h.ctx, {
      afterLock: () => {
        tookLock++
      },
    })
    expect(await run(w.h, 'link', '--account', 'alpha')).toBe(1)
    expect(await run(w.h, 'unlink', '--account', 'alpha', '--yes')).toBe(1)
    expect(tookLock).toBe(0)
    if (daemonLock.ok) await daemonLock.release()
  })

  it('the real `link` command: the daemon waits for it, then picks the new account up', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha'], autoConnect: false })
    const alpha = w.connection('alpha')
    alpha.onStart = () => alpha.emit({ state: 'connected' })
    const beta = w.connection('beta')
    let linkRunning = false
    let startedWhileLinking = 0
    const factory = w.h.ctx.connectionFactory
    Object.assign(w.h.ctx, {
      connectionFactory: async (...args: Parameters<typeof factory>) => {
        // the host passes no capture hook; `link` does
        if (linkRunning && args[0].layout.id === 'beta' && args[1].capture === undefined) startedWhileLinking++
        return factory(...args)
      },
      // a long quiet window: `link` stays busy long enough for many looks of the daemon
      linkTiming: { ...w.h.ctx.linkTiming, quietMs: 1_500, maxAfterConnectMs: 10_000 },
    })
    beta.onStart = () => {
      // the phone confirmed: credentials are written, then the connection opens
      writeFileSync(join(w.h.accountOf('beta').authDir, 'creds.json'), JSON.stringify({ me: { id: JID.beta } }))
      beta.emit({ state: 'connected' })
    }
    await w.host.start()
    await started(w, 'alpha')

    linkRunning = true
    const linking = run(w.h, 'link', '--account', 'beta')
    await until(() => existsSync(w.h.accountOf('beta').linkLockFile), 'the link lock')
    await until(() => existsSync(join(w.h.accountOf('beta').authDir, 'creds.json')), 'the credentials')
    // a new account appears while `link` is busy: when the daemon starts it, it has looked at beta again
    await w.installation.createAccount('gamma')
    w.linked('gamma')
    await started(w, 'gamma')
    expect(existsSync(w.h.accountOf('beta').linkLockFile)).toBe(true) // link is still working
    expect(startedWhileLinking).toBe(0)

    expect(await linking).toBe(0)
    linkRunning = false
    expect(existsSync(w.h.accountOf('beta').linkLockFile)).toBe(false)
    await started(w, 'beta')
    expect(startedWhileLinking).toBe(0)
    await waitFor(async () => expect(await stateOf(w, 'beta')).toBe('connected'))
  })

  it('a blocked account is relinked while the daemon runs: link clears the block and the daemon starts it', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'], autoConnect: false })
    const alpha = w.connection('alpha')
    alpha.onStart = () => alpha.emit({ state: 'connected' })
    const beta = w.connection('beta')
    beta.onStart = () => beta.emit({ state: 'loggedOut' })
    await w.host.start()
    await waitFor(() => expect(existsSync(w.h.accountOf('beta').blockedFile)).toBe(true))
    await waitFor(async () => expect(await stateOf(w, 'beta')).toBe('blocked'))

    // the phone is scanned again: the same number, a fresh session
    beta.onStart = () => {
      writeFileSync(join(w.h.accountOf('beta').authDir, 'creds.json'), JSON.stringify({ me: { id: JID.beta } }))
      beta.emit({ state: 'connected' })
    }
    expect(await run(w.h, 'link', '--account', 'beta')).toBe(0)
    expect(beta.calls).toContain('clearSession') // the session that no longer worked was replaced
    expect(existsSync(w.h.accountOf('beta').blockedFile)).toBe(false)
    await until(() => named(w.h, 'account.started', 'beta').length === 2, 'beta to start again')
    await waitFor(async () => expect(await stateOf(w, 'beta')).toBe('connected'))
    expect(w.connection('alpha').calls).toEqual(['start'])
  })
})

describe('an unlink that is interrupted at any step', () => {
  const steps = ['session', 'contents', 'marker', 'directory'] as const
  for (const step of steps) {
    for (const blocked of [true, false]) {
      it(`leaves either a marker or no session after "${step}" (${blocked ? 'blocked' : 'not blocked'}), and the daemon never starts it`, async () => {
        const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'] })
        const alpha = w.h.accountOf('alpha')
        writeFileSync(join(alpha.dir, 'notes.txt'), 'something else the account owns')
        if (blocked) await writeBlocked(alpha.blockedFile, 'forbidden', NOW)

        // the unlink dies right after this step: its lock is left behind and then goes (the process is gone)
        const lock = await acquireLinkLock(alpha)
        await expect(
          w.installation.deleteAccount('alpha', (done) => {
            if (done === step) throw new Error('interrupted')
          }),
        ).rejects.toThrow('interrupted')
        if (lock.ok) await lock.release()

        // whatever is left: no session, or the marker that keeps the daemon off
        const hasCreds = existsSync(join(alpha.authDir, 'creds.json'))
        expect(!hasCreds || existsSync(alpha.blockedFile), `session without a marker after ${step}`).toBe(true)

        // a daemon starts (or keeps polling) over the leftovers: many looks, alpha is never started
        await w.host.start()
        await started(w, 'beta')
        await w.installation.createAccount('gamma')
        w.linked('gamma')
        await started(w, 'gamma')
        expect(w.connection('alpha').calls).toEqual([])
        expect(w.hostCalls).not.toContain('alpha')
        expect(named(w.h, 'account.started', 'alpha')).toEqual([])
        expect(w.host.running).not.toContain('alpha')
      })
    }
  }
})

describe('msum unlink of an account the daemon keeps idle', () => {
  it('deletes it completely on the first try, with nothing of it left open in the daemon', async () => {
    const w = await world(['alpha', 'idle', 'blocked'], { linked: ['alpha', 'blocked'], autoConnect: false })
    w.connection('alpha').onStart = () => w.connection('alpha').emit({ state: 'connected' })
    // blocked is refused by the platform as soon as it connects: a terminal state
    w.connection('blocked').onStart = () => w.connection('blocked').emit({ state: 'error', reason: 'forbidden' })
    await w.host.start()
    await started(w, 'alpha')
    await waitFor(() => {
      expect(JSON.parse(readFileSync(w.h.accountOf('blocked').blockedFile, 'utf8')).reason).toBe('forbidden')
    })
    await waitFor(async () => {
      expect(await stateOf(w, 'idle')).toBe('idle')
      expect(await stateOf(w, 'blocked')).toBe('blocked')
    })
    // a live daemon: this process holds the lock
    const daemonLock = await acquireDaemonLock(w.h.layout.lockFile, process.pid)
    for (const id of ['idle', 'blocked']) {
      // no unit, and no database handle of that account is open
      expect(w.host.running, id).not.toContain(id)
      expect(
        w.runtimes.filter((r) => r.id === id).every((r) => !r.db.isOpen),
        id,
      ).toBe(true)
      const code = await run(w.h, 'unlink', '--account', id, '--yes')
      const left = existsSync(w.h.accountOf(id).dir) ? readdirSync(w.h.accountOf(id).dir).join(',') : '-'
      expect(code, `${id}: ${w.h.err.slice(-1)} left=${left}`).toBe(0)
      expect(existsSync(w.h.accountOf(id).dir), id).toBe(false)
    }
    expect(w.h.out.join('\n')).toContain('Account "blocked" unlinked')
    // the daemon goes on with the other account, and nothing went wrong while the accounts were removed
    await manyLooks(w, 'gamma')
    expect(named(w.h, 'daemon.pollFailed')).toEqual([])
    expect(w.host.running).toEqual(['alpha', 'gamma'])
    if (daemonLock.ok) await daemonLock.release()
  })

  const manyLooks = async (w: World, id: string): Promise<void> => {
    await w.installation.createAccount(id)
    w.linked(id)
    await started(w, id)
  }
})

describe('msum retry', () => {
  it('clears a block that retrying fixes, and the running daemon starts the account again', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'], autoConnect: false })
    const beta = w.connection('beta')
    w.connection('alpha').onStart = () => w.connection('alpha').emit({ state: 'connected' })
    beta.onStart = () => beta.emit({ state: 'error', reason: 'forbidden' })
    await w.host.start()
    await waitFor(() => {
      expect(JSON.parse(readFileSync(w.h.accountOf('beta').blockedFile, 'utf8')).reason).toBe('forbidden')
    })
    await waitFor(async () => expect(await stateOf(w, 'beta')).toBe('blocked'))

    beta.onStart = () => beta.emit({ state: 'connected' })
    expect(await run(w.h, 'retry', '--account', 'beta')).toBe(0)
    expect(w.h.out.join('\n')).toContain('The block of the account "beta" was cleared')
    expect(existsSync(w.h.accountOf('beta').blockedFile)).toBe(false)
    await waitFor(async () => {
      expect(startsOf(beta)).toBe(2)
      expect(await stateOf(w, 'beta')).toBe('connected')
    })
    expect(startsOf(w.connection('alpha'))).toBe(1)
  })

  it('does not clear a block that only linking fixes, and says what to do', async () => {
    const w = await world(['alpha'], { linked: ['alpha'] })
    await writeBlocked(w.h.accountOf('alpha').blockedFile, 'loggedOut', NOW)
    expect(await run(w.h, 'retry', '--account', 'alpha')).toBe(1)
    expect(w.h.err.join('\n')).toContain('msum unlink --account alpha')
    expect(w.h.err.join('\n')).toContain('msum link --account alpha')
    expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(true)
  })

  it('says so for an account that is not blocked, and for several accounts asks which', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'] })
    expect(await run(w.h, 'retry', '--account', 'alpha')).toBe(0)
    expect(w.h.out.join('\n')).toContain('is not blocked')
    expect(await run(w.h, 'retry')).toBe(2)
    expect(w.h.err.join('\n')).toContain('--account <id>')
  })

  it('works in Spanish', async () => {
    const w = await world(['alpha'], { linked: ['alpha'] })
    writeFileSync(w.h.layout.configFile, JSON.stringify({ ...BASE, language: 'es' }))
    await writeBlocked(w.h.accountOf('alpha').blockedFile, 'forbidden', NOW)
    expect(await run(w.h, 'retry')).toBe(0)
    expect(w.h.out.join('\n')).toContain('Se borró el bloqueo de la cuenta "alpha"')
  })
})

describe('shutdown', () => {
  it('stops every account in parallel, inside the budget, even when their sockets never answer', async () => {
    // A budget long enough that a slow runner does not blur "one budget" with "two in a row" (>= 2 x 1500 ms).
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'], timing: { shutdownGraceMs: 1_500 } })
    await w.host.start()
    await Promise.all([started(w, 'alpha'), started(w, 'beta')])
    for (const id of ['alpha', 'beta']) {
      const conn = w.connection(id)
      conn.stop = () => {
        conn.calls.push('stop')
        return new Promise<void>(() => {}) // a socket that never closes
      }
    }
    const begun = Date.now()
    await w.host.stop()
    const took = Date.now() - begun
    expect(w.connection('alpha').calls).toContain('stop')
    expect(w.connection('beta').calls).toContain('stop')
    // one budget for both: two in a row would take at least two
    expect(took).toBeGreaterThanOrEqual(1_350)
    expect(took).toBeLessThan(2_900)
    expect(named(w.h, 'daemon.stopped')).toHaveLength(1)
    expect(await w.host.finished).toBe(0)
  })

  it('stops a normal pair at once and closes what it opened', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'] })
    await w.host.start()
    await Promise.all([started(w, 'alpha'), started(w, 'beta')])
    await w.host.stop()
    await w.host.stop() // safe to repeat
    expect(w.host.running).toEqual([])
    expect(named(w.h, 'account.stopped')).toHaveLength(2)
  })
})

describe('missed runs and single flight, per account (RF-65, RF-66)', () => {
  /** A schedule every day an hour ago (the account's time zone is UTC): its last run is already past. */
  const scheduleAnHourAgo = (w: World, id: string): void => {
    const at = new Date(Date.now() - 3_600_000)
    const made = makeSchedule(ALL_WEEKDAYS, `${at.getUTCHours()}:${String(at.getUTCMinutes()).padStart(2, '0')}`)
    if (!made.ok) throw new Error('invalid')
    w.installation.schedules.add(id, made.value)
  }
  const oldPointer = async (w: World, id: string): Promise<void> => {
    const runtime = w.h.runtime(id)
    await runtime.store.commit({
      previousPointer: null,
      pointer: Date.now() - 2 * 24 * 3_600_000,
      digest: null,
      parts: [],
    })
    runtime.close()
  }

  it('makes up ONE missed run for the account that missed one, and not for the other', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'] })
    scheduleAnHourAgo(w, 'alpha')
    await oldPointer(w, 'alpha')
    await w.host.start()
    await until(() => named(w.h, 'digest.committed', 'alpha').length === 1, 'the missed digest of alpha')
    expect(named(w.h, 'digest.missed', 'alpha')).toHaveLength(1)
    expect(named(w.h, 'digest.started', 'alpha')).toEqual([expect.objectContaining({ trigger: 'missed' })])
    // beta has no schedule: nothing was missed
    expect(named(w.h, 'digest.missed', 'beta')).toEqual([])
    expect(named(w.h, 'digest.started', 'beta')).toEqual([])
  })

  it("an account's digest in progress makes another request for that account wait or be refused, never the other account", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const summarizer = new FakeSummarizer(async () => ok(SUMMARY))
    const slow = new FakeSummarizer(async () => {
      await gate
      return ok(SUMMARY)
    })
    // alpha's digest waits for the gate; beta's does not
    const router = {
      requests: [] as unknown[],
      summarize: (request: Parameters<FakeSummarizer['summarize']>[0]) =>
        request.transcript.includes('ALPHA') ? slow.summarize(request) : summarizer.summarize(request),
    }
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'], summarizer: router as never })
    for (const [id, text] of [
      ['alpha', 'ALPHA message'],
      ['beta', 'BETA message'],
    ] as const) {
      const runtime = w.h.runtime(id)
      const { seedMessages } = await import('../../support/cli-harness.js')
      await seedMessages(runtime, [{ id: `${id}1`, text, timestamp: Date.now() - 3_600_000 }])
      runtime.close()
    }
    await w.host.start()
    await Promise.all([started(w, 'alpha'), started(w, 'beta')])
    const alpha = w.host.daemonOf('alpha')
    const beta = w.host.daemonOf('beta')
    if (alpha === undefined || beta === undefined) throw new Error('units are not running')

    const first = alpha.runScheduledDigest('schedule')
    await until(() => named(w.h, 'digest.started', 'alpha').length === 1, 'the digest of alpha to start')
    // a second request for alpha is turned away...
    expect(await alpha.runScheduledDigest('schedule')).toBe('busy')
    expect(named(w.h, 'digest.skipped', 'alpha')).toHaveLength(1)
    // ...while beta's own digest runs to the end meanwhile
    expect(await beta.runScheduledDigest('schedule')).toBe('ran')
    expect(named(w.h, 'digest.skipped', 'beta')).toEqual([])
    release()
    expect(await first).toBe('ran')
    expect(await alpha.runScheduledDigest('schedule')).toBe('ran')
  })
})

describe('what the daemon says about each account (RF-04)', () => {
  it('writes accounts/<id>/state.json: private, atomic, with a state and a time only', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha'] })
    await w.host.start()
    await waitFor(async () => {
      expect(await stateOf(w, 'alpha')).toBe('connected')
      expect(await stateOf(w, 'beta')).toBe('idle')
    })
    for (const id of ['alpha', 'beta']) {
      const file = w.h.accountOf(id).stateFile
      if (!isWindows) expect(statSync(file).mode & 0o777).toBe(0o600)
      const content = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      expect(Object.keys(content).sort()).toEqual(['since', 'state'])
      expect(typeof content.since).toBe('number')
      expect(readFileSync(file, 'utf8')).not.toMatch(/5491100/)
      expect(existsSync(`${file}.tmp`)).toBe(false)
    }
  })

  /** A writer of `state.json` that fails with `code` for its first `failures` calls, then writes for real. */
  const flaky = (code: string, failures: number) => {
    const calls: string[] = []
    const write: typeof writeUnitState = async (file, record) => {
      calls.push(record.state)
      if (calls.length <= failures) throw Object.assign(new Error('the file is open elsewhere'), { code })
      await writeUnitState(file, record)
    }
    return { calls, write }
  }

  it('writes the state again after a transient failure (EBUSY on Windows), and says it once', async () => {
    const flake = flaky('EBUSY', 3)
    const w = await world(['alpha'], { linked: ['alpha'], writeUnitState: flake.write })
    await w.host.start()
    // the file ends up with the state the account has, though the first writes failed
    await vi.waitFor(async () => expect(await stateOf(w, 'alpha')).toBe('connected'), { timeout: 5_000, interval: 50 })
    expect(flake.calls.length).toBeGreaterThan(3)
    // the failures of one run are said once, not on every try
    expect(named(w.h, 'state.writeFailed', 'alpha')).toHaveLength(1)
    expect(JSON.stringify(named(w.h, 'state.writeFailed', 'alpha'))).not.toMatch(/5491100/)
  })

  it('gives up after a few tries: a failure that never passes is not tried in a tight loop', async () => {
    const flake = flaky('EPERM', Number.POSITIVE_INFINITY)
    const w = await world(['alpha'], { linked: ['alpha'], writeUnitState: flake.write })
    await w.host.start()
    await started(w, 'alpha')
    await waitFor(() => expect(flake.calls.length).toBeGreaterThan(0))
    // it is tried until the allowed attempts are used up (1 + 5 retries), then never again
    const connectedTries = () => flake.calls.filter((state) => state === 'connected').length
    await waitFor(() => expect(connectedTries()).toBe(6))
    const after = flake.calls.length
    // many more looks go by (one every 20 ms) and nothing is written any more
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(flake.calls.length).toBe(after)
    expect(connectedTries()).toBe(6)
    expect(named(w.h, 'state.writeFailed', 'alpha')).toHaveLength(1)
  })

  it('does not retry a failure that is not transient', async () => {
    const flake = flaky('ENOSPC', Number.POSITIVE_INFINITY)
    const w = await world(['alpha'], { linked: ['alpha'], writeUnitState: flake.write })
    await w.host.start()
    await started(w, 'alpha')
    await waitFor(() => expect(flake.calls.filter((state) => state === 'connected')).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(flake.calls.filter((state) => state === 'connected')).toHaveLength(1)
  })

  it('goes through connecting, connected and reconnecting as the socket does', async () => {
    const w = await world(['alpha'], { linked: ['alpha'], autoConnect: false })
    const alpha = w.connection('alpha')
    alpha.onStart = () => alpha.emit({ state: 'connecting' })
    await w.host.start()
    await waitFor(async () => expect(await stateOf(w, 'alpha')).toBe('connecting'))
    alpha.emit({ state: 'connected' })
    await waitFor(async () => expect(await stateOf(w, 'alpha')).toBe('connected'))
    alpha.emit({ state: 'reconnecting', attempt: 1, delayMs: 100, reason: 'connectionLost' })
    await waitFor(async () => expect(await stateOf(w, 'alpha')).toBe('reconnecting'))
    alpha.emit({ state: 'connected' })
    await waitFor(async () => expect(await stateOf(w, 'alpha')).toBe('connected'))
  })

  it('status shows it only while the daemon lock is held by a live process', async () => {
    const w = await world(['alpha'], { linked: ['alpha'] })
    await w.host.start()
    await waitFor(async () => expect(await stateOf(w, 'alpha')).toBe('connected'))
    // no daemon lock: a stale file is not believed
    expect(await run(w.h, 'status')).toBe(0)
    expect(w.h.out.join('\n')).not.toContain('Connection:')
    expect(w.h.out.join('\n')).toMatch(/^Daemon: +stopped$/m)
    w.h.out.length = 0
    const lock = await acquireDaemonLock(w.h.layout.lockFile, process.pid)
    expect(await run(w.h, 'status')).toBe(0)
    expect(w.h.out.join('\n')).toMatch(/^Connection: +connected \(since /m)
    expect(w.h.out.join('\n')).not.toContain('5491100000011')
    if (lock.ok) await lock.release()
  })
})

describe('the ban rule: nothing reconnects by itself that a person did not clear', () => {
  const failingWriter = async (): Promise<void> => {
    throw new Error('the disk is full')
  }

  /** Looks at the installation many times: a new account appears and starts, and each look included the others. */
  const manyLooks = async (w: World, id: string): Promise<void> => {
    await w.installation.createAccount(id)
    w.linked(id)
    await started(w, id)
  }

  it('a block whose marker could not be written stays: the account is released, and nothing reconnects it', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'], writeMarker: failingWriter })
    await w.host.start()
    await Promise.all([started(w, 'alpha'), started(w, 'beta')])
    w.connection('alpha').emit({ state: 'error', reason: 'forbidden' })
    await until(() => named(w.h, 'daemon.markerFailed', 'alpha').length > 0, 'the marker write to fail')
    expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(false)
    // released all the same: no unit, and its database closed
    expect(w.host.running).toEqual(['beta'])
    expect(w.runtimes.filter((r) => r.id === 'alpha').every((r) => !r.db.isOpen)).toBe(true)
    // The state is blocked in memory at once; its file follows. The file is read at a calm pace: the daemon replaces it
    // by renaming over it, and on Windows a rename can fail while a reader has it open (a poll every few ms did that).
    await waitFor(() => expect(w.host.accountState('alpha')?.state).toBe('blocked'))
    await vi.waitFor(async () => expect(await stateOf(w, 'alpha')).toBe('blocked'), { timeout: 5_000, interval: 100 })
    const starts = startsOf(w.connection('alpha'))
    await manyLooks(w, 'gamma')
    await manyLooks(w, 'delta')
    expect(startsOf(w.connection('alpha'))).toBe(starts)
    expect(w.host.running).toEqual(['beta', 'delta', 'gamma'])
    // the failure is said once, not on every look
    expect(named(w.h, 'daemon.markerFailed', 'alpha')).toHaveLength(1)
  })

  it('link and unlink take the lock and are refused: the block that was only in memory is still there after', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'], writeMarker: failingWriter })
    await w.host.start()
    await Promise.all([started(w, 'alpha'), started(w, 'beta')])
    w.connection('alpha').emit({ state: 'error', reason: 'forbidden' })
    await until(() => named(w.h, 'daemon.markerFailed', 'alpha').length > 0, 'the marker write to fail')
    const starts = startsOf(w.connection('alpha'))
    // a daemon is running (this process holds the lock) and alpha looks linked and unblocked on disk
    const daemonLock = await acquireDaemonLock(w.h.layout.lockFile, process.pid)
    expect(await run(w.h, 'link', '--account', 'alpha')).toBe(1)
    expect(await run(w.h, 'unlink', '--account', 'alpha', '--yes')).toBe(1)
    expect(existsSync(w.h.accountOf('alpha').linkLockFile)).toBe(false) // taken and released
    await manyLooks(w, 'gamma')
    expect(startsOf(w.connection('alpha'))).toBe(starts)
    expect(w.host.running).not.toContain('alpha')
    if (daemonLock.ok) await daemonLock.release()
  })

  it('blocked at startup, cleared by retry, running; then a 403 whose marker cannot be written: no restart', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha', 'beta'], writeMarker: failingWriter })
    await writeBlocked(w.h.accountOf('alpha').blockedFile, 'forbidden', NOW)
    await w.host.start()
    await started(w, 'beta')
    await waitFor(async () => expect(await stateOf(w, 'alpha')).toBe('blocked'))
    expect(w.connection('alpha').calls).toEqual([])

    expect(await run(w.h, 'retry', '--account', 'alpha')).toBe(0)
    await started(w, 'alpha')
    // a new block: the entry of the first one (it was on disk) must not make this one look cleared
    w.connection('alpha').emit({ state: 'error', reason: 'forbidden' })
    await until(() => named(w.h, 'daemon.markerFailed', 'alpha').length > 0, 'the marker write to fail')
    const starts = startsOf(w.connection('alpha'))
    expect(starts).toBe(1)
    await manyLooks(w, 'gamma')
    await manyLooks(w, 'delta')
    expect(startsOf(w.connection('alpha'))).toBe(starts)
    expect(named(w.h, 'account.started', 'alpha')).toHaveLength(1)
    expect(w.host.running).not.toContain('alpha')
  })

  it('a loop of crashes whose marker cannot be written stays idle', async () => {
    const w = await world(['alpha', 'beta'], {
      linked: ['alpha', 'beta'],
      autoConnect: false,
      writeMarker: failingWriter,
      timing: { unitMaxFailures: 2, unitBackoffMs: 30, unitBackoffMaxMs: 60 },
    })
    w.connection('beta').onStart = () => w.connection('beta').emit({ state: 'connected' })
    w.connection('alpha').onStart = () => {
      throw new Error('cannot open the socket')
    }
    await w.host.start()
    await until(() => named(w.h, 'account.crashLoop', 'alpha').length === 1, 'the crash loop')
    await until(() => named(w.h, 'daemon.markerFailed', 'alpha').length > 0, 'the marker write to fail')
    expect(startsOf(w.connection('alpha'))).toBe(2)
    await manyLooks(w, 'gamma')
    await manyLooks(w, 'delta')
    expect(startsOf(w.connection('alpha'))).toBe(2)
    expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(false)
    expect(w.host.running).not.toContain('alpha')
    await waitFor(async () => expect(await stateOf(w, 'alpha')).toBe('blocked'))
  })

  it('a marker is never on disk while the account still has a socket or a database open', async () => {
    const observed: { id: string; reason: BlockedReason; stopped: boolean; closed: boolean; hasUnit: boolean }[] = []
    let current: World | null = null
    const writer = async (file: string, reason: BlockedReason, at: number): Promise<void> => {
      const w = current as World
      const id = file.split(/[\\/]/).slice(-2)[0] as string
      observed.push({
        id,
        reason,
        stopped: w.connection(id).calls.includes('stop'),
        closed: w.runtimes.filter((r) => r.id === id).every((r) => !r.db.isOpen),
        hasUnit: w.host.running.includes(id),
      })
      await writeBlocked(file, reason, at)
    }
    const w = await world(['alpha', 'beta'], {
      linked: ['alpha', 'beta'],
      autoConnect: false,
      writeMarker: writer,
      timing: { unitMaxFailures: 2, unitBackoffMs: 30, unitBackoffMaxMs: 60 },
    })
    current = w
    w.connection('alpha').onStart = () => w.connection('alpha').emit({ state: 'connected' })
    // beta fails to start, over and over: a loop of crashes
    w.connection('beta').onStart = () => {
      throw new Error('cannot open the socket')
    }
    await w.host.start()
    await started(w, 'alpha')
    // alpha is logged out from the phone: a terminal state
    w.connection('alpha').emit({ state: 'loggedOut' })
    await until(() => observed.length === 2, 'both markers to be written')
    expect(observed.map((o) => o.id).sort()).toEqual(['alpha', 'beta'])
    for (const seen of observed) {
      expect(seen, seen.id).toMatchObject({ stopped: true, closed: true, hasUnit: false })
    }
    expect(observed.find((o) => o.id === 'alpha')?.reason).toBe('loggedOut')
    expect(observed.find((o) => o.id === 'beta')?.reason).toBe('socketFailed')
    expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(true)
  })

  it('a block whose marker was on disk and is gone starts the account again (the user cleared it)', async () => {
    const w = await world(['alpha'], { linked: ['alpha'] })
    await w.host.start()
    await started(w, 'alpha')
    w.connection('alpha').emit({ state: 'error', reason: 'forbidden' })
    await waitFor(() =>
      expect(JSON.parse(readFileSync(w.h.accountOf('alpha').blockedFile, 'utf8')).reason).toBe('forbidden'),
    )
    await until(() => !w.host.running.includes('alpha'), 'the account to be released')
    // the marker was on disk and the user removes it
    rmSync(w.h.accountOf('alpha').blockedFile)
    await until(() => named(w.h, 'account.started', 'alpha').length === 2, 'the account to start again')
  })

  it('repeated crashes right after connecting end blocked, with growing waits and never a quick loop', async () => {
    const w = await world(['alpha', 'beta'], {
      linked: ['alpha', 'beta'],
      autoConnect: false,
      timing: { unitMaxFailures: 3, unitBackoffMs: 30, unitBackoffMaxMs: 60 },
    })
    const alpha = w.connection('alpha')
    const beta = w.connection('beta')
    beta.onStart = () => beta.emit({ state: 'connected' })
    // it connects, and the start still fails: "connected" must not count as recovered
    alpha.onStart = () => {
      alpha.emit({ state: 'connected' })
      throw new Error('fails right after connecting')
    }
    await w.host.start()
    await until(() => named(w.h, 'account.crashLoop', 'alpha').length === 1, 'the crash loop to be detected')
    const crashes = named(w.h, 'account.crashed', 'alpha')
    expect(crashes.map((c) => c.attempt)).toEqual([1, 2])
    expect(crashes.map((c) => c.delayMs)).toEqual([30, 60])
    expect(named(w.h, 'account.crashLoop', 'alpha')[0]).toMatchObject({ level: 'error', count: 3 })
    // blocked like any other account that cannot be used
    await waitFor(() => {
      expect(JSON.parse(readFileSync(w.h.accountOf('alpha').blockedFile, 'utf8')).reason).toBe('socketFailed')
    })
    await waitFor(async () => expect(await stateOf(w, 'alpha')).toBe('blocked'))
    expect(w.h.err.join('\n')).toContain('msum retry --account alpha')
    expect(startsOf(alpha)).toBe(3)
    // and it stays that way over many looks at the installation
    await w.installation.createAccount('gamma')
    w.linked('gamma')
    await started(w, 'gamma')
    expect(startsOf(alpha)).toBe(3)
    expect(startsOf(beta)).toBe(1)

    // `msum retry` is what brings it back
    alpha.onStart = () => alpha.emit({ state: 'connected' })
    expect(await run(w.h, 'retry', '--account', 'alpha')).toBe(0)
    await waitFor(async () => {
      expect(startsOf(alpha)).toBe(4)
      expect(await stateOf(w, 'alpha')).toBe('connected')
    })
  })

  it('failures only stop counting after the unit stayed connected for the stable period', async () => {
    const w = await world(['alpha'], {
      linked: ['alpha'],
      timing: { unitStableMs: 150, unitMaxFailures: 3, unitBackoffMs: 30, unitBackoffMaxMs: 60 },
    })
    const alpha = w.connection('alpha')
    const original = alpha.selfChat.bind(alpha)
    const crashNext = (): void => {
      alpha.selfChat = () => {
        alpha.selfChat = original
        throw new RangeError('boom')
      }
      alpha.emit({ state: 'connected' })
    }
    await w.host.start()
    await waitFor(async () => expect(await stateOf(w, 'alpha')).toBe('connected'))
    crashNext()
    await until(() => named(w.h, 'account.crashed', 'alpha').length === 1, 'the first crash')
    await waitFor(async () => {
      expect(startsOf(alpha)).toBe(2)
      expect(await stateOf(w, 'alpha')).toBe('connected')
    })
    // connected again, but not for long: a second crash is the second in a row
    crashNext()
    await until(() => named(w.h, 'account.crashed', 'alpha').length === 2, 'the second crash')
    expect(named(w.h, 'account.crashed', 'alpha').map((c) => c.attempt)).toEqual([1, 2])
    await waitFor(async () => {
      expect(startsOf(alpha)).toBe(3)
      expect(await stateOf(w, 'alpha')).toBe('connected')
    })
    // it stays connected for longer than the stable period: the count starts over
    const connectedAt = Date.now()
    await until(() => Date.now() - connectedAt > 400, 'the stable period to pass')
    crashNext()
    await until(() => named(w.h, 'account.crashed', 'alpha').length === 3, 'the third crash')
    expect(named(w.h, 'account.crashed', 'alpha').map((c) => c.attempt)).toEqual([1, 2, 1])
    expect(named(w.h, 'account.crashLoop', 'alpha')).toEqual([])
  })

  it('daemon --retry clears only what retrying fixes: a dead session or another phone stays blocked, with no socket', async () => {
    const h = await makeHarness({ config: BASE, accounts: ['alpha', 'beta', 'gamma'], liveClock: true })
    const conns = new Map<string, FakeConnection>()
    for (const id of ['alpha', 'beta', 'gamma']) {
      const conn = new FakeConnection()
      conn.user = { id: JID[id] as string }
      conn.onStart = () => conn.emit({ state: 'connected' })
      conns.set(id, conn)
      link(h, id)
    }
    await writeBlocked(h.accountOf('alpha').blockedFile, 'mismatch', NOW)
    await writeBlocked(h.accountOf('beta').blockedFile, 'loggedOut', NOW)
    await writeBlocked(h.accountOf('gamma').blockedFile, 'forbidden', NOW)
    Object.assign(h.ctx, {
      connectionFactory: async (runtime: { layout: { id: string }; capture: never }) => {
        const conn = conns.get(runtime.layout.id) as FakeConnection
        conn.capture = runtime.capture
        return conn
      },
      daemonTiming: { ...TIMING },
    })
    const finished = run(h, 'daemon', '--retry')
    await until(() => startsOf(conns.get('gamma') as FakeConnection) === 1, 'gamma to connect')
    expect(existsSync(h.accountOf('alpha').blockedFile)).toBe(true)
    expect(existsSync(h.accountOf('beta').blockedFile)).toBe(true)
    expect(existsSync(h.accountOf('gamma').blockedFile)).toBe(false)
    expect(h.err.join('\n')).toContain('"alpha" cannot be fixed by retrying')
    expect(h.err.join('\n')).toContain('"beta" cannot be fixed by retrying')
    // wait for more looks, then check that nothing was opened for them
    await new Promise<void>((resolve) => {
      const begun = Date.now()
      const timer = setInterval(() => {
        if (Date.now() - begun > 200) {
          clearInterval(timer)
          resolve()
        }
      }, 10)
    })
    expect(conns.get('alpha')?.calls).toEqual([])
    expect(conns.get('beta')?.calls).toEqual([])
    h.shutdown()
    expect(await finished).toBe(0)
  })
})

describe('locks and what the host writes', () => {
  it('re-checks the link lock right before starting a unit', async () => {
    const w = await world(['alpha'], { linked: ['alpha'] })
    const factory = w.h.ctx.connectionFactory
    let lock: Awaited<ReturnType<typeof acquireLinkLock>> | null = null
    let taken = false
    Object.assign(w.h.ctx, {
      connectionFactory: async (...args: Parameters<typeof factory>) => {
        const conn = await factory(...args)
        if (!taken) {
          // a `link` takes the account after the decision and before the start
          taken = true
          lock = await acquireLinkLock(w.h.accountOf('alpha'))
        }
        return conn
      },
    })
    await w.host.start()
    await until(() => taken, 'the factory to be called')
    expect(w.connection('alpha').calls).toEqual([])
    expect(named(w.h, 'account.started', 'alpha')).toEqual([])
    expect(w.host.running).toEqual([])
    if (lock !== null && (lock as { ok: boolean }).ok) await (lock as { release(): Promise<void> }).release()
    await started(w, 'alpha')
  })

  it('writes no state file into an account that link holds the lock of, and writes it after', async () => {
    const w = await world(['alpha', 'beta'], { linked: ['alpha'] })
    const lock = await acquireLinkLock(w.h.accountOf('beta'))
    await w.host.start()
    await started(w, 'alpha')
    await w.installation.createAccount('gamma')
    w.linked('gamma')
    await started(w, 'gamma') // a look that included beta has happened
    expect(existsSync(w.h.accountOf('beta').stateFile)).toBe(false)
    if (lock.ok) await lock.release()
    await waitFor(async () => expect(await stateOf(w, 'beta')).toBe('idle'))
  })

  it('names the lock file to delete when another process holds the account', async () => {
    const w = await world(['alpha'], { linked: ['alpha'] })
    // blocked, so that `retry` has something to do and gets as far as the lock
    await writeBlocked(w.h.accountOf('alpha').blockedFile, 'forbidden', NOW)
    const lock = await acquireLinkLock(w.h.accountOf('alpha'), process.ppid)
    expect(lock.ok).toBe(true)
    for (const command of [['retry'], ['unlink', '--yes'], ['link']]) {
      w.h.err.length = 0
      expect(await run(w.h, ...command), command[0]).toBe(1)
      expect(w.h.err.join('\n')).toContain(w.h.accountOf('alpha').linkLockFile)
      expect(w.h.err.join('\n')).toContain(`pid ${process.ppid}`)
    }
    expect(existsSync(w.h.accountOf('alpha').dir)).toBe(true)
  })

  it('retry does not clear a block under a link that is working on the account', async () => {
    const w = await world(['alpha'], { linked: ['alpha'] })
    await writeBlocked(w.h.accountOf('alpha').blockedFile, 'forbidden', NOW)
    const lock = await acquireLinkLock(w.h.accountOf('alpha'), process.ppid)
    expect(await run(w.h, 'retry')).toBe(1)
    expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(true)
    if (lock.ok) await lock.release()
    expect(await run(w.h, 'retry')).toBe(0)
    expect(existsSync(w.h.accountOf('alpha').blockedFile)).toBe(false)
  })
})

describe('shutdown while the daemon is looking at the installation', () => {
  it('does not wait for ever for a socket that never finishes opening', async () => {
    const w = await world(['alpha'], { linked: ['alpha'], autoConnect: false, timing: { shutdownGraceMs: 600 } })
    w.connection('alpha').onStart = () => new Promise<void>(() => {}) // never opens
    void w.host.start()
    await until(() => startsOf(w.connection('alpha')) === 1, 'the socket to start opening')
    const begun = Date.now()
    await w.host.stop()
    expect(Date.now() - begun).toBeLessThan(1_500)
    expect(w.connection('alpha').calls).toContain('stop')
    expect(await w.host.finished).toBe(0)
  })
})

describe('a problem in one account does not stop the others', () => {
  const setupCommand = async (config: Record<string, unknown>, ids: readonly string[], summarizer?: null) => {
    const h = await makeHarness({
      config,
      accounts: ids,
      liveClock: true,
      ...(summarizer === undefined ? {} : { summarizer }),
    })
    const conns = new Map<string, FakeConnection>()
    for (const id of ids) {
      const conn = new FakeConnection()
      conn.user = { id: JID[id] as string }
      conn.onStart = () => conn.emit({ state: 'connected' })
      conns.set(id, conn)
      link(h, id)
    }
    Object.assign(h.ctx, {
      connectionFactory: async (runtime: { layout: { id: string }; capture: never }) => {
        const conn = conns.get(runtime.layout.id) as FakeConnection
        conn.capture = runtime.capture
        return conn
      },
      daemonTiming: { ...TIMING },
    })
    return { h, conns }
  }

  it('an account with an invalid configuration is reported and left idle; the others run', async () => {
    const { h, conns } = await setupCommand(BASE, ['alpha', 'beta'])
    const betaFile = join(h.accountOf('beta').dir, 'config.json')
    writeFileSync(betaFile, JSON.stringify({ concurrency: 0 }))
    const finished = run(h, 'daemon')
    await until(() => startsOf(conns.get('alpha') as FakeConnection) === 1, 'alpha to connect')
    await waitFor(() => expect(h.err.join('\n')).toContain(betaFile))
    expect(h.err.filter((line) => line.includes(betaFile))).toHaveLength(1) // said once
    await waitFor(async () => {
      expect(JSON.parse(readFileSync(h.accountOf('beta').stateFile, 'utf8')).state).toBe('idle')
    })
    expect(conns.get('beta')?.calls).toEqual([])
    h.shutdown()
    expect(await finished).toBe(0)
  })

  it('exits 2 when --account names the broken account, or when every account is broken', async () => {
    const { h, conns } = await setupCommand(BASE, ['alpha', 'beta'])
    writeFileSync(join(h.accountOf('beta').dir, 'config.json'), JSON.stringify({ concurrency: 0 }))
    expect(await run(h, 'daemon', '--account', 'beta')).toBe(2)
    expect(h.err.join('\n')).toContain('"concurrency" must be a number greater than zero')
    writeFileSync(join(h.accountOf('alpha').dir, 'config.json'), JSON.stringify({ concurrency: 0 }))
    h.err.length = 0
    expect(await run(h, 'daemon')).toBe(2)
    expect(h.err.join('\n')).toContain('"concurrency" must be a number greater than zero')
    expect(conns.get('alpha')?.calls).toEqual([])
    expect(conns.get('beta')?.calls).toEqual([])
    expect(existsSync(h.layout.lockFile)).toBe(false)
  })

  it('an account with schedules and no provider is reported and left idle; one without schedules runs', async () => {
    const { h, conns } = await setupCommand({ language: 'en', timezone: 'UTC' }, ['alpha', 'beta'], null)
    // only beta has a schedule: it cannot run digests, alpha only captures
    const opened = await openInstallation({ layout: h.layout, clock: h.clock })
    if (!opened.ok) throw new Error('refused')
    const made = makeSchedule(ALL_WEEKDAYS, '07:00')
    if (!made.ok) throw new Error('invalid')
    opened.installation.schedules.add('beta', made.value)
    opened.installation.close()
    const finished = run(h, 'daemon')
    await until(() => startsOf(conns.get('alpha') as FakeConnection) === 1, 'alpha to connect')
    await waitFor(() => expect(h.err.join('\n')).toContain('provider.primary'))
    expect(conns.get('beta')?.calls).toEqual([])
    h.shutdown()
    expect(await finished).toBe(0)
  })
})

describe('msum daemon runs every account', () => {
  it('starts both, stops both on shutdown, and frees the lock', async () => {
    const h = await makeHarness({ config: BASE, accounts: ['alpha', 'beta'], liveClock: true })
    const conns = new Map<string, FakeConnection>()
    for (const id of ['alpha', 'beta']) {
      const conn = new FakeConnection()
      conn.user = { id: JID[id] as string }
      conn.onStart = () => conn.emit({ state: 'connected' })
      conns.set(id, conn)
      link(h, id)
    }
    Object.assign(h.ctx, {
      connectionFactory: async (runtime: { layout: { id: string }; capture: never }) => {
        const conn = conns.get(runtime.layout.id) as FakeConnection
        conn.capture = runtime.capture
        return conn
      },
      daemonTiming: { ...TIMING },
    })
    const finished = run(h, 'daemon')
    await waitFor(() => expect(h.out.join('\n')).toContain('Daemon running'))
    for (const id of ['alpha', 'beta']) await until(() => startsOf(conns.get(id) as FakeConnection) === 1, id)
    expect(existsSync(h.layout.lockFile)).toBe(true)
    expect(named(h, 'daemon.started')[0]).toMatchObject({ count: 2 })
    h.shutdown()
    expect(await finished).toBe(0)
    expect(h.out.join('\n')).toContain('Daemon stopped')
    for (const conn of conns.values()) expect(conn.calls).toContain('stop')
    expect(existsSync(h.layout.lockFile)).toBe(false)
  })

  it('with no accounts yet it keeps running and says so, and takes the first one that appears', async () => {
    const h = await makeHarness({ config: BASE, accounts: [], liveClock: true })
    const conn = new FakeConnection()
    conn.user = { id: JID.alpha as string }
    conn.onStart = () => conn.emit({ state: 'connected' })
    Object.assign(h.ctx, {
      connectionFactory: async (runtime: { capture: never }) => {
        conn.capture = runtime.capture
        return conn
      },
      daemonTiming: { ...TIMING },
    })
    const finished = run(h, 'daemon')
    await waitFor(() => expect(h.err.join('\n')).toContain('There are no accounts yet'))
    const opened = await openInstallation({ layout: h.layout, clock: h.clock })
    if (!opened.ok) throw new Error('refused')
    await opened.installation.createAccount('alpha')
    opened.installation.close()
    link(h, 'alpha')
    await until(() => startsOf(conn) === 1, 'the new account to start')
    h.shutdown()
    expect(await finished).toBe(0)
  })

  it('refuses to start, before connecting anything, when an account has schedules and no provider', async () => {
    const h = await makeHarness({
      config: { language: 'en', timezone: BA, schedules: ['0 7 * * *'] },
      accounts: ['alpha', 'beta'],
      summarizer: null,
    })
    link(h, 'alpha')
    link(h, 'beta')
    expect(await run(h, 'daemon')).toBe(2)
    expect(h.err.join('\n')).toContain('provider.primary')
    expect(h.connection.calls).toEqual([])
    expect(existsSync(h.layout.lockFile)).toBe(false)
  })

  it('--retry clears the blocks of the accounts it runs', async () => {
    const h = await makeHarness({ config: BASE, accounts: ['alpha'], liveClock: true })
    link(h, 'alpha')
    h.connection.user = { id: JID.alpha as string }
    await writeBlocked(h.account.blockedFile, 'forbidden', NOW)
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    Object.assign(h.ctx, { daemonTiming: { ...TIMING } })
    const finished = run(h, 'daemon', '--retry')
    await until(() => h.connection.calls.includes('start'), 'the account to connect')
    expect(existsSync(h.account.blockedFile)).toBe(false)
    h.shutdown()
    expect(await finished).toBe(0)
  })
})
