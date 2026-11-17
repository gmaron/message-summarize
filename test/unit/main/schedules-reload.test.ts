import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleToCron } from '../../../src/domain/schedule.js'
import {
  APP_MIGRATIONS,
  currentVersion,
  openAppDatabase,
  openDatabase,
} from '../../../src/infrastructure/persistence/sqlite/index.js'
import { CronerScheduler } from '../../../src/infrastructure/scheduling/croner-scheduler.js'
import { openInstallation } from '../../../src/main/accounts.js'
import { runMain } from '../../../src/main/app.js'
import { Daemon } from '../../../src/main/daemon.js'
import { BA, disposeHarnesses, FakeSummarizer, type Harness, makeHarness, waitFor } from '../../support/cli-harness.js'

const FAKE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  disposeHarnesses()
})

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const BASE = { language: 'en', timezone: BA, provider: { primary: 'claude-cli' } }

describe('CronerScheduler: one job per distinct expression, diffed on reload', () => {
  const scheduler = (schedules: string[], onTick: (schedule: string) => void = () => {}) =>
    new CronerScheduler({ timezone: 'UTC', schedules, onTick })

  it('keeps the jobs that did not change, stops the ones that are gone and creates the new ones', () => {
    const s = scheduler(['0 7 * * *'])
    s.start()
    const seven = s.generationOf('0 7 * * *')
    expect(seven).toBeDefined()

    s.replace(['0 7 * * *', '0 9 * * *'])
    expect(s.generationOf('0 7 * * *')).toBe(seven) // untouched
    const nine = s.generationOf('0 9 * * *')
    expect(nine).toBeGreaterThan(seven as number)

    s.replace(['0 9 * * *'])
    expect(s.generationOf('0 7 * * *')).toBeUndefined()
    expect(s.generationOf('0 9 * * *')).toBe(nine)

    // a changed expression (other days) is a different job
    s.replace(['0 9 * * 1-5'])
    expect(s.generationOf('0 9 * * *')).toBeUndefined()
    expect(s.generationOf('0 9 * * 1-5')).toBeGreaterThan(nine as number)
    s.stop()
    expect(s.generationOf('0 9 * * 1-5')).toBeUndefined()
  })

  it('has one job for an expression given twice', () => {
    const s = scheduler(['0 7 * * *', '0 7 * * *'])
    expect(s.count).toBe(1)
    s.replace(['0 8 * * *', '0 8 * * *', '0 9 * * *'])
    expect(s.expressions).toEqual(['0 8 * * *', '0 9 * * *'])
  })

  it('an unrelated change does not re-create a job that is about to fire, and it still fires once', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] })
    vi.setSystemTime(Date.parse('2026-11-17T06:59:59.000Z'))
    const fired: string[] = []
    const s = scheduler(['0 7 * * *'], (schedule) => fired.push(schedule))
    s.start()
    const before = s.generationOf('0 7 * * *')
    await vi.advanceTimersByTimeAsync(500)
    s.replace(['0 7 * * *', '0 21 * * *'])
    expect(s.generationOf('0 7 * * *')).toBe(before)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fired).toEqual(['0 7 * * *'])
    s.stop()
  })

  it('does not arm anything while it is stopped, and arms what replace gave once started', () => {
    const s = scheduler(['0 7 * * *'])
    s.replace(['0 8 * * *'])
    expect(s.generationOf('0 8 * * *')).toBeUndefined()
    s.start()
    expect(s.generationOf('0 8 * * *')).toBeDefined()
    s.stop()
  })
})

describe('Daemon: schedules added when there is no provider', () => {
  let current: { daemon: Daemon; close: () => void } | null = null
  afterEach(async () => {
    if (current !== null) {
      await current.daemon.stop()
      current.close()
      current = null
    }
  })

  async function start(summarizer: FakeSummarizer | null) {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] })
    vi.setSystemTime(Date.parse('2026-11-17T09:00:00Z'))
    const harness = await makeHarness({ config: BASE, summarizer, liveClock: true })
    const opened = await openInstallation({ layout: harness.layout, clock: harness.clock })
    if (!opened.ok) throw new Error('refused')
    const { installation } = opened
    const runtime = harness.runtime()
    const daemon = new Daemon({
      runtime,
      connection: harness.connection,
      logger: harness.ctx.logger,
      scheduleReloadMs: 30_000,
      scheduleSource: () => installation.schedules.list('default').map((s) => scheduleToCron(s.schedule)),
    })
    await daemon.start()
    current = {
      daemon,
      close: () => {
        runtime.close()
        installation.close()
      },
    }
    return { harness, daemon }
  }

  const logged = (h: Harness, event: string) =>
    h.logs.map((line) => JSON.parse(line) as { event: string; level: string }).filter((e) => e.event === event)

  it('warns once when the first schedule arrives, and keeps running', async () => {
    const { harness, daemon } = await start(null)
    await run(harness, 'schedule', 'add', '--time', '07:00')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(logged(harness, 'schedules.reloaded')).toHaveLength(1)
    expect(logged(harness, 'schedules.noProvider')).toEqual([expect.objectContaining({ level: 'warn', count: 1 })])
    expect(daemon.blocked).toBeNull()
    // more schedules later: the warning was already given
    await run(harness, 'schedule', 'add', '--time', '08:00')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(logged(harness, 'schedules.reloaded')).toHaveLength(2)
    expect(logged(harness, 'schedules.noProvider')).toHaveLength(1)
    expect(daemon.blocked).toBeNull()
  })

  it('says nothing when there is a provider', async () => {
    const { harness } = await start(new FakeSummarizer())
    await run(harness, 'schedule', 'add', '--time', '07:00')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(logged(harness, 'schedules.reloaded')).toHaveLength(1)
    expect(logged(harness, 'schedules.noProvider')).toEqual([])
  })
})

describe('upgrading app.db from schema version 1', () => {
  it('adds the schedules table and the import flag, and the first start imports the configuration schedules', async () => {
    const h = await makeHarness({
      config: { ...BASE, schedules: ['0 7 * * *', '30 19 * * 1-5'] },
      accounts: [],
    })
    // the app.db of the commit before schedules: version 1, with account rows
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${h.layout.appDbFile}${suffix}`, { force: true })
    const old = openDatabase(h.layout.appDbFile, { migrations: [APP_MIGRATIONS[0] as (typeof APP_MIGRATIONS)[number]] })
    expect(currentVersion(old)).toBe(1)
    old.exec(
      "INSERT INTO accounts (id, platform, created_at) VALUES ('alpha', 'whatsapp', '2026-01-01T00:00:00.000Z'), ('beta', 'whatsapp', '2026-01-02T00:00:00.000Z')",
    )
    old.close()
    for (const id of ['alpha', 'beta']) mkdirSync(h.accountOf(id).authDir, { recursive: true, mode: 0o700 })

    // opening it upgrades to version 2: rows kept, nothing imported yet
    const upgraded = openAppDatabase(h.layout.appDbFile)
    expect(currentVersion(upgraded)).toBe(APP_MIGRATIONS.length)
    expect(upgraded.prepare('SELECT id, schedules_imported AS flag FROM accounts ORDER BY id').all()).toEqual([
      { id: 'alpha', flag: 0 },
      { id: 'beta', flag: 0 },
    ])
    expect(upgraded.prepare('SELECT COUNT(*) AS n FROM schedules').get()).toEqual({ n: 0 })
    upgraded.close()

    // the first use of an account imports its schedules, once; the other account waits for its own first use
    expect(await run(h, 'schedule', 'ls', '--account', 'alpha')).toBe(0)
    expect(h.out.join('\n')).toMatch(/#1 {2}every day at 07:00/)
    expect(h.out.join('\n')).toMatch(/#2 {2}weekdays at 19:30/)
    const db = new DatabaseSync(h.layout.appDbFile)
    try {
      expect(db.prepare('SELECT id, schedules_imported AS flag FROM accounts ORDER BY id').all()).toEqual([
        { id: 'alpha', flag: 1 },
        { id: 'beta', flag: 0 },
      ])
    } finally {
      db.close()
    }
    // nothing is imported twice
    h.out.length = 0
    await run(h, 'schedule', 'ls', '--account', 'alpha')
    expect(h.out).toHaveLength(2)
    h.out.length = 0
    await run(h, 'schedule', 'ls', '--account', 'beta')
    expect(h.out).toHaveLength(2)
  })

  it('a daemon of the upgraded account starts with the imported schedules', async () => {
    const h = await makeHarness({ config: { ...BASE, schedules: ['0 7 * * *'] }, accounts: ['default'] })
    // as if the account had been created before schedules existed: flag back to 0, no rows
    const db = new DatabaseSync(h.layout.appDbFile)
    db.exec('DELETE FROM schedules; UPDATE accounts SET schedules_imported = 0')
    db.close()
    const runtime = h.runtime()
    runtime.identity.bind('5491100000009@s.whatsapp.net')
    runtime.close()
    writeFileSync(join(h.account.authDir, 'creds.json'), JSON.stringify({ me: { id: 'x' } }))
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    const finished = run(h, 'daemon')
    await waitFor(() => expect(h.out.join('\n')).toContain('Daemon running'))
    const started = h.logs
      .map((l) => JSON.parse(l) as { event: string; count?: number })
      .find((e) => e.event === 'daemon.started')
    expect(started?.count).toBe(1)
    h.shutdown()
    expect(await finished).toBe(0)
  })
})
