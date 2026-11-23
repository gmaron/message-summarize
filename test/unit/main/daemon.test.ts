import { readFileSync, statSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ok } from '../../../src/domain/result.js'
import { CronerScheduler } from '../../../src/infrastructure/scheduling/croner-scheduler.js'
import type { WhatsAppStatus } from '../../../src/infrastructure/whatsapp/connection.js'
import { type BlockedReason, writeBlocked } from '../../../src/main/blocked.js'
import { Daemon } from '../../../src/main/daemon.js'
import type { Runtime } from '../../../src/main/runtime.js'
import {
  BA,
  disposeHarnesses,
  FakeSummarizer,
  type Harness,
  ME,
  makeHarness,
  OTHER,
  SUMMARY,
  seedMessages,
} from '../../support/cli-harness.js'
import { isWindows } from '../../support/platform.js'

/** The events the logger wrote, as objects. */
const events = (h: Harness): { event: string; level: string; [key: string]: unknown }[] =>
  h.logs.map((line) => JSON.parse(line))
const named = (h: Harness, event: string) => events(h).filter((e) => e.event === event)
/** Lets promises settle without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0)

interface Setup {
  harness: Harness
  runtime: Runtime
  daemon: Daemon
}

async function setup(
  options: {
    config?: Record<string, unknown>
    bound?: string | null
    summarizer?: FakeSummarizer | null
    now?: string
    /** A blocked marker left by a previous run. */
    marker?: BlockedReason
    /**
     * How often the daemon reloads the schedules and sweeps the outbox. A test that moves the fake clock for hours must
     * use `LONG_INTERVALS`: at the defaults (5 s and 30 s) 26 hours are about 18,700 reloads and 3,100 sweeps, each with
     * SQLite reads, which is CPU work that takes seconds and fails under load. The schedules are read when the daemon
     * starts, so nothing is missed.
     */
    timing?: { scheduleReloadMs: number; sweepMs: number }
  } = {},
): Promise<Setup> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(Date.parse(options.now ?? '2026-11-17T15:00:00Z'))
  const summarizer = options.summarizer === undefined ? new FakeSummarizer() : options.summarizer
  const harness = await makeHarness({
    config: { language: 'en', timezone: BA, schedules: [], provider: { primary: 'claude-cli' }, ...options.config },
    summarizer,
    liveClock: true,
  })
  const runtime = harness.runtime()
  if (options.bound !== null) runtime.identity.bind(options.bound ?? ME)
  if (options.marker !== undefined) await writeBlocked(harness.account.blockedFile, options.marker, Date.now())
  const daemon = new Daemon({
    runtime,
    connection: harness.connection,
    logger: harness.ctx.logger,
    ...(options.timing ?? {}),
  })
  return { harness, runtime, daemon }
}

/** Intervals for the tests that advance the fake clock for hours (see `setup`). */
const LONG_INTERVALS = { scheduleReloadMs: 3_600_000, sweepMs: 3_600_000 }

let current: Setup | null = null
const start = async (options?: Parameters<typeof setup>[0]): Promise<Setup> => {
  current = await setup(options)
  await current.daemon.start()
  return current
}

afterEach(async () => {
  if (current !== null) {
    await current.daemon.stop()
    current.runtime.close()
    current = null
  }
  vi.useRealTimers()
  disposeHarnesses()
})

const queue = (runtime: Runtime, previous: number | null, pointer: number, ...parts: string[]) =>
  runtime.store.commit({ previousPointer: previous, pointer, digest: null, parts })

describe('Daemon: connection, reconciliation and delivery (RF-51, RF-52)', () => {
  it('on connect, checks the account and delivers what is queued', async () => {
    const { harness, runtime } = await start()
    await queue(runtime, null, 1, 'part A', 'part B')
    expect(harness.connection.sent).toEqual([])
    harness.connection.emit({ state: 'connected' })
    await settle()
    expect(harness.connection.sent).toEqual(['part A', 'part B'])
    expect(named(harness, 'account.checked')[0]).toMatchObject({ state: 'matches' })
    expect(await runtime.outbox.pending()).toEqual([])
  })

  it('binds the account on the first connection', async () => {
    const { harness, runtime } = await start({ bound: null })
    harness.connection.emit({ state: 'connected' })
    await settle()
    expect(runtime.identity.get()).toBe(ME)
    expect(named(harness, 'account.checked')[0]).toMatchObject({ state: 'bound' })
  })

  it('delivers NOTHING when another account is linked, and says so (RF-51)', async () => {
    const { harness, runtime } = await start({ bound: OTHER })
    await queue(runtime, null, 1, 'private digest')
    harness.connection.emit({ state: 'connected' })
    await settle()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(harness.connection.sent).toEqual([])
    expect(named(harness, 'daemon.blocked')[0]).toMatchObject({ level: 'error', reason: 'mismatch' })
    expect(await runtime.outbox.pending()).toHaveLength(1)
    expect(runtime.identity.get()).toBe(OTHER)
  })

  it('sweeps the outbox every 30 s while connected, and not while disconnected', async () => {
    const { harness, runtime } = await start()
    harness.connection.emit({ state: 'connected' })
    await settle()
    await queue(runtime, null, 1, 'late part')
    await vi.advanceTimersByTimeAsync(29_000)
    expect(harness.connection.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.connection.sent).toEqual(['late part'])

    harness.connection.emit({ state: 'reconnecting', attempt: 1, delayMs: 1000, reason: 'connectionLost' })
    await queue(runtime, 1, 2, 'while offline')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(harness.connection.sent).toEqual(['late part'])
    harness.connection.emit({ state: 'connected' })
    await settle()
    expect(harness.connection.sent).toEqual(['late part', 'while offline'])
  })

  it('logs a delivery that stops, with a fixed reason and no text', async () => {
    const { harness, runtime } = await start()
    harness.connection.sendFails = true
    await queue(runtime, null, 1, 'SECRET-TEXT')
    harness.connection.emit({ state: 'connected' })
    await settle()
    expect(named(harness, 'delivery.stopped')[0]).toMatchObject({ level: 'warn', failure: 'error', delivered: 0 })
    expect(harness.logs.join('')).not.toContain('SECRET-TEXT')
    expect(await runtime.outbox.pending()).toHaveLength(1)
  })

  it('logs the status of the connection, with attempt and delay when it reconnects', async () => {
    const { harness } = await start()
    harness.connection.emit({ state: 'reconnecting', attempt: 2, delayMs: 2000, reason: 'connectionLost' })
    expect(named(harness, 'connection.status').at(-1)).toMatchObject({
      state: 'reconnecting',
      attempt: 2,
      delayMs: 2000,
      reason: 'connectionLost',
    })
  })
})

describe('Daemon: digests (RF-63, RF-66)', () => {
  it('after a committed digest, delivers it', async () => {
    const { harness, runtime, daemon } = await start()
    await seedMessages(runtime, [{ id: 'm1', text: 'dinner at 9?', timestamp: Date.now() - 3_600_000 }])
    harness.connection.emit({ state: 'connected' })
    await settle()
    expect(await daemon.runScheduledDigest('schedule')).toBe('ran')
    expect(harness.connection.sent).toHaveLength(1)
    expect(harness.connection.sent[0]).toContain(SUMMARY.resumen)
    expect(named(harness, 'digest.committed')[0]).toMatchObject({
      trigger: 'schedule',
      summarized: 1,
      failed: 0,
      parts: 1,
    })
  })

  it('commits while disconnected and delivers on connect', async () => {
    const { harness, runtime, daemon } = await start()
    await seedMessages(runtime, [{ id: 'm1', text: 'hello', timestamp: Date.now() - 3_600_000 }])
    expect(await daemon.runScheduledDigest('schedule')).toBe('ran')
    expect(harness.connection.sent).toEqual([])
    expect(await runtime.outbox.pending()).toHaveLength(1)
    harness.connection.emit({ state: 'connected' })
    await settle()
    expect(harness.connection.sent).toHaveLength(1)
  })

  it('never runs two digests at once: the second is skipped while the first is in progress', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const summarizer = new FakeSummarizer(async () => {
      await gate
      return ok(SUMMARY)
    })
    const { harness, runtime, daemon } = await start({ summarizer })
    await seedMessages(runtime, [{ id: 'm1', text: 'hello', timestamp: Date.now() - 3_600_000 }])
    const first = daemon.runScheduledDigest('schedule')
    await settle()
    expect(await daemon.runScheduledDigest('schedule')).toBe('busy')
    expect(await daemon.runScheduledDigest('missed')).toBe('busy')
    expect(summarizer.requests).toHaveLength(1)
    release()
    expect(await first).toBe('ran')
    expect(named(harness, 'digest.skipped')).toHaveLength(2)
    // and the slot is free again
    expect(await daemon.runScheduledDigest('schedule')).toBe('ran')
  })

  it('reports a digest that fails by its reason, and keeps running', async () => {
    const { harness, daemon } = await start({ summarizer: null })
    // no provider: the use case does not exist
    harness.connection.emit({ state: 'connected' })
    await settle()
    expect(await daemon.runScheduledDigest('schedule')).toBe('failed')
    expect(named(harness, 'digest.failed')[0]).toMatchObject({ level: 'error', reason: 'noProvider' })
  })
})

describe('Daemon: schedules (RF-60, RF-62)', () => {
  it('fires at the cron time in the configured time zone', async () => {
    // 06:00 in Buenos Aires (UTC-3) is 09:00Z; the schedule is 07:00 local = 10:00Z.
    const { harness } = await start({
      config: { schedules: ['0 7 * * *'] },
      now: '2026-11-17T09:00:00Z',
      timing: LONG_INTERVALS,
    })
    await vi.advanceTimersByTimeAsync(59 * 60_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(1)
    expect(named(harness, 'schedule.fired')[0]).toMatchObject({ schedule: '0 7 * * *' })
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(2)
  })

  it('uses the time zone of the configuration, not the machine', async () => {
    // Europe/Madrid is UTC+1 in November: 07:00 local = 06:00Z.
    const { harness } = await start({
      config: { schedules: ['0 7 * * *'], timezone: 'Europe/Madrid' },
      now: '2026-11-17T05:30:00Z',
      timing: LONG_INTERVALS,
    })
    await vi.advanceTimersByTimeAsync(29 * 60_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(1)
  })

  it('runs a digest on every tick, and a tick that finds one running is skipped', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const summarizer = new FakeSummarizer(async () => {
      await gate
      return ok(SUMMARY)
    })
    const { harness, runtime } = await start({
      // two different expressions for the same instant (the same expression twice is one job)
      config: { schedules: ['0 7 * * *', '0 7 * * 0-6'] },
      now: '2026-11-17T09:58:00Z',
      summarizer,
    })
    await seedMessages(runtime, [{ id: 'm1', text: 'hello', timestamp: Date.now() - 3_600_000 }])
    harness.connection.emit({ state: 'connected' })
    await vi.advanceTimersByTimeAsync(121_000)
    // two schedules fired at the same instant: one digest started, the other was skipped
    expect(named(harness, 'schedule.fired')).toHaveLength(2)
    expect(named(harness, 'digest.started')).toHaveLength(1)
    expect(named(harness, 'digest.skipped')).toHaveLength(1)
    release()
    await settle()
    expect(named(harness, 'digest.committed')).toHaveLength(1)
  })

  it('a tick that fires while disconnected is deferred, then runs ONCE after the connection had time to sync', async () => {
    const { harness, runtime } = await start({ config: { schedules: ['0 7 * * *'] }, now: '2026-11-17T09:59:00Z' })
    await seedMessages(runtime, [{ id: 'm1', text: 'hello', timestamp: Date.now() - 3_600_000 }])
    await vi.advanceTimersByTimeAsync(61_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(1)
    expect(named(harness, 'schedule.deferred')).toHaveLength(1)
    expect(named(harness, 'digest.started')).toHaveLength(0)

    harness.connection.emit({ state: 'connected' })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(named(harness, 'digest.started')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(named(harness, 'digest.started')).toEqual([expect.objectContaining({ trigger: 'missed' })])
    expect(named(harness, 'digest.committed')).toHaveLength(1)
    // the deferral is spent
    harness.connection.emit({ state: 'reconnecting', attempt: 1, delayMs: 1000, reason: 'connectionLost' })
    harness.connection.emit({ state: 'connected' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(named(harness, 'digest.started')).toHaveLength(1)
  })

  it('a tick that fires right after the connection opened is deferred to the same catch-up', async () => {
    const { harness, runtime } = await start({ config: { schedules: ['0 7 * * *'] }, now: '2026-11-17T09:59:00Z' })
    await seedMessages(runtime, [{ id: 'm1', text: 'hello', timestamp: Date.now() - 3_600_000 }])
    await vi.advanceTimersByTimeAsync(30_000)
    harness.connection.emit({ state: 'connected' }) // 09:59:30
    await vi.advanceTimersByTimeAsync(31_000) // the tick fires at 10:00:00, 30 s after connecting
    expect(named(harness, 'schedule.fired')).toHaveLength(1)
    expect(named(harness, 'schedule.deferred')).toHaveLength(1)
    expect(named(harness, 'digest.started')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(30_000) // the catch-up, 60 s after connecting
    expect(named(harness, 'digest.started')).toHaveLength(1)
    expect(named(harness, 'digest.started')[0]).toMatchObject({ trigger: 'missed' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(named(harness, 'digest.started')).toHaveLength(1)
  })

  it('a deferred tick waits for the next connection when the connection drops before the catch-up', async () => {
    const { harness } = await start({ config: { schedules: ['0 7 * * *'] }, now: '2026-11-17T09:59:00Z' })
    await vi.advanceTimersByTimeAsync(61_000)
    harness.connection.emit({ state: 'connected' })
    await vi.advanceTimersByTimeAsync(30_000)
    harness.connection.emit({ state: 'reconnecting', attempt: 1, delayMs: 1000, reason: 'connectionLost' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(named(harness, 'digest.started')).toHaveLength(0)
    harness.connection.emit({ state: 'connected' })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(named(harness, 'digest.started')).toHaveLength(1)
  })

  it('stops the schedules and the sweep when it stops', async () => {
    const { harness, runtime, daemon } = await start({
      config: { schedules: ['0 7 * * *'] },
      now: '2026-11-17T09:59:00Z',
    })
    harness.connection.emit({ state: 'connected' })
    await settle()
    await daemon.stop()
    expect(await daemon.finished).toBe(0)
    await queue(runtime, null, 1, 'after stop')
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(0)
    expect(harness.connection.sent).toEqual([])
    expect(harness.connection.calls).toContain('stop')
    expect(named(harness, 'account.stopped')).toHaveLength(1)
  })
})

describe('Daemon: a run missed while it was off (RF-65)', () => {
  const T = (iso: string) => Date.parse(iso)
  // The schedule is 07:00 in Buenos Aires = 10:00Z. "Now" is 15:00Z the same day.
  const config = { schedules: ['0 7 * * *'] }
  const NOW = '2026-11-17T15:00:00Z'

  const afterConnect = async (h: Harness) => {
    h.connection.emit({ state: 'connected' })
    await settle()
    await vi.advanceTimersByTimeAsync(60_000)
  }

  it('runs ONE digest after connecting when the last scheduled time is later than the pointer', async () => {
    const { harness, runtime } = await start({ config, now: NOW })
    await queue(runtime, null, T('2026-11-16T22:00:00Z'))
    await afterConnect(harness)
    expect(named(harness, 'digest.missed')).toHaveLength(1)
    expect(named(harness, 'digest.committed')).toHaveLength(1)
    expect(named(harness, 'digest.committed')[0]).toMatchObject({ trigger: 'missed' })
    // it does not repeat on a later connection
    harness.connection.emit({ state: 'reconnecting', attempt: 1, delayMs: 1000, reason: 'connectionLost' })
    await afterConnect(harness)
    expect(named(harness, 'digest.missed')).toHaveLength(1)
  })

  it('waits for the offline messages before catching up', async () => {
    const { harness, runtime } = await start({ config, now: NOW })
    await queue(runtime, null, T('2026-11-16T22:00:00Z'))
    harness.connection.emit({ state: 'connected' })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(named(harness, 'digest.started')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(named(harness, 'digest.started')).toHaveLength(1)
  })

  it('runs once even when several schedules were missed', async () => {
    const { harness, runtime } = await start({
      config: { schedules: ['0 7 * * *', '0 9 * * *', '0 12 * * *'] },
      now: NOW,
    })
    await queue(runtime, null, T('2026-11-15T12:00:00Z'))
    await afterConnect(harness)
    expect(named(harness, 'digest.committed')).toHaveLength(1)
  })

  it('does nothing when the pointer is already past the last scheduled time', async () => {
    const { harness, runtime } = await start({ config, now: NOW })
    await queue(runtime, null, T('2026-11-17T11:00:00Z'))
    await afterConnect(harness)
    expect(named(harness, 'digest.missed')).toHaveLength(0)
    expect(named(harness, 'digest.started')).toHaveLength(0)
  })

  it('does nothing on a fresh installation (no pointer), and with no schedules', async () => {
    const fresh = await start({ config, now: NOW })
    await afterConnect(fresh.harness)
    expect(named(fresh.harness, 'digest.started')).toHaveLength(0)
    await fresh.daemon.stop()
    fresh.runtime.close()
    current = null
    disposeHarnesses()

    const { harness, runtime } = await start({ config: { schedules: [] }, now: NOW })
    await queue(runtime, null, T('2026-11-10T00:00:00Z'))
    await afterConnect(harness)
    expect(named(harness, 'digest.started')).toHaveLength(0)
  })

  it('does not run before the account was reconciled', async () => {
    const { harness, runtime } = await start({ config, now: NOW, bound: OTHER })
    await queue(runtime, null, T('2026-11-16T22:00:00Z'))
    await afterConnect(harness)
    expect(named(harness, 'digest.started')).toHaveLength(0)
  })
})

const connectionEnds: [string, WhatsAppStatus, BlockedReason][] = [
  ['logged out from the phone', { state: 'loggedOut' }, 'loggedOut'],
  ['forbidden (403)', { state: 'error', reason: 'forbidden' }, 'forbidden'],
  ['replaced (440)', { state: 'error', reason: 'replaced' }, 'replaced'],
  ['the socket cannot be opened', { state: 'error', reason: 'socketFailed' }, 'socketFailed'],
  ['a QR asked for (the account is not linked)', { state: 'qr', qr: 'QR-SECRET-CREDENTIAL' }, 'notLinked'],
]

/** What the daemon must do on every terminal state: stop, say it once, leave the marker, and stay idle. */
async function expectIdle(s: Setup, reason: BlockedReason): Promise<void> {
  const { harness, runtime, daemon } = s
  await daemon.whenBlocked()
  const checkedBefore = named(harness, 'account.checked').length
  expect(daemon.blocked).toBe(reason)
  // said once, as an error
  expect(named(harness, 'daemon.blocked')).toEqual([expect.objectContaining({ level: 'error', reason })])
  // the connection was stopped, and the marker holds the reason and the time, private
  expect(harness.connection.calls).toContain('stop')
  const marker = JSON.parse(readFileSync(harness.account.blockedFile, 'utf8'))
  expect(marker).toEqual({ reason, at: Date.now() })
  if (!isWindows) expect(statSync(harness.account.blockedFile).mode & 0o777).toBe(0o600)

  // idle: no schedule, no digest, no delivery, no new connection, however long it waits
  harness.connection.calls.length = 0
  await queue(runtime, null, 1, 'must not be delivered')
  await vi.advanceTimersByTimeAsync(3 * 60 * 60_000)
  expect(named(harness, 'schedule.fired')).toHaveLength(0)
  expect(named(harness, 'digest.started')).toHaveLength(0)
  expect(harness.connection.sent).toEqual([])
  expect(harness.connection.calls).not.toContain('start')
  // and what the dead connection says afterwards is ignored
  harness.connection.emit({ state: 'connected' })
  await settle()
  expect(named(harness, 'account.checked')).toHaveLength(checkedBefore)
  expect(harness.logs.join('')).not.toContain('QR-SECRET-CREDENTIAL')

  // it never ends by itself: only a stop ends it
  let ended = false
  void daemon.finished.then(() => {
    ended = true
  })
  await settle()
  expect(ended).toBe(false)
  await daemon.stop()
  expect(await daemon.finished).toBe(0)
}

describe('Daemon: terminal states of the connection (idle, never a reconnect loop)', () => {
  it.each(connectionEnds)('%s', async (_name, status, reason) => {
    const s = await start({
      config: { schedules: ['0 7 * * *'] },
      now: '2026-11-17T09:00:00Z',
      timing: LONG_INTERVALS,
    })
    s.harness.connection.emit({ state: 'connected' })
    await settle()
    s.harness.connection.emit(status)
    await settle()
    await expectIdle(s, reason)
  })

  it('another account (mismatch)', async () => {
    const s = await start({
      bound: OTHER,
      config: { schedules: ['0 7 * * *'] },
      now: '2026-11-17T09:00:00Z',
      timing: LONG_INTERVALS,
    })
    s.harness.connection.emit({ state: 'connected' })
    await settle()
    await expectIdle(s, 'mismatch')
    expect(s.runtime.identity.get()).toBe(OTHER)
  })

  it('a socket with no phone number (noAccount)', async () => {
    const s = await start({
      config: { schedules: ['0 7 * * *'] },
      now: '2026-11-17T09:00:00Z',
      timing: LONG_INTERVALS,
    })
    s.harness.connection.user = undefined
    s.harness.connection.emit({ state: 'connected' })
    await settle()
    await expectIdle(s, 'noAccount')
  })

  it('nothing is captured into the wrong account after a mismatch', async () => {
    const { harness, runtime } = await start({ bound: OTHER })
    harness.connection.capture = runtime.capture
    harness.connection.emit({ state: 'connected' })
    await settle()
    const incoming = {
      origin: 'live' as const,
      isGroup: false,
      message: {
        id: 'late',
        conversationId: 'c@s.whatsapp.net',
        senderId: 'c@s.whatsapp.net',
        senderName: null,
        senderAddress: '+9911963367943',
        fromMe: false,
        timestamp: Date.now(),
        kind: 'text' as const,
        text: 'from the wrong account',
        transcript: null,
        read: false,
      },
    }
    // the socket was stopped when the mismatch was seen: it delivers nothing to the capture
    expect(await harness.connection.receive(incoming)).toBe(false)
    expect(await runtime.repository.findConversation('c@s.whatsapp.net')).toBeNull()
  })

  it('does not reconnect: no second start, whatever the reconnect status says', async () => {
    const { harness } = await start()
    harness.connection.emit({ state: 'loggedOut' })
    await settle()
    harness.connection.emit({ state: 'reconnecting', attempt: 1, delayMs: 1000, reason: 'connectionLost' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(harness.connection.calls.filter((c) => c === 'start')).toHaveLength(1)
  })

  it('restarted while blocked: logs the reason, says it, and stays idle without connecting', async () => {
    const said: string[] = []
    const s = await setup({ marker: 'loggedOut', config: { schedules: ['0 7 * * *'] }, now: '2026-11-17T09:00:00Z' })
    current = s
    const daemon = new Daemon({
      runtime: s.runtime,
      connection: s.harness.connection,
      logger: s.harness.ctx.logger,
      onBlocked: (reason) => said.push(reason),
      ...LONG_INTERVALS,
    })
    s.daemon = daemon
    await daemon.start()
    expect(daemon.blocked).toBe('loggedOut')
    expect(said).toEqual(['loggedOut'])
    expect(named(s.harness, 'daemon.blocked')).toEqual([
      expect.objectContaining({ reason: 'loggedOut', level: 'error' }),
    ])
    await queue(s.runtime, null, 1, 'part')
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000)
    expect(s.harness.connection.calls).toEqual([])
    expect(named(s.harness, 'schedule.fired')).toHaveLength(0)
    expect(named(s.harness, 'account.started')).toHaveLength(0)
    await daemon.stop()
    expect(await daemon.finished).toBe(0)
    // and the marker is still there for the next restart
    expect(JSON.parse(readFileSync(s.harness.account.blockedFile, 'utf8')).reason).toBe('loggedOut')
  })

  it('the QR is never logged', async () => {
    const { harness } = await start()
    harness.connection.emit({ state: 'qr', qr: 'QR-SECRET-CREDENTIAL' })
    await settle()
    expect(harness.logs.join('')).not.toContain('QR-SECRET-CREDENTIAL')
  })
})

describe('Daemon: stopping', () => {
  it('stop is idempotent', async () => {
    const { daemon } = await start()
    await Promise.all([daemon.stop(), daemon.stop()])
    expect(await daemon.finished).toBe(0)
  })

  it('on stop, waits for a digest in progress up to the grace period', async () => {
    const summarizer = new FakeSummarizer(() => new Promise(() => {}))
    const { harness, runtime, daemon } = await start({ summarizer })
    await seedMessages(runtime, [{ id: 'm1', text: 'hello', timestamp: Date.now() - 3_600_000 }])
    void daemon.runScheduledDigest('schedule')
    await settle()
    const stopped = daemon.stop()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(named(harness, 'account.stopped')).toHaveLength(0)
    // the whole shutdown is cut at 7 s, inside Docker's 10 s stop timeout
    await vi.advanceTimersByTimeAsync(1_500)
    await stopped
    expect(named(harness, 'account.stopped')).toHaveLength(1)
  })

  it('on stop, waits for the connection past the grace period: a history chunk being written must end first', async () => {
    const { harness, daemon } = await start()
    let release: () => void = () => {}
    harness.connection.stop = () => new Promise<void>((resolve) => (release = resolve))
    const stopped = daemon.stop()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(named(harness, 'account.stopped')).toHaveLength(0)
    release()
    await stopped
    expect(named(harness, 'account.stopped')).toHaveLength(1)
    expect(await daemon.finished).toBe(0)
  })
})

describe('CronerScheduler', () => {
  it('computes next runs and the last due time in the time zone', () => {
    const scheduler = new CronerScheduler({ timezone: BA, schedules: ['0 7 * * *', '0 19 * * *'], onTick: () => {} })
    const now = new Date('2026-11-17T15:00:00Z') // 12:00 in Buenos Aires
    expect(scheduler.nextRuns(now).map((r) => r.next?.toISOString())).toEqual([
      '2026-11-18T10:00:00.000Z',
      '2026-11-17T22:00:00.000Z',
    ])
    expect(scheduler.lastDue(now)?.toISOString()).toBe('2026-11-17T10:00:00.000Z')
  })

  it('has no last due time without schedules', () => {
    expect(new CronerScheduler({ timezone: BA, schedules: [], onTick: () => {} }).lastDue(new Date())).toBeNull()
  })

  it('follows daylight saving time (RF-62)', () => {
    // Madrid: 07:00 local is 06:00Z in winter and 05:00Z in summer.
    const scheduler = new CronerScheduler({ timezone: 'Europe/Madrid', schedules: ['0 7 * * *'], onTick: () => {} })
    expect(scheduler.nextRuns(new Date('2026-01-10T00:00:00Z'))[0]?.next?.toISOString()).toBe(
      '2026-01-10T06:00:00.000Z',
    )
    expect(scheduler.nextRuns(new Date('2026-07-10T00:00:00Z'))[0]?.next?.toISOString()).toBe(
      '2026-07-10T05:00:00.000Z',
    )
  })

  beforeEach(() => {
    vi.useRealTimers()
  })
})

describe('Daemon.applyConfig (RF-73)', () => {
  it('warns once that the schedules have no provider to run with, and says nothing when there is one', async () => {
    const without = await start({ config: { schedules: ['0 9 * * *'] }, summarizer: null })
    expect(without.runtime.generateDigest).toBeNull()
    without.daemon.applyConfig(without.runtime.config)
    expect(named(without.harness, 'schedules.noProvider')).toEqual([
      expect.objectContaining({ level: 'warn', count: 1 }),
    ])
    expect(named(without.harness, 'config.applied')).toHaveLength(1)
    await without.daemon.stop()
    without.runtime.close()
    current = null
    disposeHarnesses()

    const withProvider = await start({ config: { schedules: ['0 9 * * *'] } })
    withProvider.daemon.applyConfig(withProvider.runtime.config)
    expect(named(withProvider.harness, 'schedules.noProvider')).toEqual([])
    expect(named(withProvider.harness, 'config.applied')).toHaveLength(1)
  })
})
