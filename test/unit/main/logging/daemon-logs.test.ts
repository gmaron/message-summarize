import { EventEmitter } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runMain } from '../../../../src/main/app.js'
import { startDaemonLogs } from '../../../../src/main/logging/daemon-logs.js'
import { createTappableLogger } from '../../../../src/main/logging/logger.js'
import { createShutdown, installProcessGuards } from '../../../../src/main/system/process-guard.js'
import { disposeHarnesses, type Harness, makeHarness, waitFor } from '../../../support/cli-harness.js'
import { isWindows } from '../../../support/platform.js'

afterEach(() => disposeHarnesses())

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const BASE = { language: 'en', schedules: [], provider: { primary: 'claude-cli' } }
const events = (h: Harness) => h.logs.map((l) => JSON.parse(l) as { event: string; [key: string]: unknown })
const token = (h: Harness) => readFileSync(h.layout.webTokenFile, 'utf8').trim()
const logsDir = (h: Harness) => join(h.layout.dataDir, 'logs')

async function startDaemon(h: Harness) {
  const finished = run(h, 'daemon')
  await waitFor(() => expect(h.out.join('\n')).toContain('Daemon running'))
  const port = events(h).find((e) => e.event === 'web.listening')?.port as number
  return { finished, port }
}
const apiLogs = async (h: Harness, port: number, query = '') =>
  (await (
    await fetch(`http://127.0.0.1:${port}/api/logs${query}`, { headers: { Authorization: `Bearer ${token(h)}` } })
  ).json()) as { items: { seq: number; event: string; level: string; account?: string; fields: object }[] }

describe('msum daemon: its log file and the web (RF-75, RNF-12)', () => {
  it('tees every logged line into logs/daemon.log without changing stdout and stderr, and serves it', async () => {
    const h = await makeHarness({ config: BASE })
    const { finished, port } = await startDaemon(h)
    const served = await apiLogs(h, port)
    expect(served.items.some((item) => item.event === 'web.listening')).toBe(true)
    h.shutdown()
    expect(await finished).toBe(0)

    // the same lines went to the sink the caller gave (stdout and stderr in production)
    expect(h.logs.length).toBeGreaterThan(0)
    const dir = logsDir(h)
    if (!isWindows) expect(statSync(dir).mode & 0o777).toBe(0o700)
    if (!isWindows) expect(statSync(join(dir, 'daemon.log')).mode & 0o777).toBe(0o600)
    const inFile = readFileSync(join(dir, 'daemon.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { event: string; level: string })
    const inSink = events(h)
    expect(inFile.map((e) => `${e.level}:${e.event}`)).toEqual(inSink.map((e) => `${e.level}:${e.event}`))
    // the web never reaches the file as a token
    expect(readFileSync(join(dir, 'daemon.log'), 'utf8')).not.toContain(token(h))
  })

  it('runs normally, and says so once, when logs/ is a link', async () => {
    const h = await makeHarness({ config: BASE })
    const target = join(h.layout.dataDir, 'elsewhere')
    mkdirSync(target)
    symlinkSync(target, logsDir(h))
    const { finished, port } = await startDaemon(h)
    expect(events(h).filter((e) => e.event === 'logs.fileDisabled')).toHaveLength(1)
    // the web still shows the lines of this run, from memory
    expect((await apiLogs(h, port)).items.some((item) => item.event === 'web.listening')).toBe(true)
    h.shutdown()
    expect(await finished).toBe(0)
    expect(readdirSync(target)).toEqual([])
  })

  it('the other commands do not create a log file', async () => {
    const h = await makeHarness({ config: BASE })
    await run(h, 'status')
    expect(existsSync(logsDir(h))).toBe(false)
  })

  it('a restarted daemon shows the lines of the one before, and logs.maxBytes decides when to rotate', async () => {
    const h = await makeHarness({ config: { ...BASE, logs: { maxBytes: 1_048_576 } } })
    const first = await startDaemon(h)
    h.shutdown()
    await first.finished
    const before = readFileSync(join(logsDir(h), 'daemon.log'), 'utf8')
    expect(before).toContain('web.listening')
    // make the current file bigger than half of the maximum: the next line rotates it
    writeFileSync(join(logsDir(h), 'daemon.log'), `${before}${'x'.repeat(600_000)}\n`, { mode: 0o600 })

    const second = await makeHarness({ config: { ...BASE, logs: { maxBytes: 1_048_576 } } })
    mkdirSync(logsDir(second), { recursive: true })
    writeFileSync(join(logsDir(second), 'daemon.log'), readFileSync(join(logsDir(h), 'daemon.log')), { mode: 0o600 })
    const { finished, port } = await startDaemon(second)
    const served = await apiLogs(second, port)
    // the line of the first daemon is there, then the new ones on top
    const listening = served.items.filter((item) => item.event === 'web.listening')
    expect(listening).toHaveLength(2)
    expect(listening[0]?.seq).toBeGreaterThan(listening[1]?.seq as number)
    second.shutdown()
    await finished
    expect(readdirSync(logsDir(second)).sort()).toEqual(['daemon.log', 'daemon.log.1'])
    expect(statSync(join(logsDir(second), 'daemon.log.1')).size).toBeGreaterThan(600_000)
    expect(statSync(join(logsDir(second), 'daemon.log')).size).toBeLessThan(524_288)
  })
})

describe('startDaemonLogs: logging never stops the daemon (RNF-12)', () => {
  const made: string[] = []
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'msum-dlogs-'))
    made.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of made.splice(0)) {
      try {
        chmodSync(join(dir, 'logs', 'daemon.log'), 0o600)
      } catch {}
      rmSync(dir, { recursive: true, force: true })
    }
  })
  const sinks = () => {
    const out: string[] = []
    const err: string[] = []
    return { out, err, base: createTappableLogger({ write: (t) => out.push(t) }, { write: (t) => err.push(t) }) }
  }

  // A mode 000 file is a POSIX-only way to make a file unreadable.
  it.skipIf(isWindows)(
    'starts, with an empty history, when daemon.log and daemon.log.1 cannot be read (mode 000)',
    async () => {
      if (process.getuid?.() === 0) return
      const dir = temp()
      mkdirSync(join(dir, 'logs'), { mode: 0o700 })
      for (const name of ['daemon.log', 'daemon.log.1']) {
        writeFileSync(join(dir, 'logs', name), '{"time":"2026-11-17T12:00:00.000Z","level":"info","event":"old"}\n')
        chmodSync(join(dir, 'logs', name), 0o000)
      }
      const { base } = sinks()
      const logs = await startDaemonLogs(base, { dataDir: dir }, 1_048_576)
      expect(logs.store.query({ limit: 10 })).toEqual([])
      expect(() => logs.logger.info('after')).not.toThrow()
      expect(logs.store.query({ limit: 10 }).map((e) => e.event)).toEqual(['after'])
      await logs.close()
      chmodSync(join(dir, 'logs', 'daemon.log.1'), 0o600)
    },
  )

  it('does not use a logs directory that is a link: one warning on stderr, nothing written or read behind it', async () => {
    const dir = temp()
    const target = join(dir, 'elsewhere')
    mkdirSync(target)
    writeFileSync(join(target, 'daemon.log'), '{"time":"2026-11-17T12:00:00.000Z","level":"info","event":"foreign"}\n')
    symlinkSync(target, join(dir, 'logs'))
    const { base, err } = sinks()
    const logs = await startDaemonLogs(base, { dataDir: dir }, 1_048_576)
    expect(err.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ level: 'warn', event: 'logs.fileDisabled', reason: 'unsafePath' }),
    ])
    logs.logger.info('x')
    await logs.close()
    expect(readdirSync(target)).toEqual(['daemon.log'])
    expect(readFileSync(join(target, 'daemon.log'), 'utf8')).not.toContain('"x"')
    expect(logs.store.query({ limit: 10 }).map((e) => e.event)).toEqual(['x'])
  })

  it('also takes the fatal errors of the process guards, and stops when closed', async () => {
    const dir = temp()
    const { base, err, out } = sinks()
    const proc = Object.assign(new EventEmitter(), { exit: () => undefined, exitCode: undefined as number | undefined })
    installProcessGuards({ proc, logger: base, shutdown: createShutdown(), forceExitMs: 10 })
    const logs = await startDaemonLogs(base, { dataDir: dir }, 1_048_576)
    expect(logs.logger).toBe(base)
    proc.emit('unhandledRejection', Object.assign(new Error('chat text SECRET'), { code: 'EFAIL' }))
    base.info('while.running')
    await logs.close()
    base.info('after.close')
    const file = readFileSync(join(dir, 'logs', 'daemon.log'), 'utf8')
    expect(file).toContain('process.unhandledRejection')
    expect(file).toContain('while.running')
    expect(file).not.toContain('after.close')
    expect(file).not.toContain('SECRET')
    expect(logs.store.query({ level: 'error', limit: 5 }).map((e) => e.event)).toEqual(['process.unhandledRejection'])
    // stdout and stderr got the same lines as always
    expect(err.join('')).toContain('process.unhandledRejection')
    expect(out.join('')).toContain('after.close')
  })
})
