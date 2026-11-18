import './console-guard.js'
import makeWASocket, { type AuthenticationState, type BaileysEventMap, Browsers } from 'baileys'
import { loadSecureAuthState } from './auth-state.js'
import type { SocketFactory, WhatsAppSocket } from './connection.js'
import { normalizeJid, selfChatJid } from './jid.js'
import type {
  WaChat,
  WaContact,
  WaGroup,
  WaHistorySet,
  WaHistoryStatus,
  WaMessagesUpsert,
  WaMessageUpdate,
} from './wa-types.js'

/**
 * The ONE place that creates a Baileys socket, and so the place where its configuration is fixed (RNF-17, RNF-04).
 *
 * - `markOnlineOnConnect: false`: the client is not shown as online, so the phone keeps getting notifications.
 * - `syncFullHistory: false`: only what WhatsApp sends on linking (the recent history), as the previous tool did.
 * - The logger is silent. Baileys logs message content, keys and session data at several levels; none of it may reach
 *   a log (RNF-04), so it all goes nowhere.
 *
 * The adapter never changes presence or sends read receipts, and `WhatsAppSocket` does not even have those. The only
 * thing it can send is a text to the account's own chat, through `sendTextToSelf`.
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

type BaileysSocket = ReturnType<typeof makeWASocket>

/**
 * The ONLY function in the adapter that sends anything (RF-51, RNF-17). The destination is the phone-number JID of the
 * authenticated user, computed here; it is never a parameter and never the LID. Plain text only: it sets no presence
 * and sends no read receipt. The read-only guard test allows `sendMessage` inside this function and nowhere else.
 */
async function sendTextToSelf(socket: BaileysSocket, text: string): Promise<void> {
  const jid = selfChatJid(socket.user)
  if (jid === null) throw new Error('no authenticated phone-number user')
  await socket.sendMessage(jid, { text, linkPreview: null })
}

/** The LID Baileys has STORED for a phone-number JID, from the auth state on disk. Never asks WhatsApp. */
async function storedLid(state: AuthenticationState, pn: string): Promise<string | null> {
  const user = normalizeJid(pn).split('@')[0] ?? ''
  if (user === '') return null
  const stored = await state.keys.get('lid-mapping', [user])
  const lidUser = stored[user]
  return typeof lidUser === 'string' && lidUser !== '' ? `${lidUser}@lid` : null
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
    sendTextToSelf: (text) => sendTextToSelf(socket, text),
    groupMetadata: (jid) => socket.groupMetadata(jid),
    signalRepository: {
      lidMapping: {
        // LOCAL lookup (RNF-01, RNF-17): `_getPNsForLIDsImpl` (baileys/lib/Signal/lid-mapping.js) reads its memory cache and
        // the stored keys and never calls `pnToLIDFunc`, the only path of that file that queries WhatsApp.
        getPNForLID: (lid) => socket.signalRepository.lidMapping.getPNForLID(lid),
        // The other way is NOT `getLIDForPN`: that one falls back to a USync query to WhatsApp's servers when the number is
        // not stored. This reads the stored mapping only (key `<number user>` of the `lid-mapping` store).
        storedLidForPN: (pn) => storedLid(state, pn),
      },
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
  Assignable<BaileysEventMap['messaging-history.status'], WaHistoryStatus>,
  Assignable<BaileysEventMap['messages.update'], readonly WaMessageUpdate[]>,
  Assignable<BaileysEventMap['chats.upsert'], readonly WaChat[]>,
  Assignable<BaileysEventMap['chats.update'], readonly WaChat[]>,
  Assignable<BaileysEventMap['contacts.upsert'], readonly WaContact[]>,
  Assignable<BaileysEventMap['contacts.update'], readonly WaContact[]>,
  Assignable<BaileysEventMap['lid-mapping.update'], { lid: string; pn: string }>,
  Assignable<BaileysEventMap['groups.upsert'], readonly WaGroup[]>,
  Assignable<BaileysEventMap['groups.update'], readonly WaGroup[]>,
] = [true, true, true, true, true, true, true, true, true, true, true]
