import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DROPPED_PREFIXES, installConsoleGuard, isDropped } from '../../../src/infrastructure/whatsapp/console-guard.js'

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const
type Spies = Record<(typeof METHODS)[number], ReturnType<typeof vi.fn>>

const originals = {} as Record<(typeof METHODS)[number], unknown>
let spies: Spies

// The global console is replaced by plain spies (unguarded), and the guard is installed over them: what reaches a
// spy is what would reach the real console.
beforeEach(() => {
  spies = {} as Spies
  for (const method of METHODS) {
    originals[method] = console[method]
    spies[method] = vi.fn()
    console[method] = spies[method] as unknown as Console[typeof method]
  }
  installConsoleGuard()
})
afterEach(() => {
  for (const method of METHODS) console[method] = originals[method] as Console[typeof method]
})

const reached = (): unknown[][] => METHODS.flatMap((m) => spies[m].mock.calls)

describe('the console guard (RNF-04)', () => {
  it('drops every known message, on every console method', () => {
    for (const method of METHODS) {
      for (const prefix of DROPPED_PREFIXES) console[method](`${prefix}: details`, { privateKey: 'secret' })
    }
    expect(reached()).toEqual([])
  })

  it('does not swallow anything else', () => {
    console.log('hello')
    console.info('Opening a file', 1)
    console.warn('x Opening session') // only a PREFIX is matched
    console.error(new Error('Opening session'))
    console.error({ message: 'Opening session' })
    console.debug()
    console.log(42, 'Opening session')
    expect(spies.log.mock.calls).toEqual([['hello'], [42, 'Opening session']])
    expect(spies.info.mock.calls).toEqual([['Opening a file', 1]])
    expect(spies.warn.mock.calls).toEqual([['x Opening session']])
    expect(spies.error).toHaveBeenCalledTimes(2)
    expect(spies.debug).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: installing again neither wraps twice nor changes the behavior', () => {
    const before = METHODS.map((m) => console[m])
    installConsoleGuard()
    installConsoleGuard()
    expect(METHODS.map((m) => console[m])).toEqual(before)
    console.log('once')
    expect(spies.log).toHaveBeenCalledTimes(1)
  })

  it('isDropped looks at the first argument only, and only strings', () => {
    expect(isDropped(['Closing session:', {}])).toBe(true)
    expect(isDropped([{}, 'Closing session:'])).toBe(false)
    expect(isDropped([])).toBe(false)
  })
})

describe('with the real libsignal', () => {
  // libsignal prints session records (private keys included) straight to the console.
  const libsignal = createRequire(import.meta.url)('libsignal') as {
    SessionRecord: {
      new (): {
        closeSession(session: object): void
        openSession(session: object): void
        removeOldSessions(): void
        setSession(session: object): void
        sessions: Record<string, unknown>
      }
      createEntry(): { indexInfo: { baseKey: Buffer; closed: number; used: number; created: number } }
    }
  }

  const entry = (key: string, closed = -1) => {
    const session = libsignal.SessionRecord.createEntry()
    session.indexInfo = { baseKey: Buffer.from(key), closed, used: 0, created: 0 }
    return Object.assign(session, { privateKey: 'PRIVATE-KEY-MATERIAL' })
  }

  it('Opening, Closing, Session already and Removing old closed session reach no console method', () => {
    const record = new libsignal.SessionRecord()
    const session = entry('a')
    record.closeSession(session) // "Closing session:"
    record.closeSession(session) // "Session already closed"
    record.openSession(session) // "Opening session:"
    record.openSession(session) // "Session already open" + "Opening session:"
    for (let i = 0; i < 45; i++) {
      const old = entry(`old-${i}`, i + 1)
      record.setSession(old)
    }
    record.removeOldSessions() // "Removing old closed session:"
    expect(Object.keys(record.sessions).length).toBeLessThanOrEqual(40)
    expect(reached()).toEqual([])
    expect(JSON.stringify(reached())).not.toContain('PRIVATE-KEY-MATERIAL')
  })

  it('the same calls DO print when the guard is not there (the test would notice)', () => {
    // Fresh spies with no guard over them.
    const bare = vi.fn()
    const saved = console.info
    console.info = bare as unknown as typeof console.info
    try {
      new libsignal.SessionRecord().openSession(entry('b', 1))
    } finally {
      console.info = saved
    }
    expect(bare).toHaveBeenCalledWith('Opening session:', expect.anything())
  })
})
