import './console-guard.js'
import type { Readable } from 'node:stream'
import makeWASocket, {
  type AuthenticationState,
  type BaileysEventMap,
  Browsers,
  DEF_MEDIA_HOST,
  downloadContentFromMessage,
} from 'baileys'
import { loadSecureAuthState } from './auth-state.js'
import type { SocketFactory, WhatsAppSocket } from './connection.js'
import { normalizeJid, selfChatJid } from './jid.js'
import { type AudioDescriptor, isSafeDirectPath } from './media.js'
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
 * - `syncFullHistory: false`: only what WhatsApp sends on linking (the recent history), as the previous tool did. The ONE
 *   exception is the opt-in `fullHistoryOnLink` of an account (approved by the owner as an exception to RNF-17, see
 *   docs/requirements.md): the socket is then made with `syncFullHistory: true`, which only changes how much history the
 *   phone sends when the device is linked. The browser stays a desktop one, which WhatsApp requires to send it.
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

/**
 * Opens the audio of a received message as a stream of its decrypted bytes (RF-15). It is a download from WhatsApp's
 * media servers: nothing is sent to anyone. No download context is given on purpose: with one, Baileys answers a media
 * that has expired by asking the sender to upload it again, which is a message out (RNF-17). Without it an expired
 * media is just an error, and the audio is left untranscribed.
 */
async function openAudio(descriptor: AudioDescriptor): Promise<Readable> {
  // Baileys builds the address from the `url` and `directPath` of the message, which the SENDER writes: left alone, a
  // sender could make this program fetch any host or LAN address (and learn that we did). So the host is fixed here to
  // WhatsApp's own media host (`DEF_MEDIA_HOST`, "mmg.whatsapp.net", in baileys/lib/Utils/messages-media.js), the `url`
  // is never given (only `directPath` and the key), and the path must be a plain path. The fetcher checks the same
  // before it gets here; this is the second lock.
  if (!isSafeDirectPath(descriptor.directPath)) throw new Error('invalid-media-path')
  return downloadContentFromMessage({ mediaKey: descriptor.mediaKey, directPath: descriptor.directPath }, 'audio', {
    host: DEF_MEDIA_HOST,
  })
}

/** The LID Baileys has STORED for a phone-number JID, from the auth state on disk. Never asks WhatsApp. */
async function storedLid(state: AuthenticationState, pn: string): Promise<string | null> {
  const user = normalizeJid(pn).split('@')[0] ?? ''
  if (user === '') return null
  const stored = await state.keys.get('lid-mapping', [user])
  const lidUser = stored[user]
  return typeof lidUser === 'string' && lidUser !== '' ? `${lidUser}@lid` : null
}

export const baileysSocketFactory: SocketFactory = async ({ authDir, fullHistory }) => {
  const { state, saveCreds, settle } = await loadSecureAuthState(authDir)
  const socket = makeWASocket({
    auth: state,
    logger: silentLogger,
    browser: BROWSER,
    ...BAILEYS_SOCKET_OPTIONS,
    // Only the opt-in of the account (`fullHistoryOnLink`) turns this on.
    ...(fullHistory === true ? { syncFullHistory: true } : {}),
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
    openAudio,
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
