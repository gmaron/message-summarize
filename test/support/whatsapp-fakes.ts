import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { CaptureMessages } from '../../src/application/capture-messages.js'
import type { WhatsAppSocket } from '../../src/infrastructure/whatsapp/connection.js'
import type { SocketFactory, SocketSession } from '../../src/infrastructure/whatsapp/index.js'
import { selfChatJid } from '../../src/infrastructure/whatsapp/jid.js'

/** Every call of the capture use case, in order, with the method name. */
export interface RecordedCall {
  readonly method: keyof CaptureMessages
  readonly event: unknown
}

/** A CaptureMessages that records what the adapter asks of it. */
export function recordingCapture(): { capture: CaptureMessages; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const record =
    <K extends keyof CaptureMessages>(method: K) =>
    async (event: unknown) => {
      calls.push({ method, event })
      return undefined as never
    }
  const capture: CaptureMessages = {
    receiveMessage: async (event) => {
      calls.push({ method: 'receiveMessage', event })
      return { stored: true, isNew: true, downloadAudio: false }
    },
    editMessage: async (event) => {
      calls.push({ method: 'editMessage', event })
      return 'inserted'
    },
    messagesRead: record('messagesRead'),
    unreadChanged: record('unreadChanged'),
    unreadSnapshot: record('unreadSnapshot'),
    conversationMetadata: record('conversationMetadata'),
    participantInfo: record('participantInfo'),
    transcriptReady: record('transcriptReady'),
    queueMedia: record('queueMedia'),
    mediaFailed: record('mediaFailed'),
  }
  return { capture, calls }
}

/** Methods of a real socket that send, change presence, or send receipts. The adapter must never reach for them. */
export const FORBIDDEN_SOCKET_METHODS = [
  'sendMessage',
  'relayMessage',
  'sendPresenceUpdate',
  'presenceSubscribe',
  'readMessages',
  'sendReceipt',
  'sendReceipts',
  'sendPeerDataOperationMessage',
  'updateMediaMessage',
  'updateProfileStatus',
  'groupParticipantsUpdate',
  'chatModify',
  'query',
  'sendNode',
] as const

/** What the adapter is allowed to touch on a socket. */
const ALLOWED_SOCKET_MEMBERS = new Set([
  'ev',
  'user',
  'end',
  'groupMetadata',
  'signalRepository',
  'sendTextToSelf',
  'openAudio',
])

export interface FakeSocket {
  /** The object handed to the adapter: a proxy that records every member read, allowed or not. */
  readonly socket: WhatsAppSocket
  readonly ev: EventEmitter
  /** Every member the adapter read, in order. */
  readonly accessed: string[]
  readonly ended: { count: number }
  /** Names of forbidden methods that were called (the proxy invents them, as spies, so they can be called). */
  readonly forbiddenCalls: string[]
  user: { id: string; lid?: string } | undefined
  groupSubjects: Record<string, string>
  lidToPhone: Record<string, string>
  groupQueries: string[]
  /** What `sendTextToSelf` sent. `to` is where the real wrapper would send it: the own phone-number JID of `user`. */
  sent: { to: string; text: string }[]
  /** Makes `sendTextToSelf` reject, as a failed send does. */
  sendFails: boolean
  /** What `openAudio` streams. Null: the media is gone and the download fails. */
  audioBytes: Buffer | null
  /** The descriptors `openAudio` was asked to open. */
  audioRequests: unknown[]
  /** When set, `openAudio` throws it (a Boom with a status, for instance). */
  audioFailure: unknown
  listenerCount(): number
}

/** A socket made of an EventEmitter. Any member outside the narrow interface is recorded, and calling a sender fails. */
export function fakeSocket(): FakeSocket {
  const ev = new EventEmitter()
  ev.setMaxListeners(100)
  const accessed: string[] = []
  const forbiddenCalls: string[] = []
  const ended = { count: 0 }
  const state: FakeSocket = {
    socket: undefined as unknown as WhatsAppSocket,
    ev,
    accessed,
    ended,
    forbiddenCalls,
    user: undefined,
    groupSubjects: {},
    lidToPhone: {},
    groupQueries: [],
    sent: [],
    sendFails: false,
    audioBytes: Buffer.from('fake ogg bytes'),
    audioRequests: [],
    audioFailure: undefined,
    listenerCount: () => ev.eventNames().reduce((sum, name) => sum + ev.listenerCount(name), 0),
  }
  const target: Record<string, unknown> = {
    ev: { on: (e: string, l: never) => ev.on(e, l), off: (e: string, l: never) => ev.off(e, l) },
    end: () => {
      ended.count++
    },
    groupMetadata: async (jid: string) => {
      state.groupQueries.push(jid)
      const subject = state.groupSubjects[jid]
      if (subject === undefined) throw new Error('not found')
      return { subject }
    },
    // What the audio download gives: a stream of the bytes in `audioBytes` (or an error when it is null).
    openAudio: async (message: unknown) => {
      state.audioRequests.push(message)
      if (state.audioFailure !== undefined) throw state.audioFailure
      if (state.audioBytes === null) throw new Error('media gone')
      return Readable.from([state.audioBytes])
    },
    // Like the real wrapper: the destination comes from `user`, never from the caller.
    sendTextToSelf: async (text: string) => {
      const to = selfChatJid(state.user)
      if (to === null) throw new Error('no authenticated phone-number user')
      if (state.sendFails) throw new Error('send failed')
      state.sent.push({ to, text })
    },
    signalRepository: {
      lidMapping: { getPNForLID: async (lid: string) => state.lidToPhone[lid] ?? null },
    },
  }
  for (const name of FORBIDDEN_SOCKET_METHODS) {
    target[name] = () => {
      forbiddenCalls.push(name)
      throw new Error(`The adapter called ${name}`)
    }
  }
  const proxy = new Proxy(target, {
    get(_t, prop) {
      if (typeof prop === 'string') {
        accessed.push(prop)
        if (prop === 'user') return state.user
      }
      return typeof prop === 'string' ? target[prop] : undefined
    },
  })
  ;(state as { socket: WhatsAppSocket }).socket = proxy as unknown as WhatsAppSocket
  return state
}

export { ALLOWED_SOCKET_MEMBERS }

/** A socket factory that hands out a new fake socket per attempt, and remembers them all. */
export function fakeSocketFactory(
  options: { me?: SocketSession['me']; fail?: boolean; settle?: () => Promise<void> | undefined } = {},
): {
  factory: SocketFactory
  sockets: FakeSocket[]
  saved: { count: number }
  calls: { authDir: string }[]
} {
  const sockets: FakeSocket[] = []
  const saved = { count: 0 }
  const calls: { authDir: string }[] = []
  const factory: SocketFactory = async (factoryOptions) => {
    calls.push(factoryOptions)
    if (options.fail) throw new Error('disk on fire')
    const fake = fakeSocket()
    sockets.push(fake)
    return {
      socket: fake.socket,
      settle: async () => options.settle?.(),
      saveCreds: async () => {
        saved.count++
      },
      me: options.me ?? (() => undefined),
    }
  }
  return { factory, sockets, saved, calls }
}
