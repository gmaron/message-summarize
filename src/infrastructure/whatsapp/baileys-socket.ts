import './console-guard.js'
import makeWASocket, { type BaileysEventMap, Browsers } from 'baileys'
import { loadSecureAuthState } from './auth-state.js'
import type { SocketFactory, WhatsAppSocket } from './connection.js'
import type { WaChat, WaContact, WaGroup, WaHistorySet, WaMessagesUpsert, WaMessageUpdate } from './wa-types.js'

/**
 * The ONE place that creates a Baileys socket, and so the place where its configuration is fixed (RNF-17, RNF-04).
 *
 * - `markOnlineOnConnect: false`: the client is not shown as online, so the phone keeps getting notifications.
 * - `syncFullHistory: false`: only what WhatsApp sends on linking (the recent history), as the previous tool did.
 * - The logger is silent. Baileys logs message content, keys and session data at several levels; none of it may reach
 *   a log (RNF-04), so it all goes nowhere.
 *
 * The adapter never calls a method that sends, changes presence or sends read receipts, and `WhatsAppSocket` does not
 * even have them.
 */
export const BAILEYS_SOCKET_OPTIONS = {
  markOnlineOnConnect: false,
  syncFullHistory: false,
} as const

/** Browser name shown in "linked devices" on the phone. */
const BROWSER = Browsers.macOS('message-summarize')

type BaileysLogger = NonNullable<Parameters<typeof makeWASocket>[0]['logger']>

const silentLogger: BaileysLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

export const baileysSocketFactory: SocketFactory = async ({ authDir }) => {
  const { state, saveCreds, settle } = await loadSecureAuthState(authDir)
  const socket = makeWASocket({
    auth: state,
    logger: silentLogger,
    browser: BROWSER,
    ...BAILEYS_SOCKET_OPTIONS,
  })
  // A real wrapper, not a cast: the full Baileys socket (with its send methods) never leaves this function.
  const narrow: WhatsAppSocket = {
    ev: {
      on: (event, listener) => socket.ev.on(event as never, listener as never),
      off: (event, listener) => socket.ev.off(event as never, listener as never),
    },
    get user() {
      return socket.user
    },
    end: (error) => socket.end(error),
    groupMetadata: (jid) => socket.groupMetadata(jid),
    signalRepository: {
      lidMapping: { getPNForLID: (lid) => socket.signalRepository.lidMapping.getPNForLID(lid) },
    },
  }
  return { socket: narrow, saveCreds, settle, me: () => state.creds.me }
}

/**
 * Compile-time check that the payloads of Baileys are assignable to the structural types the translation reads. If a
 * Baileys upgrade changes a shape, this stops compiling instead of failing at run time.
 */
type Assignable<From, To> = [From] extends [To] ? true : never
export const payloadShapes: [
  Assignable<BaileysEventMap['messages.upsert'], WaMessagesUpsert>,
  Assignable<BaileysEventMap['messaging-history.set'], WaHistorySet>,
  Assignable<BaileysEventMap['messages.update'], readonly WaMessageUpdate[]>,
  Assignable<BaileysEventMap['chats.upsert'], readonly WaChat[]>,
  Assignable<BaileysEventMap['chats.update'], readonly WaChat[]>,
  Assignable<BaileysEventMap['contacts.upsert'], readonly WaContact[]>,
  Assignable<BaileysEventMap['contacts.update'], readonly WaContact[]>,
  Assignable<BaileysEventMap['lid-mapping.update'], { lid: string; pn: string }>,
  Assignable<BaileysEventMap['groups.upsert'], readonly WaGroup[]>,
  Assignable<BaileysEventMap['groups.update'], readonly WaGroup[]>,
] = [true, true, true, true, true, true, true, true, true, true]
