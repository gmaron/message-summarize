import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '../../../../src/main/logging/logger.js'
import { createShutdown, installProcessGuards, type ProcessLike } from '../../../../src/main/system/process-guard.js'

function setup(awaited: boolean) {
  const logs: string[] = []
  const sink = { write: (text: string) => logs.push(text) }
  const emitter = new EventEmitter()
  const exits: (number | undefined)[] = []
  const proc = Object.assign(emitter, {
    exitCode: undefined as number | string | null | undefined,
    exit: (code?: number) => {
      exits.push(code)
    },
  }) as unknown as ProcessLike & EventEmitter
  const shutdown = createShutdown()
  let requested = false
  const guarded = {
    ...shutdown,
    request: () => {
      requested = true
      shutdown.request()
    },
    isAwaited: () => awaited,
  }
  installProcessGuards({ proc, logger: createLogger(sink, sink, () => 0), shutdown: guarded, forceExitMs: 50 })
  return { proc, logs, exits, wasRequested: () => requested, shutdown }
}

describe('process guards', () => {
  it('an uncaught exception is logged by its code only, starts a graceful stop and sets exit code 1', () => {
    const s = setup(true)
    s.proc.emit('uncaughtException', Object.assign(new Error('chat text: SECRET-MESSAGE'), { code: 'ERR_BOOM' }))
    expect(s.logs).toHaveLength(1)
    expect(JSON.parse(s.logs[0] as string)).toMatchObject({
      level: 'error',
      event: 'process.uncaughtException',
      code: 'ERR_BOOM',
    })
    expect(s.logs.join('')).not.toContain('SECRET')
    expect(s.wasRequested()).toBe(true)
    expect(s.proc.exitCode).toBe(1)
    expect(s.exits).toEqual([])
  })

  it('an unhandled rejection of anything is logged by its code only', () => {
    const s = setup(true)
    s.proc.emit('unhandledRejection', 'a string with SECRET-DATA')
    s.proc.emit('unhandledRejection', new RangeError('SECRET-RANGE'))
    expect(s.logs.join('')).not.toContain('SECRET')
    expect(JSON.parse(s.logs[0] as string)).toMatchObject({ event: 'process.unhandledRejection', code: 'unknown' })
    expect(JSON.parse(s.logs[1] as string)).toMatchObject({ code: 'RangeError' })
    expect(s.proc.exitCode).toBe(1)
  })

  it('leaves anyway when the graceful stop does not finish in time', async () => {
    const s = setup(true)
    s.proc.emit('uncaughtException', new Error('x'))
    expect(s.exits).toEqual([])
    await vi.waitFor(() => expect(s.exits).toEqual([1]))
  })

  it('exits at once on a fatal error when nobody waits for a graceful stop', () => {
    const s = setup(false)
    s.proc.emit('uncaughtException', new Error('x'))
    expect(s.exits).toEqual([1])
  })

  it('a signal asks the waiting command to stop; a second one, or no waiting command, exits', () => {
    const waiting = setup(true)
    waiting.proc.emit('SIGTERM')
    expect(waiting.wasRequested()).toBe(true)
    expect(waiting.exits).toEqual([])
    waiting.proc.emit('SIGINT')
    expect(waiting.exits).toEqual([130])

    const short = setup(false)
    short.proc.emit('SIGINT')
    expect(short.wasRequested()).toBe(false)
    expect(short.exits).toEqual([130])
    short.proc.emit('SIGTERM')
    expect(short.exits).toEqual([130, 143])
  })

  it('the shutdown knows whether somebody waits for it', async () => {
    const shutdown = createShutdown()
    expect(shutdown.isAwaited()).toBe(false)
    const waited = shutdown.wait()
    expect(shutdown.isAwaited()).toBe(true)
    shutdown.request()
    await waited
  })
})
