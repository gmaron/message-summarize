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
  /** Arguments of every call to Baileys' media download. */
  downloads: [] as unknown[][],
  /** Calls to `ev.on` and `ev.off` of the full socket: [method, event, listener]. */
  events: [] as unknown[][],
  /** Arguments of every call to `end` of the full socket. */
  ended: [] as unknown[][],
  /** Messages given to `updateMediaMessage` (the media retry that asks the own phone). */
  updates: [] as unknown[],
  /** What `updateMediaMessage` answers. */
  updateImpl: (async () => ({})) as (message: unknown) => Promise<unknown>,
}))
vi.mock('baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('baileys')>()
  const makeWASocket = (options: Record<string, unknown>) => {
    made.options.push(options)
    return {
      ev: {
        on: (...args: unknown[]) => void made.events.push(['on', ...args]),
        off: (...args: unknown[]) => void made.events.push(['off', ...args]),
      },
      end: (...args: unknown[]) => void made.ended.push(args),
      updateMediaMessage: (message: unknown) => {
        made.sent.push('updateMediaMessage')
        made.updates.push(message)
        return made.updateImpl(message)
      },
      get user() {
        return made.user
      },
      groupMetadata: async () => ({ subject: 'Vecinos' }),
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => '9911963367943@s.whatsapp.net',
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
  const downloadContentFromMessage = async (...args: unknown[]) => {
    made.downloads.push(args)
    return 'the stream'
  }
  return { ...actual, default: makeWASocket, makeWASocket, downloadContentFromMessage }
})

const DESCRIPTOR = {
  directPath: '/v/t62.7117-24/1_2_n.enc?ccb=11-4',
  mediaKey: new Uint8Array(32).fill(8),
  mimetype: 'audio/ogg; codecs=opus',
  fileLength: 10,
}

const { BAILEYS_SOCKET_OPTIONS, REUPLOAD_ANSWER_TIMEOUT_MS, baileysSocketFactory } = await import(
  '../../../src/infrastructure/whatsapp/baileys-socket.js'
)

const dirs: string[] = []
beforeEach(() => {
  made.user = { id: '9913174261432:1@s.whatsapp.net', lid: '99900000009:1@lid' }
})
afterEach(() => {
  made.options.length = 0
  made.sent.length = 0
  made.messages.length = 0
  made.downloads.length = 0
  made.events.length = 0
  made.ended.length = 0
  made.updates.length = 0
  made.updateImpl = async () => ({})
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function create(extra: { fullHistory?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'message-summarize-socket-'))
  dirs.push(dir)
  const session = await baileysSocketFactory({ authDir: join(dir, 'auth'), ...extra })
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

  it('asks for the full history only when the account opted in (fullHistoryOnLink), and changes nothing else', async () => {
    const off = await create({ fullHistory: false })
    expect(off.options.syncFullHistory).toBe(false)
    made.options.length = 0
    const on = await create({ fullHistory: true })
    expect(on.options.syncFullHistory).toBe(true)
    // Everything else stays as it was: not online, a desktop browser, the silent logger.
    expect(on.options.markOnlineOnConnect).toBe(false)
    expect(on.options.browser).toEqual(off.options.browser)
    expect(on.options.logger).toBe(off.options.logger)
    // The constant itself is not touched by the opt-in.
    expect(BAILEYS_SOCKET_OPTIONS.syncFullHistory).toBe(false)
  })

  it('opens an audio with no download context, so an expired media is never re-requested from the sender (RNF-17)', async () => {
    const { session } = await create()
    expect(await session.socket.openAudio(DESCRIPTOR)).toBe('the stream')
    // The fourth argument of a download with a context is `reuploadRequest`: there is none, and only three are given.
    expect(made.downloads).toHaveLength(1)
    expect(made.downloads[0]?.[1]).toBe('audio')
    expect(made.downloads[0]).toHaveLength(3)
    expect(made.sent).toEqual([])
  })

  it('fixes the media host to the one of WhatsApp, and gives Baileys only the path and the key: never a url', async () => {
    const { session } = await create()
    await session.socket.openAudio(DESCRIPTOR)
    // Baileys' own default: DEF_MEDIA_HOST in node_modules/baileys/lib/Utils/messages-media.js
    expect(made.downloads[0]?.[2]).toEqual({ host: 'mmg.whatsapp.net' })
    expect(made.downloads[0]?.[0]).toEqual({ mediaKey: DESCRIPTOR.mediaKey, directPath: DESCRIPTOR.directPath })
  })

  it('refuses to open an audio with no plain directPath, without calling Baileys (second lock, after the fetcher)', async () => {
    const { session } = await create()
    for (const directPath of ['', '@evil.example/x', '//evil.example/x', '/v/../x', 'https://evil.example/x']) {
      await expect(session.socket.openAudio({ ...DESCRIPTOR, directPath })).rejects.toThrow('invalid-media-path')
    }
    expect(made.downloads).toEqual([])
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
      'openAudio',
      'requestAudioReupload',
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
    expect(session.socket.user?.id).toBe('9913174261432:1@s.whatsapp.net')
    expect(await session.socket.groupMetadata('x@g.us')).toEqual({ subject: 'Vecinos' })
    expect(await session.socket.signalRepository?.lidMapping?.getPNForLID('1@lid')).toBe('9911963367943@s.whatsapp.net')
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
    expect(made.messages).toEqual([['9913174261432@s.whatsapp.net', { text: '*Resumen*\n_hola_', linkPreview: null }]])
    expect(made.sent).toEqual(['sendMessage']) // no presence update, no read receipt
  })

  it('never uses the LID, and takes no recipient from the caller', async () => {
    const { session } = await create()
    expect(session.socket.sendTextToSelf.length).toBe(1)
    await (session.socket.sendTextToSelf as (...args: unknown[]) => Promise<void>)(
      'text',
      '9911963367943@s.whatsapp.net',
    )
    expect(made.messages.map((m) => m[0])).toEqual(['9913174261432@s.whatsapp.net'])
  })

  it('follows the user of the socket at the moment of sending', async () => {
    const { session } = await create()
    made.user = { id: '9915127348271:2@s.whatsapp.net' }
    await session.socket.sendTextToSelf('hi')
    expect(made.messages.map((m) => m[0])).toEqual(['9915127348271@s.whatsapp.net'])
  })

  it.each([
    ['no user', undefined],
    ['an empty id', { id: '' }],
    ['a LID', { id: '99900000009:1@lid' }],
    ['a group', { id: '120363146125332922@g.us' }],
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
      [
        'end',
        'ev',
        'groupMetadata',
        'openAudio',
        'requestAudioReupload',
        'sendTextToSelf',
        'signalRepository',
        'user',
      ].sort(),
    )
  })

  it('reads the number-to-LID mapping from the stored keys, and asks nobody', async () => {
    const { session, options } = await create()
    const auth = options.auth as { keys: { set(data: Record<string, Record<string, string>>): Promise<void> } }
    await auth.keys.set({ 'lid-mapping': { '9911963367943': '99900000001', '99900000001_reverse': '9911963367943' } })
    const mapping = session.socket.signalRepository?.lidMapping
    expect(await mapping?.storedLidForPN?.('9911963367943:7@s.whatsapp.net')).toBe('99900000001@lid')
    expect(await mapping?.storedLidForPN?.('9912465397241@s.whatsapp.net')).toBeNull()
    expect(await mapping?.getPNForLID('99900000001@lid')).toBe('9911963367943@s.whatsapp.net')
    expect(made.sent).toEqual([])
  })
})

describe('the logger given to Baileys says nothing (RNF-04)', () => {
  it('every level is a function that returns nothing and writes nothing, in the logger, its children and theirs', async () => {
    const { options } = await create()
    type Logger = Record<string, unknown> & { child: (o: object) => Logger }
    const logger = options.logger as Logger
    const writes: unknown[] = []
    const record = (...args: unknown[]) => void writes.push(args)
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(chunk)
        return true
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(chunk)
        return true
      }),
      vi.spyOn(console, 'log').mockImplementation(record),
      vi.spyOn(console, 'info').mockImplementation(record),
      vi.spyOn(console, 'warn').mockImplementation(record),
      vi.spyOn(console, 'error').mockImplementation(record),
      vi.spyOn(console, 'debug').mockImplementation(record),
      vi.spyOn(console, 'trace').mockImplementation(record),
    ]
    try {
      for (const target of [logger, logger.child({ module: 'a' }), logger.child({}).child({ module: 'b' })]) {
        expect(target.level).toBe('silent')
        for (const level of ['trace', 'debug', 'info', 'warn', 'error']) {
          const method = target[level]
          expect(typeof method, level).toBe('function')
          expect(
            (method as (...args: unknown[]) => unknown)({ key: 'secret-key', text: 'private chat text' }, 'message'),
          ).toBeUndefined()
        }
        expect(typeof target.child).toBe('function')
      }
      // a child is the same silent logger, not a new one that could be configured differently
      expect(logger.child({ module: 'a' })).toBe(logger)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(writes).toEqual([])
  })
})

describe('the narrow socket passes things through to the real one', () => {
  it('registers and removes listeners by event name, with the same listener', async () => {
    const { session } = await create()
    const listener = () => undefined
    session.socket.ev.on('messages.upsert', listener)
    session.socket.ev.off('creds.update', listener)
    expect(made.events).toEqual([
      ['on', 'messages.upsert', listener],
      ['off', 'creds.update', listener],
    ])
  })

  it('end closes the connection with the error it was given', async () => {
    const { session } = await create()
    const reason = new Error('stop')
    session.socket.end(reason)
    session.socket.end(undefined)
    expect(made.ended).toEqual([[reason], [undefined]])
  })

  it('reads the stored LID mapping: an empty number or an empty stored value is no LID', async () => {
    const { session, options } = await create()
    const auth = options.auth as { keys: { set(data: Record<string, Record<string, string>>): Promise<void> } }
    await auth.keys.set({ 'lid-mapping': { '9911963367943': '99900000001', '9917770001': '' } })
    const mapping = session.socket.signalRepository?.lidMapping
    expect(await mapping?.storedLidForPN?.('9917770001@s.whatsapp.net')).toBeNull()
    expect(await mapping?.storedLidForPN?.('')).toBeNull()
    expect(await mapping?.storedLidForPN?.('@s.whatsapp.net')).toBeNull()
    expect(await mapping?.storedLidForPN?.('9911963367943@s.whatsapp.net')).toBe('99900000001@lid')
    expect(made.sent).toEqual([])
  })
})

describe('requestAudioReupload issues only the media retry (RF-15, RNF-17)', () => {
  const KEY = { remoteJid: '9912465397241@s.whatsapp.net', id: 'ABC123', fromMe: false, participant: null }
  const REQUEST = { key: KEY, descriptor: DESCRIPTOR }
  const NEW_PATH = '/v/t62.7117-24/3_4_n.enc?ccb=11-4&oh=abc'
  const answerWith = (directPath: unknown) => async () => ({ message: { audioMessage: { directPath } } })

  it('sends the media retry with the key and the media of the message, and nothing else', async () => {
    made.updateImpl = answerWith(NEW_PATH)
    const { session } = await create()
    expect(await session.socket.requestAudioReupload?.(REQUEST)).toBe(NEW_PATH)
    expect(made.updates).toEqual([
      {
        key: { remoteJid: KEY.remoteJid, id: 'ABC123', fromMe: false },
        message: {
          audioMessage: {
            mediaKey: DESCRIPTOR.mediaKey,
            directPath: DESCRIPTOR.directPath,
            mimetype: DESCRIPTOR.mimetype,
          },
        },
      },
    ])
    const key = (made.updates[0] as { key: object }).key
    expect('participant' in key).toBe(false)
    // no message, no presence, no read receipt, no query
    expect(made.sent).toEqual(['updateMediaMessage'])
  })

  it('names the participant of a group message, and keeps fromMe as it is', async () => {
    made.updateImpl = answerWith(NEW_PATH)
    const { session } = await create()
    const participant = '9915127348271@s.whatsapp.net'
    await session.socket.requestAudioReupload?.({
      key: { remoteJid: '120363146125332922@g.us', id: 'G1', fromMe: true, participant },
      descriptor: DESCRIPTOR,
    })
    expect((made.updates[0] as { key: unknown }).key).toEqual({
      remoteJid: '120363146125332922@g.us',
      id: 'G1',
      fromMe: true,
      participant,
    })
  })

  it.each([
    ['no message', {}],
    ['no audio message', { message: {} }],
    ['no path', { message: { audioMessage: {} } }],
    ['an empty path', { message: { audioMessage: { directPath: '' } } }],
    ['a host in the path', { message: { audioMessage: { directPath: '//evil.example/x' } } }],
    ['a url', { message: { audioMessage: { directPath: 'https://evil.example/x' } } }],
    ['a userinfo path', { message: { audioMessage: { directPath: '@evil.example/x' } } }],
    ['a path that climbs', { message: { audioMessage: { directPath: '/v/../x' } } }],
  ])('rejects an answer with %s: the new path is checked like any other', async (_name, answer) => {
    made.updateImpl = async () => answer
    const { session } = await create()
    await expect(session.socket.requestAudioReupload?.(REQUEST)).rejects.toThrow('invalid-media-path')
  })

  it('what the phone says (it does not have the file) reaches the caller as it is', async () => {
    const boom = Object.assign(new Error('not found'), { output: { statusCode: 404 } })
    made.updateImpl = async () => {
      throw boom
    }
    const { session } = await create()
    await expect(session.socket.requestAudioReupload?.(REQUEST)).rejects.toBe(boom)
  })

  it('gives up with "timeout" when the phone does not answer in 45 seconds, and a late answer is ignored', async () => {
    vi.useFakeTimers()
    let late: (value: unknown) => void = () => undefined
    made.updateImpl = () => new Promise((resolve) => (late = resolve))
    const { session } = await create()
    const settled = vi.fn()
    const result = session.socket.requestAudioReupload?.(REQUEST)
    const outcome = result?.then(
      (value) => settled('resolved', value),
      (error: Error) => settled('rejected', error.message),
    )
    await vi.advanceTimersByTimeAsync(REUPLOAD_ANSWER_TIMEOUT_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await outcome
    expect(settled).toHaveBeenCalledExactlyOnceWith('rejected', 'timeout')
    late(answerWith(NEW_PATH)())
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(REUPLOAD_ANSWER_TIMEOUT_MS).toBe(45_000)
  })

  it('leaves no timer behind once the phone has answered, or failed', async () => {
    vi.useFakeTimers()
    made.updateImpl = answerWith(NEW_PATH)
    const { session } = await create()
    await session.socket.requestAudioReupload?.(REQUEST)
    expect(vi.getTimerCount()).toBe(0)
    made.updateImpl = async () => {
      throw new Error('no')
    }
    await session.socket.requestAudioReupload?.(REQUEST).catch(() => undefined)
    expect(vi.getTimerCount()).toBe(0)
  })
})
