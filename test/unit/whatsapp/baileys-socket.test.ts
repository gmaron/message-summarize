import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Baileys opens a WebSocket as soon as a socket is made, so it is replaced: the test looks at HOW it is configured.
const made = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  /** Calls to the members of the full socket that the wrapper must never expose. */
  sent: [] as string[],
}))
vi.mock('baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('baileys')>()
  const makeWASocket = (options: Record<string, unknown>) => {
    made.options.push(options)
    return {
      ev: { on() {}, off() {} },
      end() {},
      user: { id: '5491100000009:1@s.whatsapp.net' },
      groupMetadata: async () => ({ subject: 'Vecinos' }),
      signalRepository: { lidMapping: { getPNForLID: async () => '5491100000001@s.whatsapp.net' } },
      sendMessage: () => made.sent.push('sendMessage'),
      sendPresenceUpdate: () => made.sent.push('sendPresenceUpdate'),
      readMessages: () => made.sent.push('readMessages'),
    }
  }
  return { ...actual, default: makeWASocket, makeWASocket }
})

const { BAILEYS_SOCKET_OPTIONS, baileysSocketFactory } = await import(
  '../../../src/infrastructure/whatsapp/baileys-socket.js'
)

const dirs: string[] = []
afterEach(() => {
  made.options.length = 0
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function create() {
  const dir = mkdtempSync(join(tmpdir(), 'message-summarize-socket-'))
  dirs.push(dir)
  const session = await baileysSocketFactory({ authDir: join(dir, 'auth') })
  const options = made.options[0]
  if (options === undefined) throw new Error('no socket was made')
  return { session, options }
}

describe('the Baileys socket configuration', () => {
  it('is not marked online on connect (RNF-17) and does not ask for the full history', async () => {
    const { options } = await create()
    expect(options.markOnlineOnConnect).toBe(false)
    expect(options.syncFullHistory).toBe(false)
    expect(BAILEYS_SOCKET_OPTIONS).toEqual({ markOnlineOnConnect: false, syncFullHistory: false })
  })

  it('gives Baileys a logger that says nothing, at every level and in every child (RNF-04)', async () => {
    const { options } = await create()
    const logger = options.logger as Record<string, (...args: unknown[]) => unknown> & {
      child: (o: object) => typeof logger
      level: string
    }
    const writes: unknown[] = []
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(chunk)
        return true
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(chunk)
        return true
      }),
      vi.spyOn(console, 'log').mockImplementation((...args) => void writes.push(args)),
      vi.spyOn(console, 'error').mockImplementation((...args) => void writes.push(args)),
    ]
    try {
      for (const target of [logger, logger.child({ module: 'x' })]) {
        for (const level of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
          expect(target[level]?.({ key: 'secret-key', text: 'private chat text' }, 'message')).toBeUndefined()
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(writes).toEqual([])
    expect(logger.level).toBe('silent')
  })

  it('hands Baileys the secure auth state and exposes only the narrow socket', async () => {
    const { session, options } = await create()
    expect(options.auth).toBeDefined()
    expect(options.browser).toEqual(['Mac OS', 'message-summarize', '14.4.1'])
    // A real wrapper: only these members exist, and none of them sends.
    expect(Object.keys(session.socket).sort()).toEqual(['end', 'ev', 'groupMetadata', 'signalRepository', 'user'])
    const full = session.socket as unknown as Record<string, unknown>
    expect(full.sendMessage).toBeUndefined()
    expect(full.sendPresenceUpdate).toBeUndefined()
    expect(full.readMessages).toBeUndefined()
    expect(made.sent).toEqual([])
    expect(session.socket.user?.id).toBe('5491100000009:1@s.whatsapp.net')
    expect(await session.socket.groupMetadata('x@g.us')).toEqual({ subject: 'Vecinos' })
    expect(await session.socket.signalRepository?.lidMapping?.getPNForLID('1@lid')).toBe('5491100000001@s.whatsapp.net')
    session.socket.ev.on('messages.upsert', () => undefined)
    session.socket.ev.off('messages.upsert', () => undefined)
    session.socket.end(undefined)
    expect(session.me()).toBeUndefined()
    await expect(session.saveCreds()).resolves.toBeUndefined()
  })

  it('loading the adapter installs the console guard on every console method (RNF-04)', () => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      expect(
        (console[method] as unknown as Record<symbol, unknown>)[Symbol.for('message-summarize.console-guard')],
      ).toBe(true)
    }
  })
})
