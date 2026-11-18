import { describe, expect, it } from 'vitest'
import { createLogger, errorCode, type LogFields } from '../../../src/main/logger.js'

function capture() {
  const out: string[] = []
  const err: string[] = []
  const logger = createLogger({ write: (t) => out.push(t) }, { write: (t) => err.push(t) }, () =>
    Date.parse('2026-11-17T12:00:00Z'),
  )
  return { out, err, logger }
}

describe('createLogger', () => {
  it('writes one JSON line per event, info to stdout and the rest to stderr', () => {
    const { out, err, logger } = capture()
    logger.info('daemon.started', { count: 2, nextRun: '2026-11-18T10:00:00.000Z' })
    logger.warn('delivery.stopped', { delivered: 1, failure: 'notConnected' })
    logger.error('account.mismatch', { reason: 'mismatch' })
    expect(out).toHaveLength(1)
    expect(err).toHaveLength(2)
    expect(out[0]?.endsWith('\n')).toBe(true)
    expect(JSON.parse(out[0] as string)).toEqual({
      time: '2026-11-17T12:00:00.000Z',
      level: 'info',
      event: 'daemon.started',
      count: 2,
      nextRun: '2026-11-18T10:00:00.000Z',
    })
    expect(JSON.parse(err[1] as string)).toMatchObject({
      level: 'error',
      event: 'account.mismatch',
      reason: 'mismatch',
    })
  })

  it('drops fields that are not in the fixed list, and values that are not simple', () => {
    const { out, logger } = capture()
    const sneaky = {
      count: 1,
      text: 'the secret message',
      name: 'Ana',
      phone: '+5491100000001',
      code: { nested: 'object' },
      reason: ['array'],
    } as unknown as LogFields
    logger.info('x', sneaky)
    expect(JSON.parse(out[0] as string)).toEqual({
      time: '2026-11-17T12:00:00.000Z',
      level: 'info',
      event: 'x',
      count: 1,
    })
    expect(out[0]).not.toContain('secret')
    expect(out[0]).not.toContain('Ana')
  })

  it('cuts long strings', () => {
    const { out, logger } = capture()
    logger.info('x', { reason: 'a'.repeat(1000) })
    expect((JSON.parse(out[0] as string) as { reason: string }).reason).toHaveLength(120)
  })
})

describe('errorCode', () => {
  it('uses the system code, or the class name, never the message', () => {
    expect(errorCode(Object.assign(new Error('no such file /home/x/secret'), { code: 'ENOENT' }))).toBe('ENOENT')
    expect(errorCode(new RangeError('Ana said hello'))).toBe('RangeError')
    expect(errorCode(Object.assign(new Error('x'), { code: 'not a code!' }))).toBe('Error')
    expect(errorCode('boom')).toBe('unknown')
    expect(errorCode(null)).toBe('unknown')
  })
})
