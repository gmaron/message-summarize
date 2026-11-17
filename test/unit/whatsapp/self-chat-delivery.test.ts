import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeliverPending } from '../../../src/application/deliver-pending.js'
import type { AccountIdentity } from '../../../src/application/ports/account-identity.js'
import { SqliteAccountIdentity } from '../../../src/infrastructure/persistence/sqlite/account.js'
import { SqliteDigestStore, SqliteOutboxRepository } from '../../../src/infrastructure/persistence/sqlite/index.js'
import {
  createWhatsAppConnection,
  DEFAULT_SEND_TIMEOUT_MS,
  OwnConversationIds,
  reconcileAccount,
  type SelfChatSource,
  WhatsAppSelfChatDelivery,
} from '../../../src/infrastructure/whatsapp/index.js'
import { FixedClock, InMemoryAccountIdentity, InMemoryOutbox } from '../../support/application-fakes.js'
import { TempDatabase } from '../../support/persistence-backends.js'
import { type FakeSocket, fakeSocket, fakeSocketFactory, recordingCapture } from '../../support/whatsapp-fakes.js'

const ME = '5491100000009@s.whatsapp.net'
const ME_DEVICE = '5491100000009:4@s.whatsapp.net'
const ME_LID = '99900000009@lid'
const OTHER_ACCOUNT = '5491100000077@s.whatsapp.net'
const ANA = '5491100000001@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'
const ANA_LID = '99900000001@lid'

/** A source that behaves like a connected connection over a fake socket. */
function connected(fake: FakeSocket): SelfChatSource {
  return {
    selfChat: () => ({
      get user() {
        return fake.socket.user
      },
      sendTextToSelf: (text) => fake.socket.sendTextToSelf(text),
    }),
  }
}

interface SetupOptions {
  /** The user the live socket reports. */
  readonly user?: FakeSocket['user']
  /** The account bound to the installation (null: none). */
  readonly bound?: string | null
}

function setup(options: SetupOptions = {}) {
  const fake = fakeSocket()
  fake.user = 'user' in options ? options.user : { id: ME_DEVICE, lid: ME_LID }
  const identity = new InMemoryAccountIdentity('bound' in options ? options.bound : ME)
  return { fake, identity, delivery: new WhatsAppSelfChatDelivery(connected(fake), identity) }
}

describe('WhatsAppSelfChatDelivery (RF-50, RF-51, RF-52)', () => {
  it('sends the text as it is to the own phone-number jid, once', async () => {
    const { fake, delivery } = setup()
    const text = '*Resumen*\n\n_Ana_: hola \u{1f600}\n'
    expect(await delivery.deliver(text)).toEqual({ ok: true, value: undefined })
    expect(fake.sent).toEqual([{ to: ME, text }])
  })

  it('is not connected when the connection has no live socket: error value, nothing sent', async () => {
    const delivery = new WhatsAppSelfChatDelivery({ selfChat: () => null }, new InMemoryAccountIdentity(ME))
    expect(await delivery.deliver('digest')).toEqual({ ok: false, error: 'notConnected' })
  })

  it.each([
    ['the jid of another account', { id: OTHER_ACCOUNT }],
    ['a group', { id: GROUP }],
    ['the LID of someone else', { id: ANA_LID }],
    ['a contact', { id: ANA }],
    ['an empty id', { id: '' }],
    ['no user', undefined],
    ['the own LID as id (never sent to a LID)', { id: ME_LID }],
  ])('rejects when the live account would be %s, and sends nothing', async (_name, user) => {
    const { fake, delivery } = setup({ user })
    expect(await delivery.deliver('private digest')).toEqual({ ok: false, error: 'rejected' })
    expect(fake.sent).toEqual([])
  })

  it('rejects when no account is bound, even for a valid phone-number user, and sends nothing', async () => {
    const { fake, delivery } = setup({ bound: null })
    expect(await delivery.deliver('digest')).toEqual({ ok: false, error: 'rejected' })
    expect(fake.sent).toEqual([])
  })

  it('compares against the account bound at the moment of each delivery', async () => {
    const { fake, identity, delivery } = setup({ bound: null })
    expect((await delivery.deliver('a')).ok).toBe(false)
    identity.bind(ME)
    expect((await delivery.deliver('b')).ok).toBe(true)
    expect(fake.sent).toEqual([{ to: ME, text: 'b' }])
  })

  it('reports an error value when the send fails, without leaking the message', async () => {
    const { fake, delivery } = setup()
    fake.sendFails = true
    expect(await delivery.deliver('digest')).toEqual({ ok: false, error: 'error' })
    expect(fake.sent).toEqual([])
  })

  it('touches nothing of the socket but the account and the one send method, and no sender is ever called', async () => {
    const { fake, delivery } = setup()
    await delivery.deliver('digest')
    expect(new Set(fake.accessed)).toEqual(new Set(['user', 'sendTextToSelf']))
    expect(fake.forbiddenCalls).toEqual([])
  })
})

describe('the send timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const hanging = (): SelfChatSource => ({
    selfChat: () => ({ user: { id: ME_DEVICE }, sendTextToSelf: () => new Promise<void>(() => undefined) }),
  })

  it('maps a send that never finishes to error after the configured time', async () => {
    const delivery = new WhatsAppSelfChatDelivery(hanging(), new InMemoryAccountIdentity(ME), { sendTimeoutMs: 5_000 })
    let result: unknown
    void delivery.deliver('digest').then((r) => {
      result = r
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toEqual({ ok: false, error: 'error' })
  })

  it('defaults to 60 seconds', async () => {
    expect(DEFAULT_SEND_TIMEOUT_MS).toBe(60_000)
    const delivery = new WhatsAppSelfChatDelivery(hanging(), new InMemoryAccountIdentity(ME))
    let result: unknown
    void delivery.deliver('digest').then((r) => {
      result = r
    })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toEqual({ ok: false, error: 'error' })
  })

  it('lets a hung send release DeliverPending, so the next run can try again', async () => {
    const outbox = new InMemoryOutbox()
    outbox.enqueue('one')
    let hang = true
    const sent: string[] = []
    const source: SelfChatSource = {
      selfChat: () => ({
        user: { id: ME_DEVICE },
        sendTextToSelf: async (text) => {
          if (hang) return new Promise<void>(() => undefined)
          sent.push(text)
        },
      }),
    }
    const deliver = new DeliverPending(
      outbox,
      new WhatsAppSelfChatDelivery(source, new InMemoryAccountIdentity(ME), { sendTimeoutMs: 1_000 }),
    )
    const first = deliver.run()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await first).toEqual({ delivered: 0, failure: 'error' })
    hang = false
    expect(await deliver.run()).toEqual({ delivered: 1, failure: null })
    expect(sent).toEqual(['one'])
  })

  it('does not leave a timer behind after a send that finishes', async () => {
    const source: SelfChatSource = {
      selfChat: () => ({ user: { id: ME_DEVICE }, sendTextToSelf: async () => undefined }),
    }
    const delivery = new WhatsAppSelfChatDelivery(source, new InMemoryAccountIdentity(ME))
    await delivery.deliver('digest')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('reconcileAccount', () => {
  it('binds the account of the socket when nothing is bound', () => {
    const identity = new InMemoryAccountIdentity()
    expect(reconcileAccount(identity, { id: ME_DEVICE, lid: ME_LID })).toBe('bound')
    expect(identity.get()).toBe(ME)
  })

  it('matches when the socket is the bound account, whatever the device', () => {
    const identity = new InMemoryAccountIdentity(ME)
    expect(reconcileAccount(identity, { id: '5491100000009:12@s.whatsapp.net' })).toBe('matches')
  })

  it('reports a mismatch for a different account and keeps the bound one', () => {
    const identity = new InMemoryAccountIdentity(ME)
    expect(reconcileAccount(identity, { id: OTHER_ACCOUNT })).toBe('mismatch')
    expect(identity.get()).toBe(ME)
  })

  it('reports noAccount, and binds nothing, for a socket without a phone-number user', () => {
    for (const user of [undefined, { id: '' }, { id: ME_LID }, { id: GROUP }]) {
      const identity = new InMemoryAccountIdentity()
      expect(reconcileAccount(identity, user)).toBe('noAccount')
      expect(identity.get()).toBeNull()
    }
  })

  it('reports a mismatch when another connection bound a different account first', () => {
    const racing = {
      get: () => null,
      bind: () => false,
    }
    expect(reconcileAccount(racing, { id: ME })).toBe('mismatch')
  })
})

describe('the connection hands out the send capability only while connected', () => {
  const dirs: string[] = []
  const temps: TempDatabase[] = []
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    for (const temp of temps.splice(0)) temp.dispose()
  })

  function connection(identity: AccountIdentity = new InMemoryAccountIdentity(ME)) {
    const dir = mkdtempSync(join(tmpdir(), 'message-summarize-auth-'))
    dirs.push(dir)
    const factory = fakeSocketFactory({ me: () => ({ id: ME_DEVICE, lid: ME_LID }) })
    const conn = createWhatsAppConnection({
      authDir: dir,
      language: 'en',
      capture: recordingCapture().capture,
      clock: new FixedClock(1_800_000_000_000),
      ownIds: new OwnConversationIds(),
      socketFactory: factory.factory,
    })
    return { conn, factory, identity, delivery: new WhatsAppSelfChatDelivery(conn, identity) }
  }

  const open = (socket: FakeSocket, user: FakeSocket['user']) => {
    socket.user = user
    socket.ev.emit('connection.update', { connection: 'open' })
  }

  it('is notConnected before connecting, while connecting, after a drop and after stop (the part stays queued)', async () => {
    const t = connection()
    expect(await t.delivery.deliver('a')).toEqual({ ok: false, error: 'notConnected' })
    await t.conn.start()
    expect(await t.delivery.deliver('b')).toEqual({ ok: false, error: 'notConnected' })
    const socket = t.factory.sockets[0] as FakeSocket
    open(socket, { id: ME_DEVICE, lid: ME_LID })
    expect(await t.delivery.deliver('c')).toEqual({ ok: true, value: undefined })
    socket.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    })
    expect(await t.delivery.deliver('d')).toEqual({ ok: false, error: 'notConnected' })
    await t.conn.stop()
    expect(await t.delivery.deliver('e')).toEqual({ ok: false, error: 'notConnected' })
    expect(socket.sent).toEqual([{ to: ME, text: 'c' }])
  })

  it('first link: the account is bound on connect, then the queued parts are delivered in order', async () => {
    const t = connection(new InMemoryAccountIdentity())
    const outbox = new InMemoryOutbox()
    outbox.enqueue('one', 'two')
    const deliver = new DeliverPending(outbox, t.delivery)
    await t.conn.start()
    const socket = t.factory.sockets[0] as FakeSocket
    open(socket, { id: ME_DEVICE, lid: ME_LID })
    expect(await deliver.run()).toEqual({ delivered: 0, failure: 'rejected' }) // not bound yet: nothing goes out
    expect(reconcileAccount(t.identity, t.conn.selfChat()?.user)).toBe('bound')
    expect(await deliver.run()).toEqual({ delivered: 2, failure: null })
    expect(socket.sent).toEqual([
      { to: ME, text: 'one' },
      { to: ME, text: 'two' },
    ])
    expect(await outbox.pending()).toEqual([])
  })

  it('not connected keeps the parts; connecting delivers them in order', async () => {
    const t = connection()
    const outbox = new InMemoryOutbox()
    outbox.enqueue('one', 'two')
    const deliver = new DeliverPending(outbox, t.delivery)
    expect(await deliver.run()).toEqual({ delivered: 0, failure: 'notConnected' })
    expect((await outbox.pending()).length).toBe(2)
    await t.conn.start()
    open(t.factory.sockets[0] as FakeSocket, { id: ME_DEVICE, lid: ME_LID })
    expect(await deliver.run()).toEqual({ delivered: 2, failure: null })
    expect(await outbox.pending()).toEqual([])
  })

  it('account A linked with parts queued, session cleared, QR scanned with phone B: nothing reaches B (RF-51)', async () => {
    // A real database: the binding and the queue survive the change of phone, as they would across a restart.
    const temp = new TempDatabase()
    temps.push(temp)
    const db = temp.open()
    const store = new SqliteDigestStore(db)
    const identity = new SqliteAccountIdentity(db)
    const t = connection(identity)

    // Phone A links: its account is bound, a digest is committed.
    await t.conn.start()
    const socketA = t.factory.sockets[0] as FakeSocket
    open(socketA, { id: ME_DEVICE, lid: ME_LID })
    expect(reconcileAccount(identity, t.conn.selfChat()?.user)).toBe('bound')
    await store.commit({ previousPointer: null, pointer: 1, digest: null, parts: ['private part 1', 'private part 2'] })

    // The session is cleared (logout) and the QR is scanned with phone B.
    await t.conn.clearSession()
    await t.conn.start()
    const socketB = t.factory.sockets[1] as FakeSocket
    expect(socketB).not.toBe(socketA)
    open(socketB, { id: '5491100000077:3@s.whatsapp.net', lid: '99900000077:3@lid' })

    expect(reconcileAccount(identity, t.conn.selfChat()?.user)).toBe('mismatch')
    expect(identity.get()).toBe(ME)
    const deliver = new DeliverPending(new SqliteOutboxRepository(store), t.delivery)
    expect(await deliver.run()).toEqual({ delivered: 0, failure: 'rejected' })
    expect(socketB.sent).toEqual([])
    expect(socketA.sent).toEqual([])
    expect(store.pendingOutbox().map((e) => e.text)).toEqual(['private part 1', 'private part 2'])

    // Phone A comes back (same account): the parts go out, to A.
    await t.conn.clearSession()
    await t.conn.start()
    const socketA2 = t.factory.sockets[2] as FakeSocket
    open(socketA2, { id: ME_DEVICE, lid: ME_LID })
    expect(reconcileAccount(identity, t.conn.selfChat()?.user)).toBe('matches')
    expect(await deliver.run()).toEqual({ delivered: 2, failure: null })
    expect(socketA2.sent).toEqual([
      { to: ME, text: 'private part 1' },
      { to: ME, text: 'private part 2' },
    ])
  })
})
