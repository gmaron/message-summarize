import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSchedule, scheduleToCron } from '../../../src/domain/schedule.js'
import { CronerScheduler, nextRunOf } from '../../../src/infrastructure/scheduling/croner-scheduler.js'
import { openInstallation } from '../../../src/main/accounts.js'
import { runMain } from '../../../src/main/app.js'
import { Daemon } from '../../../src/main/daemon.js'
import { acquireDaemonLock } from '../../../src/main/daemon-lock.js'
import {
  BA,
  disposeHarnesses,
  FakeSummarizer,
  type Harness,
  makeHarness,
  seedMessages,
} from '../../support/cli-harness.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  disposeHarnesses()
})

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const text = (lines: string[]) => lines.join('\n')
const BASE = { language: 'en', timezone: BA, provider: { primary: 'claude-cli' } }

/** Reads the schedules of an account straight from app.db, as another process would. */
async function stored(h: Harness, account = 'default') {
  const opened = await openInstallation({ layout: h.layout, clock: h.clock })
  if (!opened.ok) throw new Error('refused')
  try {
    return opened.installation.schedules.list(account)
  } finally {
    opened.installation.close()
  }
}

describe('msum schedule add / ls / rm (RF-60)', () => {
  it('adds a daily schedule by default and lists it with the next run in the account time zone', async () => {
    // 2026-11-17 12:00 in Buenos Aires: the next 09:00 is tomorrow
    const h = await makeHarness({ config: BASE })
    expect(await run(h, 'schedule', 'add', '--time', '09:00')).toBe(0)
    expect(text(h.out)).toContain('every day at 09:00')
    expect(text(h.out)).toContain('18 Nov 2026')
    h.out.length = 0
    expect(await run(h, 'schedule', 'ls')).toBe(0)
    expect(text(h.out)).toMatch(/^#1 {2}every day at 09:00 {2}next: 18 Nov 2026, 09:00$/m)
    expect((await stored(h)).map((s) => scheduleToCron(s.schedule))).toEqual(['0 9 * * *'])
  })

  it('takes days as groups, lists and ranges, in English and Spanish', async () => {
    const h = await makeHarness({ config: BASE })
    expect(await run(h, 'schedule', 'add', '--time', '19:30', '--days', 'mon-fri')).toBe(0)
    expect(await run(h, 'schedule', 'add', '--time', '10:00', '--days', 'weekends')).toBe(0)
    expect(await run(h, 'schedule', 'add', '--time', '08:15', '--days', 'lun,mié')).toBe(0)
    expect((await stored(h)).map((s) => scheduleToCron(s.schedule))).toEqual([
      '30 19 * * 1,2,3,4,5',
      '0 10 * * 0,6',
      '15 8 * * 1,3',
    ])
    h.out.length = 0
    await run(h, 'schedule', 'ls')
    expect(text(h.out)).toContain('weekdays at 19:30')
    expect(text(h.out)).toContain('weekends at 10:00')
    expect(text(h.out)).toContain('Mon, Wed at 08:15')
  })

  it('speaks the language of the configuration', async () => {
    const h = await makeHarness({ config: { ...BASE, language: 'es' } })
    await run(h, 'schedule', 'add', '--time', '09:00', '--days', 'mon,wed')
    expect(text(h.out)).toContain('Horario #1 agregado: lun, mié a las 09:00')
    h.out.length = 0
    await run(h, 'schedule', 'ls')
    expect(text(h.out)).toMatch(/^#1 {2}lun, mié a las 09:00 {2}próxima: /m)
    const empty = await makeHarness({ config: { ...BASE, language: 'es' } })
    await run(empty, 'schedule')
    expect(text(empty.out)).toContain('No hay horarios')
  })

  it('says so when there are none', async () => {
    const h = await makeHarness({ config: BASE })
    expect(await run(h, 'schedule')).toBe(0)
    expect(text(h.out)).toContain('There are no schedules')
  })

  it('rejects a bad time or bad days with exit 2 and adds nothing', async () => {
    const h = await makeHarness({ config: BASE })
    expect(await run(h, 'schedule', 'add', '--time', '25:00')).toBe(2)
    expect(text(h.err)).toContain('HH:MM')
    h.err.length = 0
    expect(await run(h, 'schedule', 'add', '--time', '09:00', '--days', 'funday')).toBe(2)
    expect(text(h.err)).toContain('not valid')
    h.err.length = 0
    expect(await run(h, 'schedule', 'add')).toBe(2)
    expect(await stored(h)).toEqual([])
  })

  it('removes a schedule by id, and says so when the account has no such schedule', async () => {
    const h = await makeHarness({ config: BASE })
    await run(h, 'schedule', 'add', '--time', '09:00')
    await run(h, 'schedule', 'add', '--time', '18:00')
    h.out.length = 0
    expect(await run(h, 'schedule', 'rm', '1')).toBe(0)
    expect(text(h.out)).toContain('Schedule #1 removed')
    expect((await stored(h)).map((s) => s.id)).toEqual([2])
    expect(await run(h, 'schedule', 'rm', '1')).toBe(1)
    expect(text(h.err)).toContain('no schedule #1')
  })

  it("rm only removes a schedule of the chosen account, never another account's", async () => {
    const h = await makeHarness({ config: BASE, accounts: ['alpha', 'beta'] })
    await run(h, 'schedule', 'add', '--time', '09:00', '--account', 'alpha')
    await run(h, 'schedule', 'add', '--time', '10:00', '--account', 'beta')
    const betaId = (await stored(h, 'beta'))[0]?.id as number
    expect(await run(h, 'schedule', 'rm', String(betaId), '--account', 'alpha')).toBe(1)
    expect((await stored(h, 'beta')).map((s) => s.id)).toEqual([betaId])
    expect(await run(h, 'schedule', 'rm', String(betaId), '--account', 'beta')).toBe(0)
    expect(await stored(h, 'beta')).toEqual([])
    expect(await stored(h, 'alpha')).toHaveLength(1)
  })

  it('asks for --account when there are several', async () => {
    const h = await makeHarness({ config: BASE, accounts: ['alpha', 'beta'] })
    expect(await run(h, 'schedule', 'add', '--time', '09:00')).toBe(2)
    expect(text(h.err)).toContain('--account <id>')
  })

  it('works while a daemon runs: it does not take the lock', async () => {
    const h = await makeHarness({ config: BASE })
    await acquireDaemonLock(h.layout.lockFile, process.ppid)
    expect(await run(h, 'schedule', 'add', '--time', '09:00')).toBe(0)
    expect(await run(h, 'schedule', 'ls')).toBe(0)
    expect(await run(h, 'schedule', 'rm', '1')).toBe(0)
    expect(readFileSync(h.layout.lockFile, 'utf8')).toContain(String(process.ppid))
  })
})

describe('importing the schedules of the configuration (once per account)', () => {
  const CONFIG = {
    ...BASE,
    schedules: ['0 7 * * *', '30 19 * * 1-5', '*/5 * * * *', '30 8 1 * *', '0 7 * * *'],
  }

  it('imports what a schedule can say, once, and does not import the rest', async () => {
    const h = await makeHarness({ config: CONFIG })
    expect(await run(h, 'schedule', 'ls')).toBe(0)
    expect(text(h.out)).toMatch(/^#1 {2}every day at 07:00/m)
    expect(text(h.out)).toMatch(/^#2 {2}weekdays at 19:30/m)
    expect(h.out).toHaveLength(2) // the repeated one is imported once; the other two are not representable
  })

  it('never brings back a schedule the user deleted, and never rewrites config.json', async () => {
    const h = await makeHarness({ config: CONFIG })
    const before = readFileSync(h.layout.configFile, 'utf8')
    await run(h, 'schedule', 'ls')
    expect(await run(h, 'schedule', 'rm', '1')).toBe(0)
    expect(await run(h, 'schedule', 'rm', '2')).toBe(0)
    h.out.length = 0
    await run(h, 'schedule', 'ls')
    await run(h, 'status')
    expect(text(h.out)).toContain('There are no schedules')
    expect(await stored(h)).toEqual([])
    expect(readFileSync(h.layout.configFile, 'utf8')).toBe(before)
  })

  it('imports each account with its own effective configuration', async () => {
    const h = await makeHarness({ config: { ...BASE, schedules: ['0 7 * * *'] }, accounts: ['alpha', 'beta'] })
    writeFileSync(join(h.accountOf('beta').dir, 'config.json'), JSON.stringify({ schedules: ['0 21 * * 6,0'] }))
    await run(h, 'schedule', 'ls', '--account', 'alpha')
    await run(h, 'schedule', 'ls', '--account', 'beta')
    expect((await stored(h, 'alpha')).map((s) => scheduleToCron(s.schedule))).toEqual(['0 7 * * *'])
    expect((await stored(h, 'beta')).map((s) => scheduleToCron(s.schedule))).toEqual(['0 21 * * 0,6'])
  })

  it('does not import again when the configuration changes later', async () => {
    const h = await makeHarness({ config: { ...BASE, schedules: [] } })
    await run(h, 'schedule', 'ls')
    writeFileSync(h.layout.configFile, JSON.stringify({ ...BASE, schedules: ['0 7 * * *'] }))
    h.out.length = 0
    await run(h, 'schedule', 'ls')
    expect(text(h.out)).toContain('There are no schedules')
  })

  it('shows the imported schedules in status', async () => {
    const h = await makeHarness({ config: CONFIG })
    expect(await run(h, 'status')).toBe(0)
    expect(text(h.out)).toMatch(/^Schedule: +#1 every day at 07:00 +next: /m)
    expect(text(h.out)).toMatch(/^Schedule: +#2 weekdays at 19:30 +next: /m)
  })

  it('doctor reports the crons that were not imported, and warns that the key no longer applies', async () => {
    const h = await makeHarness({ config: CONFIG })
    await run(h, 'doctor')
    const output = text(h.out)
    // once imported, what could not be imported is a warning, not a failure
    expect(output).not.toContain('[fail] Schedules')
    expect(output).toContain('[warn] Schedules: these "schedules" of the configuration cannot be turned')
    expect(output).toContain('*/5 * * * *')
    expect(output).toContain('30 8 1 * *')
    expect(output).toContain('msum schedule add')
    expect(output).toContain('delete the "schedules" key from config.json')
    expect(output).toContain('[warn] Schedules: the "schedules" option of the configuration no longer applies')
    expect(output).toContain('msum schedule ls')
  })

  it('doctor is happy with imported schedules, and warns only while the key is in the configuration', async () => {
    const h = await makeHarness({ config: { ...BASE, schedules: ['0 7 * * *'] } })
    await run(h, 'doctor')
    expect(text(h.out)).toContain('[ok]   Schedules: 1 configured')
    expect(text(h.out)).toContain('[warn] Schedules')
    const clean = await makeHarness({ config: BASE })
    await run(clean, 'doctor')
    // no schedules at all is a warning that says how to add one, not a failure
    expect(text(clean.out)).toContain('[warn] Schedules: no schedules')
    expect(text(clean.out)).toContain('msum schedule add --time HH:MM')
    expect(text(clean.out)).not.toContain('[fail] Schedules')
  })

  it('doctor flags schedules with no provider to run them as a problem', async () => {
    const h = await makeHarness({ config: { language: 'en', timezone: BA, schedules: ['0 7 * * *'] } })
    expect(await run(h, 'doctor')).toBe(1)
    expect(text(h.out)).toContain('[fail] Schedules: there are schedules but no LLM provider to run them')
    h.out.length = 0
    await run(h, 'status')
    expect(text(h.out)).toMatch(/^Problem: +there are schedules but no LLM provider to run them$/m)
    const withProvider = await makeHarness({ config: { ...BASE, schedules: ['0 7 * * *'] } })
    await run(withProvider, 'status')
    expect(text(withProvider.out)).not.toContain('Problem:')
  })

  it('a link that succeeds suggests adding a schedule when the account has none', async () => {
    const h = await makeHarness({ config: BASE, accounts: [] })
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    expect(await run(h, 'link')).toBe(0)
    expect(text(h.out)).toContain('msum schedule add --time HH:MM')
    const withSchedule = await makeHarness({ config: { ...BASE, schedules: ['0 7 * * *'] }, accounts: [] })
    withSchedule.connection.onStart = () => withSchedule.connection.emit({ state: 'connected' })
    expect(await run(withSchedule, 'link')).toBe(0)
    expect(text(withSchedule.out)).not.toContain('msum schedule add')
  })

  it('doctor warns in Spanish too, and a warning does not fail the diagnosis', async () => {
    const h = await makeHarness({
      config: { ...BASE, language: 'es', schedules: ['0 7 * * *'] },
      probes: { commandVersion: async () => '1.0 (fake)' },
    })
    const runtime = h.runtime()
    runtime.identity.bind('5491100000009@s.whatsapp.net')
    runtime.close()
    writeFileSync(join(h.account.authDir, 'creds.json'), JSON.stringify({ me: { id: 'x' } }))
    expect(await run(h, 'doctor')).toBe(0)
    expect(text(h.out)).toContain('[aviso] Horarios: la opción "schedules"')
  })
})

describe('schedules of an account in the database', () => {
  it('are deleted with the account, and only with it', async () => {
    const h = await makeHarness({ config: BASE, accounts: ['alpha', 'beta'] })
    await run(h, 'schedule', 'add', '--time', '09:00', '--account', 'alpha')
    await run(h, 'schedule', 'add', '--time', '10:00', '--account', 'beta')
    expect(await run(h, 'unlink', '--account', 'alpha', '--yes')).toBe(0)
    const db = new DatabaseSync(h.layout.appDbFile)
    try {
      const rows = db.prepare('SELECT account_id AS account FROM schedules ORDER BY id').all() as { account: string }[]
      expect(rows).toEqual([{ account: 'beta' }])
    } finally {
      db.close()
    }
  })

  it('cannot be added for an account that does not exist (foreign key)', async () => {
    const h = await makeHarness({ config: BASE })
    const opened = await openInstallation({ layout: h.layout, clock: h.clock })
    if (!opened.ok) throw new Error('refused')
    try {
      const made = makeSchedule([1], '09:00')
      if (!made.ok) throw new Error('invalid')
      expect(() => opened.installation.schedules.add('ghost', made.value)).toThrow()
    } finally {
      opened.installation.close()
    }
  })

  it('updates a schedule of its own account only', async () => {
    const h = await makeHarness({ config: BASE, accounts: ['alpha', 'beta'] })
    const opened = await openInstallation({ layout: h.layout, clock: h.clock })
    if (!opened.ok) throw new Error('refused')
    try {
      const first = makeSchedule([1], '09:00')
      const second = makeSchedule([0, 6], '21:30')
      if (!first.ok || !second.ok) throw new Error('invalid')
      const { schedules } = opened.installation
      const id = schedules.add('alpha', first.value)
      const other = schedules.add('beta', first.value)
      expect(schedules.update('alpha', id, second.value)).toBe(true)
      expect(schedules.list('alpha')).toEqual([{ id, schedule: second.value }])
      // another account's schedule, or one that does not exist, is not touched
      expect(schedules.update('alpha', other, second.value)).toBe(false)
      expect(schedules.update('alpha', 999, second.value)).toBe(false)
      expect(schedules.list('beta')).toEqual([{ id: other, schedule: first.value }])
    } finally {
      opened.installation.close()
    }
  })

  it('ignores a row that does not hold a valid schedule', async () => {
    const h = await makeHarness({ config: BASE })
    await run(h, 'schedule', 'add', '--time', '09:00')
    const db = new DatabaseSync(h.layout.appDbFile)
    db.exec(
      "INSERT INTO schedules (account_id, days, time, created_at) VALUES ('default', '9', '09:00', 'x'), ('default', '', '09:00', 'x'), ('default', '1', 'noon', 'x')",
    )
    db.close()
    expect((await stored(h)).map((s) => s.id)).toEqual([1])
    expect(await run(h, 'schedule', 'ls')).toBe(0)
  })
})

describe('time zone and daylight saving (RF-62)', () => {
  const NY = 'America/New_York'
  const next = (cron: string, from: string, count = 2): string[] => {
    const found: string[] = []
    let at = new Date(from)
    for (let i = 0; i < count; i++) {
      const run = nextRunOf(cron, NY, at)
      if (run === null) break
      found.push(run.toISOString())
      at = run
    }
    return found
  }

  it('a 07:00 schedule stays at 07:00 local across the spring change (UTC-5 to UTC-4)', () => {
    const daily = scheduleToCron(makeOrThrow([0, 1, 2, 3, 4, 5, 6], '07:00'))
    expect(next(daily, '2026-03-06T13:00:00Z', 3)).toEqual([
      '2026-03-07T12:00:00.000Z', // 07:00 EST
      '2026-03-08T11:00:00.000Z', // 07:00 EDT, the day of the change
      '2026-03-09T11:00:00.000Z',
    ])
  })

  it('a 07:00 schedule stays at 07:00 local across the autumn change (UTC-4 to UTC-5)', () => {
    const daily = scheduleToCron(makeOrThrow([0, 1, 2, 3, 4, 5, 6], '07:00'))
    expect(next(daily, '2026-10-30T13:00:00Z', 3)).toEqual([
      '2026-10-31T11:00:00.000Z', // 07:00 EDT
      '2026-11-01T12:00:00.000Z', // 07:00 EST
      '2026-11-02T12:00:00.000Z',
    ])
  })

  it('a time that does not exist that day runs at the first valid time after it, once', () => {
    // 02:30 on 2026-03-08 does not exist in New York (the clock jumps from 02:00 to 03:00)
    const cron = scheduleToCron(makeOrThrow([0, 1, 2, 3, 4, 5, 6], '02:30'))
    expect(next(cron, '2026-03-07T12:00:00Z', 3)).toEqual([
      '2026-03-08T07:00:00.000Z', // 03:00 EDT, the first valid time after the gap
      '2026-03-09T06:30:00.000Z', // 02:30 EDT again
      '2026-03-10T06:30:00.000Z',
    ])
  })

  it('a time that happens twice that day runs once, at the first one', () => {
    // 01:30 on 2026-11-01 happens twice (EDT then EST)
    const cron = scheduleToCron(makeOrThrow([0, 1, 2, 3, 4, 5, 6], '01:30'))
    expect(next(cron, '2026-11-01T00:00:00Z', 2)).toEqual([
      '2026-11-01T05:30:00.000Z', // 01:30 EDT
      '2026-11-02T06:30:00.000Z', // the next day: 01:30 EST, the repeated one did not run
    ])
  })

  it('fires the jobs of the scheduler across the spring change: once on the day, at 03:00 local', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(Date.parse('2026-03-08T05:00:00Z'))
    const fired: string[] = []
    const scheduler = new CronerScheduler({
      timezone: NY,
      schedules: [scheduleToCron(makeOrThrow([0, 1, 2, 3, 4, 5, 6], '02:30'))],
      onTick: () => fired.push(new Date().toISOString()),
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(3 * 3_600_000)
    scheduler.stop()
    expect(fired).toEqual(['2026-03-08T07:00:00.000Z'])
  })

  it('uses the account time zone: the same schedule is a different instant in another zone', () => {
    const cron = scheduleToCron(makeOrThrow([1, 2, 3, 4, 5], '09:00'))
    const from = new Date('2026-11-17T00:00:00Z')
    expect(nextRunOf(cron, 'America/Argentina/Buenos_Aires', from)?.toISOString()).toBe('2026-11-17T12:00:00.000Z')
    expect(nextRunOf(cron, 'Europe/Madrid', from)?.toISOString()).toBe('2026-11-17T08:00:00.000Z')
  })

  it('does not run on days that are not in the schedule', () => {
    const cron = scheduleToCron(makeOrThrow([1, 2, 3, 4, 5], '09:00'))
    // Friday 2026-11-20 evening: the next one is Monday
    expect(nextRunOf(cron, 'UTC', new Date('2026-11-20T10:00:00Z'))?.toISOString()).toBe('2026-11-23T09:00:00.000Z')
  })
})

function makeOrThrow(days: number[], time: string) {
  const made = makeSchedule(days, time)
  if (!made.ok) throw new Error('invalid schedule')
  return made.value
}

describe('Daemon: schedules applied without a restart (RF-61)', () => {
  interface Running {
    readonly harness: Harness
    readonly daemon: Daemon
    readonly runtime: ReturnType<Harness['runtime']>
    readonly close: () => void
  }
  let current: Running | null = null

  /** A daemon whose schedules come from app.db through its own connection; the CLI writes through another. */
  async function start(now = '2026-11-17T09:00:00Z', summarizer = new FakeSummarizer()): Promise<Running> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(Date.parse(now))
    const harness = await makeHarness({ config: BASE, summarizer, liveClock: true })
    const opened = await openInstallation({ layout: harness.layout, clock: harness.clock })
    if (!opened.ok) throw new Error('refused')
    const { installation } = opened
    const runtime = harness.runtime()
    runtime.identity.bind('5491100000009@s.whatsapp.net')
    const daemon = new Daemon({
      runtime,
      connection: harness.connection,
      logger: harness.ctx.logger,
      scheduleReloadMs: 30_000,
      scheduleSource: () => [...new Set(installation.schedules.list('default').map((s) => scheduleToCron(s.schedule)))],
    })
    await daemon.start()
    current = {
      harness,
      daemon,
      runtime,
      close: () => {
        runtime.close()
        installation.close()
      },
    }
    return current
  }

  afterEach(async () => {
    if (current !== null) {
      await current.daemon.stop()
      current.close()
      current = null
    }
  })

  const events = (h: Harness) => h.logs.map((line) => JSON.parse(line) as { event: string; [key: string]: unknown })
  const named = (h: Harness, event: string) => events(h).filter((e) => e.event === event)

  it('a schedule added while it runs fires, and one removed stops firing, with no restart', async () => {
    const { harness } = await start()
    expect(named(harness, 'account.started')[0]).toMatchObject({ count: 0 })
    // 07:00 in Buenos Aires is 10:00Z; it is 09:00Z now
    expect(await run(harness, 'schedule', 'add', '--time', '07:00')).toBe(0)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(named(harness, 'schedules.reloaded')).toEqual([expect.objectContaining({ count: 1 })])
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(1)
    expect(named(harness, 'schedule.fired')[0]).toMatchObject({ schedule: '0 7 * * *' })

    expect(await run(harness, 'schedule', 'rm', '1')).toBe(0)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(named(harness, 'schedules.reloaded')).toHaveLength(2)
    expect(named(harness, 'schedules.reloaded')[1]).toMatchObject({ count: 0 })
    await vi.advanceTimersByTimeAsync(25 * 60 * 60_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(1)
  })

  it('does nothing while the schedules do not change: no reload, and a job in flight is not rebuilt', async () => {
    const { harness } = await start()
    await run(harness, 'schedule', 'add', '--time', '07:00')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(named(harness, 'schedules.reloaded')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(named(harness, 'schedules.reloaded')).toHaveLength(1)
  })

  it('an edit as a remove plus an add changes the jobs to the new time', async () => {
    const { harness } = await start()
    await run(harness, 'schedule', 'add', '--time', '07:00')
    await vi.advanceTimersByTimeAsync(31_000)
    await run(harness, 'schedule', 'rm', '1')
    await run(harness, 'schedule', 'add', '--time', '08:00')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(named(harness, 'schedules.reloaded')).toHaveLength(2)
    // 07:00 local (10:00Z) passes with nothing; 08:00 local (11:00Z) fires
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(1)
    expect(named(harness, 'schedule.fired')[0]).toMatchObject({ schedule: '0 8 * * *' })
  })

  it('a schedule of another account does not reach this daemon', async () => {
    const { harness } = await start()
    // a second account in the same installation
    const opened = await openInstallation({ layout: harness.layout, clock: harness.clock })
    if (!opened.ok) throw new Error('refused')
    await opened.installation.createAccount('other')
    const made = makeSchedule([0, 1, 2, 3, 4, 5, 6], '07:00')
    if (!made.ok) throw new Error('invalid')
    opened.installation.schedules.add('other', made.value)
    opened.installation.close()
    await vi.advanceTimersByTimeAsync(31_000)
    expect(named(harness, 'schedules.reloaded')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(0)
  })

  it('the missed-run catch-up (RF-65) looks at the schedules as they are now', async () => {
    const { harness, runtime } = await start()
    // the last digest was three days ago; a schedule added now whose last time passed makes ONE run missed
    await runtime.store.commit({
      previousPointer: null,
      pointer: Date.parse('2026-11-14T00:00:00Z'),
      digest: null,
      parts: [],
    })
    await run(harness, 'schedule', 'add', '--time', '05:00')
    await run(harness, 'schedule', 'add', '--time', '04:00')
    await vi.advanceTimersByTimeAsync(31_000)
    harness.connection.emit({ state: 'connected' })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(named(harness, 'digest.missed')).toHaveLength(1)
    expect(named(harness, 'digest.started').filter((e) => e.trigger === 'missed')).toHaveLength(1)
  })

  it('two ticks at once still run one digest (RF-66): duplicated times are one job', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const summarizer = new FakeSummarizer(async () => {
      await gate
      return {
        ok: true as const,
        value: { resumen: 'x', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
      }
    })
    const { harness, runtime } = await start('2026-11-17T09:58:00Z', summarizer)
    await seedMessages(runtime, [{ id: 'm1', text: 'hello', timestamp: Date.now() - 3_600_000 }])
    await run(harness, 'schedule', 'add', '--time', '07:00')
    await run(harness, 'schedule', 'add', '--time', '07:00')
    harness.connection.emit({ state: 'connected' })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(named(harness, 'schedules.reloaded')[0]).toMatchObject({ count: 1 })
    await vi.advanceTimersByTimeAsync(130_000)
    expect(named(harness, 'schedule.fired')).toHaveLength(1)
    expect(named(harness, 'digest.started')).toHaveLength(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
  })
})
