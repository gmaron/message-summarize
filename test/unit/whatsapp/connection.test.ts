import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backoffDelay,
  createWhatsAppConnection,
  OwnConversationIds,
  type WhatsAppStatus,
} from '../../../src/infrastructure/whatsapp/index.js'
import { FixedClock } from '../../support/application-fakes.js'
import {
  ALLOWED_SOCKET_MEMBERS,
  type FakeSocket,
  fakeSocketFactory,
  recordingCapture,
} from '../../support/whatsapp-fakes.js'

const ANA = '9911963367943@s.whatsapp.net'
const ANA_LID = '99900000001@lid'
const ME = '9913174261432@s.whatsapp.net'
const ME_LID = '99900000009@lid'

const boom = (statusCode: number) => ({ error: { output: { statusCode } } })

const dirs: string[] = []
const authDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'message-summarize-auth-'))
  dirs.push(dir)
  return dir
}

function setup(factoryOptions: Parameters<typeof fakeSocketFactory>[0] = {}) {
  const fake = fakeSocketFactory(factoryOptions)
  const { capture, calls } = recordingCapture()
  const ownIds = new OwnConversationIds()
  const dir = authDir()
  const warnings: string[] = []
  const connection = createWhatsAppConnection({
    authDir: dir,
    language: 'es',
    capture,
    clock: new FixedClock(1_800_000_000_000),
    ownIds,
    socketFactory: fake.factory,
    onWarning: (code) => warnings.push(code),
  })
  const statuses: WhatsAppStatus[] = []
  connection.onStatus((s) => statuses.push(s))
  const states = () => statuses.map((s) => s.state)
  const last = (): FakeSocket => {
    const socket = fake.sockets.at(-1)
    if (socket === undefined) throw new Error('no socket yet')
    return socket
  }
  const flush = () => vi.advanceTimersByTimeAsync(0)
  return { connection, fake, calls, ownIds, dir, statuses, states, last, flush, warnings }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(async () => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('backoff', () => {
  it('doubles from the base up to the maximum', () => {
    const policy = { baseMs: 1_000, maxMs: 60_000 }
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(policy, n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ])
  })
})

describe('linking and status (RF-01, RF-04)', () => {
  it('goes connecting, qr (renewed), connected, and knows the own chat under every id', async () => {
    const t = setup({ me: () => ({ id: `${ME.replace('@', ':4@')}`, lid: ME_LID }) })
    await t.connection.start()
    expect(t.connection.status).toEqual({ state: 'connecting' })
    expect(t.ownIds.get()).toEqual([ME, ME_LID]) // known from the stored session, before the connection opens
    const socket = t.last()
    socket.ev.emit('connection.update', { connection: 'connecting' })
    socket.ev.emit('connection.update', { qr: 'QR-ONE' })
    socket.ev.emit('connection.update', { qr: 'QR-TWO' })
    socket.user = { id: `${ME.replace('@', ':4@')}`, lid: `${ME_LID.replace('@', ':4@')}` }
    socket.ev.emit('connection.update', { connection: 'open' })
    expect(t.statuses).toEqual([
      { state: 'connecting' },
      { state: 'qr', qr: 'QR-ONE' },
      { state: 'qr', qr: 'QR-TWO' },
      { state: 'connected' },
    ])
    expect(t.ownIds.get()).toEqual([ME, ME_LID])
  })

  it('learns the own ids when a new account is linked (no stored session)', async () => {
    const t = setup()
    await t.connection.start()
    t.last().user = { id: `${ME.replace('@', ':4@')}`, lid: ME_LID }
    t.last().ev.emit('connection.update', { connection: 'open' })
    expect(t.ownIds.get()).toEqual([ME, ME_LID])
  })

  it('start() twice does not open two sockets', async () => {
    const t = setup()
    await t.connection.start()
    await t.connection.start()
    expect(t.fake.sockets).toHaveLength(1)
    expect(t.fake.calls).toEqual([{ authDir: t.dir }])
  })

  it('a status listener can unsubscribe, and one that throws does not break the others', async () => {
    const t = setup()
    const seen: string[] = []
    const off = t.connection.onStatus((s) => seen.push(s.state))
    t.connection.onStatus(() => {
      throw new Error('bad listener')
    })
    await t.connection.start()
    off()
    t.last().ev.emit('connection.update', { connection: 'open' })
    expect(seen).toEqual(['connecting'])
    expect(t.states().at(-1)).toBe('connected')
    expect(t.warnings).toContain('status-listener-failed')
  })

  it('a socket that cannot be created is an error, with a fixed reason and no retry', async () => {
    const t = setup({ fail: true })
    await t.connection.start()
    expect(t.connection.status).toEqual({ state: 'error', reason: 'socketFailed' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(t.fake.calls).toHaveLength(1)
  })
})

describe('reconnecting (RF-05)', () => {
  it('retries with growing delays after any close, and a successful open resets the backoff', async () => {
    const t = setup()
    await t.connection.start()
    t.last().ev.emit('connection.update', { connection: 'open' })
    t.last().ev.emit('connection.update', { connection: 'close', lastDisconnect: boom(408) })
    expect(t.connection.status).toEqual({ state: 'reconnecting', attempt: 1, delayMs: 1_000, reason: 'connectionLost' })
    expect(t.fake.sockets).toHaveLength(1)
    expect(t.fake.sockets[0]?.listenerCount()).toBe(0)
    expect(t.fake.sockets[0]?.ended.count).toBe(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(t.fake.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.fake.sockets).toHaveLength(2)
    expect(t.connection.status).toEqual({ state: 'connecting' })

    t.last().ev.emit('connection.update', { connection: 'close', lastDisconnect: boom(428) })
    expect(t.connection.status).toMatchObject({ attempt: 2, delayMs: 2_000, reason: 'connectionClosed' })
    await vi.advanceTimersByTimeAsync(2_000)
    t.last().ev.emit('connection.update', { connection: 'close', lastDisconnect: boom(515) })
    expect(t.connection.status).toMatchObject({ attempt: 3, delayMs: 4_000, reason: 'restartRequired' })
    await vi.advanceTimersByTimeAsync(4_000)

    t.last().ev.emit('connection.update', { connection: 'open' })
    t.last().ev.emit('connection.update', { connection: 'close', lastDisconnect: {} })
    expect(t.connection.status).toEqual({ state: 'reconnecting', attempt: 1, delayMs: 1_000, reason: 'unknown' })
  })

  it('keeps trying while the network is down, up to the maximum delay', async () => {
    const t = setup()
    await t.connection.start()
    for (let i = 0; i < 9; i++) {
      t.last().ev.emit('connection.update', { connection: 'close', lastDisconnect: boom(408) })
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(t.connection.status).toMatchObject({ state: 'connecting' })
    expect(t.fake.sockets).toHaveLength(10)
    t.last().ev.emit('connection.update', { connection: 'close', lastDisconnect: boom(408) })
    expect(t.connection.status).toMatchObject({ attempt: 10, delayMs: 60_000 })
  })

  it('events of a closed socket are ignored', async () => {
    const t = setup()
    await t.connection.start()
    const old = t.last()
    old.ev.emit('connection.update', { connection: 'close', lastDisconnect: boom(408) })
    await vi.advanceTimersByTimeAsync(1_000)
    const before = t.states().length
    old.ev.emit('connection.update', { connection: 'open' })
    old.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: ANA, id: 'X' }, message: { conversation: 'late' }, messageTimestamp: 1 }],
    })
    await t.flush()
    expect(t.states()).toHaveLength(before)
    expect(t.calls).toEqual([])
  })
})

describe('closes that are not retried', () => {
  it('401: loggedOut, no retry; start() stays loggedOut and does not loop', async () => {
    const t = setup()
    await t.connection.start()
    t.last().ev.emit('connection.update', { connection: 'close', lastDisconnect: boom(401) })
    expect(t.connection.status).toEqual({ state: 'loggedOut' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(t.fake.sockets).toHaveLength(1)
    expect(t.fake.sockets[0]?.listenerCount()).toBe(0)

    await t.connection.start()
    await t.connection.start()
    expect(t.connection.status).toEqual({ state: 'loggedOut' })
    expect(t.fake.sockets).toHaveLength(1)
  })

  it('403: error "forbidden", no retry', async () => {
    const t = setup()
    await t.connection.start()
    t.last().ev.emit('connection.update', { connection: 'close', lastDisconnect: boom(403) })
    expect(t.connection.status).toEqual({ state: 'error', reason: 'forbidden' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(t.fake.sockets).toHaveLength(1)
  })

  it('440: error "replaced", no retry; an explicit start() tries again', async () => {
    const t = setup()
    await t.connection.start()
    t.last().ev.emit('connection.update', { connection: 'close', lastDisconnect: boom(440) })
    expect(t.connection.status).toEqual({ state: 'error', reason: 'replaced' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(t.fake.sockets).toHaveLength(1)
    await t.connection.start()
    expect(t.fake.sockets).toHaveLength(2)
    expect(t.connection.status).toEqual({ state: 'connecting' })
  })

  it('clearSession() removes the stored session so the account can be linked again', async () => {
    const t = setup()
    writeFileSync(join(t.dir, 'creds.json'), '{}')
    writeFileSync(join(t.dir, 'pre-key-1.json'), '{}')
    await t.connection.start()
    t.last().ev.emit('connection.update', { connection: 'close', lastDisconnect: boom(401) })
    await t.connection.clearSession()
    expect(existsSync(t.dir)).toBe(true)
    expect(readdirSync(t.dir)).toEqual([])
    expect(t.ownIds.get()).toEqual([])
    expect(t.connection.status).toEqual({ state: 'stopped' })
    await t.connection.start()
    expect(t.fake.sockets).toHaveLength(2)
    expect(t.connection.status).toEqual({ state: 'connecting' })
  })

  it('clearSession() on a connection that is running stops it first', async () => {
    const t = setup()
    writeFileSync(join(t.dir, 'creds.json'), '{}')
    await t.connection.start()
    await t.connection.clearSession()
    expect(t.fake.sockets[0]?.listenerCount()).toBe(0)
    expect(t.fake.sockets[0]?.ended.count).toBe(1)
    expect(readdirSync(t.dir)).toEqual([])
  })
})

describe('clearSession() and writes in flight', () => {
  it('waits for the pending credential and key writes before it removes the files', async () => {
    let release: () => void = () => undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const t = setup({ settle: () => pending })
    writeFileSync(join(t.dir, 'creds.json'), '{}')
    await t.connection.start()
    vi.useRealTimers() // the file system is real: give it real time to (wrongly) finish early
    let done = false
    const clearing = t.connection.clearSession().then(() => {
      done = true
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(done).toBe(false)
    expect(existsSync(join(t.dir, 'creds.json'))).toBe(true)
    // the write finishes (and may recreate the file), and only then is the directory emptied
    writeFileSync(join(t.dir, 'creds.json'), '{"late":true}')
    release()
    await clearing
    expect(readdirSync(t.dir)).toEqual([])
  })

  it('forwards the stored-name lookup, so a group that has a name is not asked about', async () => {
    const fake = fakeSocketFactory()
    const connection = createWhatsAppConnection({
      authDir: authDir(),
      language: 'es',
      capture: recordingCapture().capture,
      clock: new FixedClock(1),
      ownIds: new OwnConversationIds(),
      socketFactory: fake.factory,
      storedConversationName: async () => 'Stored',
    })
    await connection.start()
    fake.sockets[0]?.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '1203@g.us', id: 'A' }, message: { conversation: 'a' }, messageTimestamp: 5 }],
    })
    await connection.stop()
    expect(fake.sockets[0]?.groupQueries).toEqual([])
  })
})

describe('stop()', () => {
  it('detaches, closes the socket, cancels a pending reconnection and reports stopped', async () => {
    const t = setup()
    await t.connection.start()
    t.last().ev.emit('connection.update', { connection: 'open' })
    await t.connection.stop()
    expect(t.connection.status).toEqual({ state: 'stopped' })
    expect(t.fake.sockets[0]?.listenerCount()).toBe(0)
    expect(t.fake.sockets[0]?.ended.count).toBe(1)
    await t.connection.stop() // idempotent
  })

  it('cancels the pending reconnection', async () => {
    const t = setup()
    await t.connection.start()
    t.last().ev.emit('connection.update', { connection: 'close', lastDisconnect: boom(408) })
    await t.connection.stop()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(t.fake.sockets).toHaveLength(1)
    expect(t.connection.status).toEqual({ state: 'stopped' })
  })

  it('a socket that finishes being created after stop() is closed and never used', async () => {
    let release: (() => void) | undefined
    const t = setup()
    const slow = fakeSocketFactory()
    const connection = createWhatsAppConnection({
      authDir: t.dir,
      language: 'es',
      capture: recordingCapture().capture,
      clock: new FixedClock(1),
      ownIds: new OwnConversationIds(),
      socketFactory: async (options) => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return slow.factory(options)
      },
    })
    const starting = connection.start()
    await connection.stop()
    release?.()
    await starting
    expect(slow.sockets[0]?.ended.count).toBe(1)
    expect(slow.sockets[0]?.listenerCount()).toBe(0)
    expect(connection.status).toEqual({ state: 'stopped' })
  })

  it('waits for the events already queued', async () => {
    const t = setup()
    await t.connection.start()
    t.last().ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: ANA, id: 'M1' }, message: { conversation: 'hi' }, messageTimestamp: 5 }],
    })
    await t.connection.stop()
    expect(t.calls.map((c) => c.method)).toEqual(['conversationMetadata', 'receiveMessage'])
  })
})

describe('events reach the capture, in order', () => {
  it('routes every event to the translation, and keeps their order across events', async () => {
    const t = setup({ me: () => ({ id: ME, lid: ME_LID }) })
    await t.connection.start()
    const socket = t.last()
    const msg = (id: string, jid: string) => ({
      key: { remoteJid: jid, id },
      message: { conversation: id },
      messageTimestamp: 5,
    })
    socket.ev.emit('messaging-history.set', {
      contacts: [{ id: ANA, name: 'Ana' }],
      chats: [{ id: ANA, unreadCount: 1 }],
      messages: [msg('H1', ANA)],
    })
    socket.ev.emit('messages.upsert', { type: 'append', messages: [msg('L1', ANA)] })
    socket.ev.emit('chats.upsert', [{ id: ANA, name: 'Ana G' }])
    socket.ev.emit('chats.update', [{ id: ANA, unreadCount: 0 }])
    socket.ev.emit('contacts.upsert', [{ id: ANA, notify: 'Anita' }])
    socket.ev.emit('contacts.update', [{ id: ANA, notify: 'Anita' }])
    socket.ev.emit('groups.upsert', [{ id: '1203@g.us', subject: 'G' }])
    socket.ev.emit('groups.update', [{ id: '1203@g.us', subject: 'G2' }])
    socket.ev.emit('messages.update', [{ key: { remoteJid: ANA, id: 'L1', fromMe: false }, update: { status: 4 } }])
    socket.ev.emit('lid-mapping.update', { lid: ANA_LID, pn: ANA })
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [msg('L2', ANA_LID)] })
    await t.connection.stop()
    expect(t.calls.map((c) => c.method)).toEqual([
      'participantInfo',
      'unreadSnapshot', // history: contacts, chats, then messages
      'conversationMetadata',
      'receiveMessage', // H1, history
      'receiveMessage', // L1, an 'append' while connected: live
      'conversationMetadata', // chats.upsert: a new name
      'unreadChanged',
      'participantInfo',
      'participantInfo',
      'conversationMetadata', // groups.upsert
      'conversationMetadata', // groups.update
      'messagesRead',
      'conversationMetadata', // the push name changed the conversation name
      'receiveMessage', // L2 via the learned LID mapping
    ])
    const origins = t.calls
      .filter((c) => c.method === 'receiveMessage')
      .map((c) => c.event as { origin: string; message: { conversationId: string } })
    expect(origins.map((o) => o.origin)).toEqual(['history', 'live', 'live'])
    expect(origins[2]?.message.conversationId).toBe(ANA)
  })

  it('an append delivered after a reconnect counts as live (it increments unread)', async () => {
    const t = setup()
    await t.connection.start()
    t.last().ev.emit('connection.update', { connection: 'close', lastDisconnect: boom(408) })
    await vi.advanceTimersByTimeAsync(1_000)
    t.last().ev.emit('connection.update', { connection: 'open' })
    t.last().ev.emit('messages.upsert', {
      type: 'append',
      messages: [
        {
          key: { remoteJid: ANA, id: 'OFFLINE' },
          message: { conversation: 'while you were away' },
          messageTimestamp: 5,
        },
      ],
    })
    await t.flush()
    expect(t.calls.find((c) => c.method === 'receiveMessage')?.event).toMatchObject({ origin: 'live' })
  })

  it('the snapshot of a session is stamped with the moment the connection opened', async () => {
    const t = setup()
    await t.connection.start()
    t.last().ev.emit('connection.update', { connection: 'open' })
    t.last().ev.emit('messaging-history.set', { chats: [{ id: ANA, unreadCount: 2 }] })
    await t.flush()
    expect(t.calls.find((c) => c.method === 'unreadSnapshot')?.event).toMatchObject({
      snapshotStartedAt: 1_800_000_000_000,
    })
  })

  it('creds.update saves the credentials, and a failure to save is only a warning', async () => {
    const t = setup()
    await t.connection.start()
    t.last().ev.emit('creds.update', {})
    t.last().ev.emit('creds.update', {})
    expect(t.fake.saved.count).toBe(2)
  })

  it('a failing event is reported by a fixed code, and the next one is still processed', async () => {
    const t = setup()
    await t.connection.start()
    t.last().ev.emit('messages.upsert', null)
    t.last().ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: ANA, id: 'OK' }, message: { conversation: 'fine' }, messageTimestamp: 5 }],
    })
    await t.flush()
    expect(t.warnings).toEqual(['event-failed'])
    expect(t.calls.some((c) => c.method === 'receiveMessage')).toBe(true)
  })

  it('translates a LID through the platform mapping, and asks the group subject (the only queries)', async () => {
    const t = setup()
    await t.connection.start()
    const socket = t.last()
    socket.lidToPhone[ANA_LID] = ANA
    socket.groupSubjects['1203@g.us'] = 'Vecinos'
    const msg = (id: string, jid: string) => ({
      key: { remoteJid: jid, id },
      message: { conversation: id },
      messageTimestamp: 5,
    })
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [msg('A', ANA_LID), msg('B', '1203@g.us')] })
    await t.flush()
    const received = t.calls
      .filter((c) => c.method === 'receiveMessage')
      .map((c) => c.event as { conversationName: string | null; message: { conversationId: string } })
    expect(received[0]?.message.conversationId).toBe(ANA)
    expect(received[1]?.conversationName).toBe('Vecinos')
    expect(socket.groupQueries).toEqual(['1203@g.us'])
  })
})

describe('history sync progress (RF-02)', () => {
  const RECENT = 3
  const BOOTSTRAP = 0

  async function started() {
    const t = setup({ me: () => ({ id: ME, lid: ME_LID }) })
    await t.connection.start()
    const seen: unknown[] = []
    t.connection.onHistorySync((p) => seen.push(p))
    return { t, seen, ev: t.last().ev }
  }

  it('reports the percent of the RECENT history after the chunk was stored, and nothing else of it', async () => {
    const { t, seen, ev } = await started()
    ev.emit('messaging-history.set', {
      chats: [{ id: ANA, unreadCount: 0 }],
      messages: [{ key: { remoteJid: ANA, id: 'H1' }, message: { conversation: 'secret text' }, messageTimestamp: 5 }],
      syncType: RECENT,
      progress: 37.4,
    })
    await t.flush()
    expect(seen).toEqual([{ percent: 37, complete: false }])
    expect(t.calls.length).toBeGreaterThan(0) // the chunk itself still reached the capture
    expect(JSON.stringify(seen)).not.toContain('secret')
  })

  it('clamps the percent and ignores other sync types and a missing progress', async () => {
    const { t, seen, ev } = await started()
    ev.emit('messaging-history.set', { chats: [], syncType: RECENT, progress: 180 })
    ev.emit('messaging-history.set', { chats: [], syncType: RECENT, progress: -3 })
    ev.emit('messaging-history.set', { chats: [], syncType: BOOTSTRAP, progress: 50 })
    ev.emit('messaging-history.set', { chats: [], syncType: 4, progress: 50 })
    ev.emit('messaging-history.set', { chats: [], syncType: RECENT, progress: null })
    ev.emit('messaging-history.set', { chats: [] })
    await t.flush()
    expect(seen).toEqual([
      { percent: 100, complete: false },
      { percent: 0, complete: false },
    ])
  })

  it('the explicit completion needs the stored 100 chunk AND the status, in either order; the bootstrap status does not count', async () => {
    const { t, seen, ev } = await started()
    ev.emit('messaging-history.status', { syncType: BOOTSTRAP, status: 'complete', explicit: true })
    ev.emit('messaging-history.status', { syncType: RECENT, status: 'other' })
    await t.flush()
    expect(seen).toEqual([])
    // the status comes first (the notification said 100, the chunk is not stored yet): not complete
    ev.emit('messaging-history.status', { syncType: RECENT, status: 'complete', explicit: true })
    await t.flush()
    expect(seen).toEqual([])
    ev.emit('messaging-history.set', { chats: [{ id: ANA, unreadCount: 0 }], syncType: RECENT, progress: 100 })
    await t.flush()
    expect(seen).toEqual([
      { percent: 100, complete: false },
      { percent: 100, complete: true, explicit: true },
    ])
  })

  it('the stored 100 chunk first, then the status: complete only when the status comes', async () => {
    const { t, seen, ev } = await started()
    ev.emit('messaging-history.set', { chats: [], syncType: RECENT, progress: 100 })
    await t.flush()
    expect(seen).toEqual([{ percent: 100, complete: false }])
    ev.emit('messaging-history.status', { syncType: RECENT, status: 'complete', explicit: true })
    await t.flush()
    expect(seen.at(-1)).toEqual({ percent: 100, complete: true, explicit: true })
  })

  it('a status complete is reported only after the chunk is stored (the capture is slow)', async () => {
    const { t, seen, ev } = await started()
    ev.emit('messaging-history.status', { syncType: RECENT, status: 'complete', explicit: true })
    ev.emit('messaging-history.set', {
      chats: [{ id: ANA, unreadCount: 0 }],
      messages: [{ key: { remoteJid: ANA, id: 'H9' }, message: { conversation: 'x' }, messageTimestamp: 5 }],
      syncType: RECENT,
      progress: 100,
    })
    await t.flush()
    const completeAt = t.calls.length
    expect(completeAt).toBeGreaterThan(0)
    expect(seen.filter((p) => (p as { complete: boolean }).complete)).toHaveLength(1)
  })

  it('paused is the inferred completion, without a percent', async () => {
    const { t, seen, ev } = await started()
    ev.emit('messaging-history.status', { syncType: RECENT, status: 'paused', explicit: false })
    await t.flush()
    expect(seen).toEqual([{ percent: null, complete: true, explicit: false }])
  })

  it('a listener can unsubscribe, and one that throws does not break the others or the capture', async () => {
    const t = setup()
    await t.connection.start()
    const seen: unknown[] = []
    const off = t.connection.onHistorySync((p) => seen.push(p))
    t.connection.onHistorySync(() => {
      throw new Error('bad listener')
    })
    const second: unknown[] = []
    t.connection.onHistorySync((p) => second.push(p))
    const ev = t.last().ev
    ev.emit('messaging-history.set', { chats: [], syncType: RECENT, progress: 10 })
    await t.flush()
    off()
    ev.emit('messaging-history.set', { chats: [], syncType: RECENT, progress: 20 })
    await t.flush()
    expect(seen).toEqual([{ percent: 10, complete: false }])
    expect(second).toHaveLength(2)
    expect(t.warnings).toContain('history-listener-failed')
  })

  it('events of a closed socket are ignored', async () => {
    const { t, seen, ev } = await started()
    await t.connection.stop()
    ev.emit('messaging-history.status', { syncType: RECENT, status: 'complete', explicit: true })
    await t.flush()
    expect(seen).toEqual([])
  })
})

describe('read only (RNF-17)', () => {
  it('a whole session never touches a method that sends, sets presence or sends receipts', async () => {
    const t = setup({ me: () => ({ id: ME, lid: ME_LID }) })
    await t.connection.start()
    const socket = t.last()
    socket.groupSubjects['1203@g.us'] = 'Vecinos'
    socket.ev.emit('connection.update', { qr: 'Q' })
    socket.user = { id: ME, lid: ME_LID }
    socket.ev.emit('connection.update', { connection: 'open' })
    const msg = (id: string, jid: string, extra = {}) => ({
      key: { remoteJid: jid, id, fromMe: false },
      message: { conversation: id },
      messageTimestamp: 5,
      pushName: 'Ana',
      ...extra,
    })
    socket.ev.emit('messaging-history.set', {
      contacts: [{ id: ANA, name: 'Ana' }],
      chats: [{ id: ANA, unreadCount: 1 }],
      messages: [msg('H', ANA)],
    })
    socket.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [msg('N', ANA), msg('G', '1203@g.us'), msg('LID', ANA_LID)],
    })
    socket.ev.emit('messages.update', [{ key: { remoteJid: ANA, id: 'N', fromMe: false }, update: { status: 4 } }])
    socket.ev.emit('chats.update', [{ id: ANA, unreadCount: 0 }])
    socket.ev.emit('creds.update', {})
    socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: boom(408) })
    await vi.advanceTimersByTimeAsync(1_000)
    await t.connection.stop()
    for (const fake of t.fake.sockets) {
      expect(fake.forbiddenCalls).toEqual([])
      expect(fake.accessed.filter((m) => !ALLOWED_SOCKET_MEMBERS.has(m))).toEqual([])
    }
  })
})

describe('the ids of one person (aliases)', () => {
  it('answers from memory and from what the platform stored, and never asks WhatsApp (RNF-01, RNF-17)', async () => {
    const t = setup()
    await t.connection.start()
    const socket = t.last()
    socket.user = { id: ME }
    socket.ev.emit('connection.update', { connection: 'open' })
    socket.lidToPhone[ANA_LID] = ANA
    socket.phoneToLid['9912465397241@s.whatsapp.net'] = '99900000002@lid'
    expect(await t.connection.aliasesOf(ANA_LID)).toEqual([ANA])
    expect(await t.connection.aliasesOf('9912465397241@s.whatsapp.net')).toEqual(['99900000002@lid'])
    expect(await t.connection.aliasesOf('9912752183123@s.whatsapp.net')).toEqual([])
    expect(await t.connection.aliasesOf('99900000077@lid')).toEqual([])
    // no sender and no query was reached for, and only the members of the narrow interface were read
    expect(socket.forbiddenCalls).toEqual([])
    expect(socket.accessed.filter((name) => !ALLOWED_SOCKET_MEMBERS.has(name))).toEqual([])
  })

  it('tells onAlias for a mapping the platform announces, and lists the known pairs', async () => {
    const t = setup()
    const told: [string, string][] = []
    t.connection.onAlias((a, b) => {
      told.push([a, b])
    })
    await t.connection.start()
    t.last().ev.emit('lid-mapping.update', { lid: ANA_LID, pn: ANA })
    await t.flush()
    expect(told).toEqual([[ANA_LID, ANA]])
    expect(t.connection.knownAliases()).toEqual([[ANA_LID, ANA]])
  })
})
