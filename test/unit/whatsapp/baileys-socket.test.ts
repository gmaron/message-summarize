import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Baileys opens a WebSocket as soon as a socket is made, so it is replaced: the test looks at HOW it is configured.
const made = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  /** Calls to the members of the full socket that the wrapper must never expose. */
  sent: [] as string[],
  /** Arguments of every sendMessage call of the full socket. */
  messages: [] as unknown[][],
  /** The authenticated user the full socket reports. */
  user: undefined as { id: string; lid?: string } | undefined,
}))
vi.mock('baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('baileys')>()
  const makeWASocket = (options: Record<string, unknown>) => {
    made.options.push(options)
    return {
      ev: { on() {}, off() {} },
      end() {},
      get user() {
        return made.user
      },
      groupMetadata: async () => ({ subject: 'Vecinos' }),
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => '5491100000001@s.whatsapp.net',
          // These two end in a USync query to WhatsApp's servers when the mapping is not stored: never reachable.
          getLIDForPN: async () => {
            made.sent.push('getLIDForPN')
            return null
          },
          getLIDsForPNs: async () => {
            made.sent.push('getLIDsForPNs')
            return null
          },
        },
      },
      query: async () => {
        made.sent.push('query')
      },
      executeUSyncQuery: async () => {
        made.sent.push('executeUSyncQuery')
      },
      onWhatsApp: async () => {
        made.sent.push('onWhatsApp')
      },
      sendMessage: async (...args: unknown[]) => {
        made.sent.push('sendMessage')
        made.messages.push(args)
      },
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
beforeEach(() => {
  made.user = { id: '5491100000009:1@s.whatsapp.net', lid: '99900000009:1@lid' }
})
afterEach(() => {
  made.options.length = 0
  made.sent.length = 0
  made.messages.length = 0
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
    expect(Object.keys(session.socket).sort()).toEqual([
      'end',
      'ev',
      'groupMetadata',
      'sendTextToSelf',
      'signalRepository',
      'user',
    ])
    const full = session.socket as unknown as Record<string, unknown>
    expect(full.sendMessage).toBeUndefined()
    expect(full.sendRawMessage).toBeUndefined()
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

describe('sendTextToSelf, the only way to send (RF-50, RF-51, RNF-17)', () => {
  it('sends a plain text to the own phone-number jid, without device, and nothing else', async () => {
    const { session } = await create()
    await session.socket.sendTextToSelf('*Resumen*\n_hola_')
    expect(made.messages).toEqual([['5491100000009@s.whatsapp.net', { text: '*Resumen*\n_hola_', linkPreview: null }]])
    expect(made.sent).toEqual(['sendMessage']) // no presence update, no read receipt
  })

  it('never uses the LID, and takes no recipient from the caller', async () => {
    const { session } = await create()
    expect(session.socket.sendTextToSelf.length).toBe(1)
    await (session.socket.sendTextToSelf as (...args: unknown[]) => Promise<void>)(
      'text',
      '5491100000001@s.whatsapp.net',
    )
    expect(made.messages.map((m) => m[0])).toEqual(['5491100000009@s.whatsapp.net'])
  })

  it('follows the user of the socket at the moment of sending', async () => {
    const { session } = await create()
    made.user = { id: '5491100000010:2@s.whatsapp.net' }
    await session.socket.sendTextToSelf('hi')
    expect(made.messages.map((m) => m[0])).toEqual(['5491100000010@s.whatsapp.net'])
  })

  it.each([
    ['no user', undefined],
    ['an empty id', { id: '' }],
    ['a LID', { id: '99900000009:1@lid' }],
    ['a group', { id: '120363000000000001@g.us' }],
    ['a broadcast list', { id: 'status@broadcast' }],
    ['something that is not a jid', { id: 'hello' }],
  ])('rejects and sends nothing when the user is %s', async (_name, user) => {
    const { session } = await create()
    made.user = user
    await expect(session.socket.sendTextToSelf('private digest')).rejects.toThrow()
    expect(made.sent).toEqual([])
    expect(made.messages).toEqual([])
  })
})

describe('the LID mapping of the narrow socket (RNF-01, RNF-17)', () => {
  it('exposes only local lookups: no method that can query WhatsApp', async () => {
    const { session } = await create()
    const mapping = session.socket.signalRepository?.lidMapping
    expect(Object.keys(mapping ?? {}).sort()).toEqual(['getPNForLID', 'storedLidForPN'])
    expect(Object.keys(session.socket).sort()).toEqual(
      ['end', 'ev', 'groupMetadata', 'sendTextToSelf', 'signalRepository', 'user'].sort(),
    )
  })

  it('reads the number-to-LID mapping from the stored keys, and asks nobody', async () => {
    const { session, options } = await create()
    const auth = options.auth as { keys: { set(data: Record<string, Record<string, string>>): Promise<void> } }
    await auth.keys.set({ 'lid-mapping': { '5491100000001': '99900000001', '99900000001_reverse': '5491100000001' } })
    const mapping = session.socket.signalRepository?.lidMapping
    expect(await mapping?.storedLidForPN?.('5491100000001:7@s.whatsapp.net')).toBe('99900000001@lid')
    expect(await mapping?.storedLidForPN?.('5491100000002@s.whatsapp.net')).toBeNull()
    expect(await mapping?.getPNForLID('99900000001@lid')).toBe('5491100000001@s.whatsapp.net')
    expect(made.sent).toEqual([])
  })
})
