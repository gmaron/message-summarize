import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOG_FILE_NAME, LOG_ROTATED_NAME } from '../../../../src/main/logging/log-file.js'
import { LogStore } from '../../../../src/main/logging/log-store.js'
import {
  buildLogRecord,
  createLogger,
  type LogFields,
  parseLogLine,
  teeLogger,
} from '../../../../src/main/logging/logger.js'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'msum-store-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const T0 = Date.parse('2026-11-17T12:00:00Z')
const rec = (n: number, level: 'info' | 'warn' | 'error' = 'info', fields: LogFields = {}) =>
  buildLogRecord(level, `event.${n}`, fields, T0 + n * 1000)
const text = (...records: object[]) => records.map((r) => `${JSON.stringify(r)}\n`).join('')

describe('LogStore queries (RF-75)', () => {
  const filled = () => {
    const store = new LogStore()
    store.add(rec(1, 'info', { account: 'alpha' }))
    store.add(rec(2, 'warn', { account: 'beta', code: 'X' }))
    store.add(rec(3, 'error'))
    store.add(rec(4, 'info'))
    store.add(rec(5, 'warn', { account: 'alpha', count: 2 }))
    return store
  }

  it('answers newest first with seq, time, level, event, account and the other fields', () => {
    const items = filled().query({ limit: 10 })
    expect(items.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1])
    expect(items[0]).toEqual({
      seq: 5,
      time: '2026-11-17T12:00:05.000Z',
      level: 'warn',
      event: 'event.5',
      account: 'alpha',
      fields: { count: 2 },
    })
    expect('account' in (items[1] as object)).toBe(false)
  })

  it('filters by the minimum level', () => {
    const store = filled()
    expect(store.query({ level: 'warn', limit: 10 }).map((e) => e.seq)).toEqual([5, 3, 2])
    expect(store.query({ level: 'error', limit: 10 }).map((e) => e.seq)).toEqual([3])
  })

  it('filters by account, and null asks for the lines that have none', () => {
    const store = filled()
    expect(store.query({ account: 'alpha', limit: 10 }).map((e) => e.seq)).toEqual([5, 1])
    expect(store.query({ account: null, limit: 10 }).map((e) => e.seq)).toEqual([4, 3])
    expect(store.query({ account: 'nobody', limit: 10 })).toEqual([])
  })

  it('pages with limit and the before cursor', () => {
    const store = filled()
    const first = store.query({ limit: 2 })
    expect(first.map((e) => e.seq)).toEqual([5, 4])
    const second = store.query({ limit: 2, before: (first.at(-1) as { seq: number }).seq })
    expect(second.map((e) => e.seq)).toEqual([3, 2])
    expect(store.query({ limit: 2, before: 1 })).toEqual([])
  })

  it('keeps the last lines only, and tells the listeners the seq of each new one', () => {
    const store = new LogStore(3)
    const told: number[] = []
    const stop = store.subscribe((seq) => told.push(seq))
    for (let n = 1; n <= 5; n++) store.add(rec(n))
    expect(store.query({ limit: 10 }).map((e) => e.seq)).toEqual([5, 4, 3])
    expect(told).toEqual([1, 2, 3, 4, 5])
    stop()
    store.add(rec(6))
    expect(told).toHaveLength(5)
  })
})

describe('LogStore seeding from the files', () => {
  it('reads the rotated file first and then the current one, skipping a half-written last line', async () => {
    const dir = temp()
    writeFileSync(join(dir, LOG_ROTATED_NAME), text(rec(1), rec(2)))
    writeFileSync(
      join(dir, LOG_FILE_NAME),
      `${text(rec(3), rec(4, 'error', { account: 'alpha' }))}{"time":"2026-11-17T12:`,
    )
    const store = new LogStore()
    await store.seed(dir)
    expect(store.query({ limit: 10 }).map((e) => e.event)).toEqual(['event.4', 'event.3', 'event.2', 'event.1'])
    expect(store.query({ limit: 10 })[0]?.account).toBe('alpha')
    // lines added after the seed continue the numbering
    store.add(rec(5))
    expect(store.query({ limit: 1 })[0]?.seq).toBe(5)
  })

  it('skips lines that do not parse, and keeps only allowed fields of the ones that do', async () => {
    const dir = temp()
    writeFileSync(
      join(dir, LOG_FILE_NAME),
      [
        'not json at all',
        JSON.stringify({ time: 'yesterday', level: 'info', event: 'bad.time' }),
        JSON.stringify({ time: '2026-11-17T12:00:00.000Z', level: 'loud', event: 'bad.level' }),
        JSON.stringify([1, 2]),
        '',
        JSON.stringify({
          time: '2026-11-17T12:00:01.000Z',
          level: 'info',
          event: 'good',
          count: 3,
          text: 'PRIVATE MESSAGE',
          phone: '+9911963367943',
          nested: { a: 1 },
        }),
      ].join('\n'),
    )
    const store = new LogStore()
    await store.seed(dir)
    const items = store.query({ limit: 10 })
    expect(items).toHaveLength(1)
    expect(items[0]?.fields).toEqual({ count: 3 })
    expect(JSON.stringify(items)).not.toContain('PRIVATE')
    expect(JSON.stringify(items)).not.toContain('9911963367943')
  })

  it('reads only the tail of a file bigger than the bound, dropping the line it started inside', async () => {
    const dir = temp()
    const old = text(rec(1)).repeat(30_000) // ~ 3 MB of lines
    writeFileSync(join(dir, LOG_FILE_NAME), `${old}${text(rec(2, 'warn'))}`)
    const store = new LogStore(10)
    await store.seed(dir)
    const items = store.query({ limit: 10 })
    expect(items).toHaveLength(10)
    expect(items[0]?.event).toBe('event.2')
    expect(items.every((e) => e.event.startsWith('event.'))).toBe(true)
  })

  it('is just empty when there are no files', async () => {
    const store = new LogStore()
    await store.seed(join(temp(), 'missing'))
    expect(store.query({ limit: 10 })).toEqual([])
  })
})

describe('teeLogger and parseLogLine', () => {
  it('leaves the base output alone and hands the tap the same allowlisted line', () => {
    const out: string[] = []
    const err: string[] = []
    const base = createLogger({ write: (t) => out.push(t) }, { write: (t) => err.push(t) }, () => T0)
    const tapped: object[] = []
    const logger = teeLogger(
      base,
      (line) => tapped.push(line),
      () => T0,
    )
    const sneaky = { account: 'alpha', text: 'SECRET MESSAGE', count: 1 } as unknown as LogFields
    logger.info('x.y', sneaky)
    logger.error('z', { code: 'E' })
    expect(out).toHaveLength(1)
    expect(err).toHaveLength(1)
    expect(tapped[0]).toEqual(JSON.parse(out[0] as string))
    expect(tapped[1]).toEqual(JSON.parse(err[0] as string))
    expect(JSON.stringify(tapped)).not.toContain('SECRET')
  })

  it('does not let a tap that throws reach the caller', () => {
    const base = createLogger({ write: () => undefined }, { write: () => undefined })
    const logger = teeLogger(base, () => {
      throw new Error('disk')
    })
    expect(() => logger.warn('x')).not.toThrow()
  })

  it('parses its own lines and refuses anything else', () => {
    const line = JSON.stringify(rec(1, 'warn', { account: 'alpha' }))
    expect(parseLogLine(line)).toEqual(JSON.parse(line))
    expect(parseLogLine('{"time":"2026-11-17T12:00:00.000Z","level":"info"}')).toBeNull()
    expect(parseLogLine('')).toBeNull()
  })
})
