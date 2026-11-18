import type { CaptureMessages } from '../../application/capture-messages.js'
import type { Clock } from '../../application/ports/clock.js'
import type { Message, UnreadState } from '../../domain/model.js'
import type { Catalog } from '../i18n/index.js'
import { type ParsedContent, parseContent, parseEdit, parseEditedBody, toNumber, unwrap } from './content.js'
import { addressOf, isBroadcastJid, isGroupJid, isLid, isNewsletterJid, normalizeJid } from './jid.js'
import type { OwnConversationIds } from './own-ids.js'
import type {
  WaChat,
  WaContact,
  WaGroup,
  WaHistorySet,
  WaKey,
  WaMessage,
  WaMessagesUpsert,
  WaMessageUpdate,
} from './wa-types.js'

/** `WebMessageInfo.Status.READ`: the message was read (PLAYED, 5, is a read too, as in the previous tool). */
const STATUS_READ = 4
const GROUP_LOOKUP_RETRY_MS = 5 * 60_000
const EDIT_MEMORY = 1_000

export interface TranslatorPorts {
  readonly capture: CaptureMessages
  readonly catalog: Catalog
  readonly clock: Clock
  readonly ownIds: OwnConversationIds
  /** Baileys' own LID to phone number mapping, read from its memory and stored keys (local). Never throws (or the error is ignored). */
  readonly resolvePhoneNumber?: (lid: string) => Promise<string | null | undefined>
  /**
   * The other way round: the LID of a phone number, from what the platform has STORED. LOCAL ONLY (RNF-01, RNF-17): it must
   * never query WhatsApp. Never throws (or the error is ignored).
   */
  readonly resolveLid?: (phone: string) => Promise<string | null | undefined>
  /**
   * Told, and awaited, when a LID and a phone number are learned to be the same person (`a` is the LID, `b` the number).
   */
  readonly onAlias?: (a: string, b: string) => void | Promise<void>
  /**
   * Asks the platform for the subject of a group nobody told us about yet. Read only. Returns null when it asked and
   * got nothing, and undefined when it could not ask (no socket): that is not a failure and is not remembered.
   */
  readonly fetchGroupSubject?: (groupJid: string) => Promise<string | null | undefined>
  /**
   * The name of a conversation already stored, if any. The platform is asked for a group subject only when none is
   * stored, as the previous tool did. Never throws (or the error is ignored).
   */
  readonly storedConversationName?: (conversationId: string) => Promise<string | null | undefined>
  /** A failure inside the translation, as a fixed code. It never carries chat content. */
  readonly onWarning?: (code: 'event-failed' | 'item-failed') => void
}

/**
 * WhatsApp events into calls to the capture use case (RF-10 to RF-15). PURE with respect to the socket: it receives
 * payloads shaped like Baileys' and only talks to the use case. Platform concepts stop here: LIDs become phone numbers
 * when possible, the phone's unread counter becomes a domain unread state, an edit becomes `MessageEdited`.
 *
 * Handlers must be called one at a time, in the order the events arrived (the connection serializes them): the
 * history sync depends on contacts, chats and messages being processed in that order.
 *
 * What it never does: send anything, mark anything as read, touch presence. It has no way to: it holds no socket.
 */
export interface WhatsAppTranslator {
  /** The unread snapshot of this session is stamped with this time (the moment the connection opened). */
  beginSession(startedAt: number): void
  messagesUpsert(payload: WaMessagesUpsert): Promise<void>
  historySet(payload: WaHistorySet): Promise<void>
  messagesUpdate(updates: readonly WaMessageUpdate[]): Promise<void>
  chatsUpsert(chats: readonly WaChat[]): Promise<void>
  chatsUpdate(chats: readonly WaChat[]): Promise<void>
  groups(groups: readonly WaGroup[]): Promise<void>
  contacts(contacts: readonly WaContact[]): Promise<void>
  learnLidMapping(mapping: { lid: string; pn: string }): Promise<void>
  /** The other ids of the same person that are known (see `learn`). Local only: memory and the platform's STORED mapping. */
  aliasesOf(id: string): Promise<string[]>
  /** The pairs learned so far, `[lid, phone]`: memory only. */
  knownAliases(): [string, string][]
}

interface Located {
  readonly chatJid: string
  readonly isGroup: boolean
}

export function createTranslator(ports: TranslatorPorts): WhatsAppTranslator {
  const { capture, catalog, clock, ownIds } = ports

  // What the platform told us, kept in memory: LID to number, names, and which conversations the use case knows.
  const lidToPhone = new Map<string, string>()
  const groupNames = new Map<string, string>()
  const failedGroupLookups = new Map<string, number>()
  const chatNames = new Map<string, string>()
  const contactNames = new Map<string, string>()
  const announced = new Map<string, string | null>()
  const seenEdits = new Set<string>()
  let sessionStartedAt: number | null = null

  const warn = (code: 'event-failed' | 'item-failed'): void => ports.onWarning?.(code)

  /** Runs one item of a batch: one bad item never loses the rest, and nothing about it is logged. */
  async function each<T>(items: readonly T[] | null | undefined, work: (item: T) => Promise<void>): Promise<void> {
    for (const item of items ?? []) {
      try {
        await work(item)
      } catch {
        warn('item-failed')
      }
    }
  }

  // ---- identity (RF-13): LID to phone number --------------------------------------------------------------------

  /**
   * Remembers that a LID and a phone number are the same person. When the pair is NEW, `onAlias` is told and awaited:
   * whoever reacts (the host adds the privacy marks of one id to the other) is done before the event that taught
   * the pair goes on to the use case, so a chat that is marked under one id is already covered under the other when
   * its first message arrives under it. A failure of the listener is ignored here (the listener logs it).
   */
  async function learn(lid: string, phone: string): Promise<void> {
    const normalizedLid = normalizeJid(lid)
    const normalizedPhone = normalizeJid(phone)
    if (!isLid(normalizedLid) || isLid(normalizedPhone)) return
    const before = lidToPhone.get(normalizedLid)
    lidToPhone.set(normalizedLid, normalizedPhone)
    if (before === normalizedPhone) return
    try {
      await ports.onAlias?.(normalizedLid, normalizedPhone)
    } catch {
      // see above
    }
  }

  /**
   * The other ids of the same person as far as the platform has told us: the phone number of a LID, and the LIDs of a
   * phone number. Empty when nothing is known (then a mark covers the id it was made for, and no other).
   */
  async function aliasesOf(id: string): Promise<string[]> {
    const normalized = normalizeJid(id)
    const found = new Set<string>()
    if (isLid(normalized)) {
      const phone = lidToPhone.get(normalized) ?? (await ports.resolvePhoneNumber?.(normalized).catch(() => null))
      if (phone) found.add(normalizeJid(phone))
    } else {
      for (const [lid, phone] of lidToPhone) if (phone === normalized) found.add(lid)
      const lid = await ports.resolveLid?.(normalized).catch(() => null)
      if (lid) found.add(normalizeJid(lid))
    }
    found.delete(normalized)
    return [...found]
  }

  /**
   * The id the core uses for a person or chat: the phone-number JID. `alt` is the other form of the same id that
   * WhatsApp attaches to keys ("remoteJidAlt", "participantAlt"). Order: the alt form, what we learned, the
   * platform's own mapping, and finally the id as it came (a LID nobody can translate).
   */
  async function toPhone(jid: string, alt?: string | null): Promise<string> {
    const normalized = normalizeJid(jid)
    if (alt && !isLid(alt)) {
      const phone = normalizeJid(alt)
      if (isLid(normalized)) await learn(normalized, phone)
      return phone
    }
    if (!isLid(normalized)) {
      if (alt && isLid(alt)) await learn(alt, normalized)
      return normalized
    }
    const known = lidToPhone.get(normalized)
    if (known !== undefined) return known
    const resolved = await ports.resolvePhoneNumber?.(normalized).catch(() => null)
    if (resolved) {
      await learn(normalized, resolved)
      return lidToPhone.get(normalized) ?? normalized
    }
    return normalized
  }

  const isIgnored = (jid: string): boolean => isBroadcastJid(jid) || isNewsletterJid(jid)

  /** Where a chat is, or null for what the adapter never captures: status, broadcasts, newsletters, the own chat. */
  async function locate(jid: string | null | undefined, alt?: string | null): Promise<Located | null> {
    if (!jid || isIgnored(jid)) return null
    const chatJid = await toPhone(jid, alt)
    if (ownIds.has(chatJid) || ownIds.has(jid)) return null
    return { chatJid, isGroup: isGroupJid(chatJid) }
  }

  // ---- names (RF-13, RF-14) -------------------------------------------------------------------------------------

  async function conversationNameOf({ chatJid, isGroup }: Located, mayAsk: boolean): Promise<string | null> {
    if (!isGroup) return contactNames.get(chatJid) ?? chatNames.get(chatJid) ?? null
    const known = groupNames.get(chatJid)
    if (known !== undefined) return known
    if (!mayAsk || ports.fetchGroupSubject === undefined) return null
    const stored = await ports.storedConversationName?.(chatJid).catch(() => null)
    if (stored) {
      groupNames.set(chatJid, stored)
      return stored
    }
    const failedAt = failedGroupLookups.get(chatJid)
    if (failedAt !== undefined && clock.now() - failedAt < GROUP_LOOKUP_RETRY_MS) return null
    const subject = await ports.fetchGroupSubject(chatJid).catch(() => null)
    if (subject === undefined) return null // could not ask: try again next time
    if (subject) {
      groupNames.set(chatJid, subject)
      failedGroupLookups.delete(chatJid)
      return subject
    }
    failedGroupLookups.set(chatJid, clock.now())
    return null
  }

  /** Tells the use case about a conversation: its name and address, once per change. Nothing for a null name twice. */
  async function announce({ chatJid, isGroup }: Located, name: string | null): Promise<void> {
    const previous = announced.get(chatJid)
    if (previous === name || (previous !== undefined && name === null)) return
    announced.set(chatJid, name)
    await capture.conversationMetadata({
      conversation: {
        id: chatJid,
        isGroup,
        name,
        participantId: isGroup ? null : chatJid,
        address: isGroup ? chatJid : addressOf(chatJid),
      },
    })
  }

  function rememberChatName(located: Located, name: string | null | undefined): void {
    if (!name) return
    if (located.isGroup) groupNames.set(located.chatJid, name)
    else chatNames.set(located.chatJid, name)
  }

  // ---- contacts -------------------------------------------------------------------------------------------------

  /**
   * The address book arrives identified by phone number, by LID or both. The person is stored under the id their
   * chat will have (the phone number when it is known), once per distinct id.
   */
  async function saveContact(contact: WaContact): Promise<void> {
    const raw = [contact.id, contact.lid, contact.phoneNumber].filter((jid): jid is string => !!jid && !isIgnored(jid))
    // A pair in the same record is a mapping worth keeping.
    if (contact.lid && contact.phoneNumber) await learn(contact.lid, contact.phoneNumber)
    if (contact.id && contact.phoneNumber) await learn(contact.id, contact.phoneNumber)
    if (contact.id && contact.lid) await learn(contact.lid, contact.id)
    const ids = new Set<string>()
    for (const jid of raw) ids.add(await toPhone(jid))
    const savedName = contact.name ?? null
    const publicName = contact.notify ?? contact.verifiedName ?? null
    if (savedName === null && publicName === null) return
    for (const id of ids) {
      if (isGroupJid(id) || ownIds.has(id)) continue
      const display = savedName ?? publicName
      if (display) contactNames.set(id, display)
      await capture.participantInfo({ participant: { id, savedName, publicName } })
    }
  }

  // ---- messages (RF-10, RF-11) ----------------------------------------------------------------------------------

  /** Epoch ms of a message timestamp in seconds, or null when it has none. */
  const timestampMs = (seconds: WaMessage['messageTimestamp']): number | null => {
    const n = toNumber(seconds)
    return n === null ? null : n * 1000
  }

  interface Author {
    readonly fromMe: boolean
    readonly senderId: string | null
    readonly senderName: string | null
    readonly senderAddress: string | null
    readonly sender: { id: string; savedName: null; publicName: string } | undefined
  }

  async function authorOf(key: WaKey, located: Located, pushName: string | null | undefined): Promise<Author> {
    const fromMe = Boolean(key.fromMe)
    if (fromMe) return { fromMe, senderId: null, senderName: null, senderAddress: null, sender: undefined }
    const senderId = located.isGroup
      ? key.participant
        ? await toPhone(key.participant, key.participantAlt)
        : null
      : located.chatJid
    const senderName = pushName || null
    return {
      fromMe,
      senderId,
      senderName,
      senderAddress: senderId === null ? null : addressOf(senderId),
      sender:
        senderId !== null && senderName !== null
          ? { id: senderId, savedName: null, publicName: senderName }
          : undefined,
    }
  }

  const buildMessage = (
    id: string,
    located: Located,
    author: Author,
    timestamp: number,
    parsed: ParsedContent,
  ): Message => ({
    id,
    conversationId: located.chatJid,
    senderId: author.senderId,
    senderName: author.senderName,
    senderAddress: author.senderAddress,
    fromMe: author.fromMe,
    timestamp,
    kind: parsed.kind,
    text: parsed.text,
    transcript: null,
    read: false,
  })

  /**
   * An edit is processed once even if the platform reports it through two events (the protocol message in
   * messages.upsert and the update in messages.update). The two carry slightly different timestamps, so the key is
   * the content: the chat, the original id and the edited text. Repeating the same text would change nothing anyway.
   */
  function firstSightOfEdit(chatJid: string, originalId: string, editor: Author, editedText: string): boolean {
    // The editor is part of the key: a forged edit with the same text must not hide the real author's edit.
    const key = `${chatJid}\n${originalId}\n${editor.fromMe ? 'me' : (editor.senderId ?? '')}\n${editedText}`
    if (seenEdits.has(key)) return false
    seenEdits.add(key)
    if (seenEdits.size > EDIT_MEMORY) {
      const oldest = seenEdits.values().next().value
      if (oldest !== undefined) seenEdits.delete(oldest)
    }
    return true
  }

  async function handleMessage(msg: WaMessage, origin: 'live' | 'history'): Promise<void> {
    const key = msg.key
    if (!key?.remoteJid || !key.id || !msg.message) return
    const located = await locate(key.remoteJid, key.remoteJidAlt)
    if (located === null) return
    const content = unwrap(msg.message)
    if (content === null) return
    const timestamp = timestampMs(msg.messageTimestamp)
    if (timestamp === null) return

    const edit = parseEdit(content, catalog)
    const parsed = edit?.parsed ?? parseContent(content, catalog)
    if (parsed === null) return // reactions, protocol messages, key distribution, empty texts

    const author = await authorOf(key, located, msg.pushName)
    const conversationName = await conversationNameOf(located, origin === 'live')
    await announce(located, conversationName)
    const context = {
      isGroup: located.isGroup,
      conversationName,
      ...(author.sender === undefined ? {} : { sender: author.sender }),
    }

    if (edit !== null) {
      // `author` here is the EDITOR (the key of the protocol message), not the author of the original. The edit
      // carries it as the message's sender so the repository can apply the edit only when it matches the original's
      // author (RF-11): a group member cannot rewrite another member's message by referencing its id.
      if (!firstSightOfEdit(located.chatJid, edit.originalId, author, parsed.text)) return
      await capture.editMessage({
        ...context,
        message: buildMessage(edit.originalId, located, author, timestamp, parsed),
        editedAt: timestamp,
      })
      return
    }
    await capture.receiveMessage({
      ...context,
      message: buildMessage(key.id, located, author, timestamp, parsed),
      origin,
    })
  }

  /** An edit as `messages.update` reports it: the key of the ORIGINAL, and the edited content. */
  async function handleEditUpdate({ key, update }: WaMessageUpdate): Promise<boolean> {
    const edited = update?.message?.editedMessage?.message
    if (!key?.remoteJid || !key.id || !edited) return false
    const located = await locate(key.remoteJid, key.remoteJidAlt)
    if (located === null) return true
    const edit = parseEditedBody(key.id, edited, catalog)
    if (edit === null) return true
    const editedAt = timestampMs(update?.messageTimestamp) ?? clock.now()
    const author = await authorOf(key, located, null)
    if (!firstSightOfEdit(located.chatJid, edit.originalId, author, edit.parsed.text)) return true
    const conversationName = await conversationNameOf(located, true)
    await announce(located, conversationName)
    await capture.editMessage({
      isGroup: located.isGroup,
      conversationName,
      message: buildMessage(edit.originalId, located, author, editedAt, edit.parsed),
      editedAt,
    })
    return true
  }

  // ---- unread (RF-12) -------------------------------------------------------------------------------------------

  /** The phone's counter as a domain state: positive = that many, -1 or "marked as unread" = by hand, else 0. */
  function unreadStateOf(chat: WaChat): UnreadState {
    const count = chat.unreadCount ?? 0
    if (count > 0) return { kind: 'count', count }
    return count === -1 || chat.markedAsUnread ? { kind: 'markedUnread' } : { kind: 'count', count: 0 }
  }

  async function handleChatName(chat: WaChat, located: Located): Promise<void> {
    if (!chat.name) return
    rememberChatName(located, chat.name)
    await announce(located, chat.name)
  }

  return {
    beginSession(startedAt) {
      sessionStartedAt = startedAt
    },

    // messages.upsert: whatever its type ('notify', or 'append' for what was delivered while we were offline), it
    // arrived while connected: live, as the previous tool treated it. Only messaging-history.set is history.
    async messagesUpsert({ messages }) {
      await each(messages, (msg) => handleMessage(msg, 'live'))
    },

    // History: contacts, then chats (names and the unread snapshot), then messages, so names are known first.
    async historySet({ chats, contacts, messages, lidPnMappings }) {
      for (const { lid, pn } of lidPnMappings ?? []) await learn(lid, pn)
      await each(contacts, saveContact)
      const startedAt = sessionStartedAt ?? clock.now()
      await each(chats, async (chat) => {
        const located = await locate(chat.id)
        if (located === null) return
        await handleChatName(chat, located)
        await capture.unreadSnapshot({
          conversationId: located.chatJid,
          isGroup: located.isGroup,
          conversationName: await conversationNameOf(located, false),
          state: unreadStateOf(chat),
          snapshotStartedAt: startedAt,
        })
      })
      await each(messages, (msg) => handleMessage(msg, 'history'))
    },

    // messages.update: an edit (protocol message edit), or the owner reading a message from another device.
    async messagesUpdate(updates) {
      const reads = new Map<string, { located: Located; ids: string[] }>()
      await each(updates, async (item) => {
        if (await handleEditUpdate(item)) return
        const { key, update } = item
        const status = update?.status
        if (!key?.id || !key.remoteJid || key.fromMe) return
        if (typeof status !== 'number' || status < STATUS_READ) return
        const located = await locate(key.remoteJid, key.remoteJidAlt)
        if (located === null) return
        const entry = reads.get(located.chatJid) ?? { located, ids: [] }
        entry.ids.push(key.id)
        reads.set(located.chatJid, entry)
      })
      for (const { located, ids } of reads.values()) {
        try {
          await capture.messagesRead({
            conversationId: located.chatJid,
            isGroup: located.isGroup,
            conversationName: await conversationNameOf(located, false),
            messageIds: ids,
          })
        } catch {
          warn('item-failed')
        }
      }
    },

    async chatsUpsert(chats) {
      await each(chats, async (chat) => {
        const located = await locate(chat.id)
        if (located !== null) await handleChatName(chat, located)
      })
    },

    // chats.update: a name, and the live unread counter. Only 0 (read) and -1 (marked unread) say something the
    // adapter can't compute itself: positive counts are kept by the capture from the messages it receives.
    async chatsUpdate(chats) {
      await each(chats, async (chat) => {
        const located = await locate(chat.id)
        if (located === null) return
        await handleChatName(chat, located)
        if (chat.unreadCount !== 0 && chat.unreadCount !== -1) return
        await capture.unreadChanged({
          conversationId: located.chatJid,
          isGroup: located.isGroup,
          conversationName: await conversationNameOf(located, false),
          state: unreadStateOf(chat),
        })
      })
    },

    async groups(groups) {
      await each(groups, async (group) => {
        const located = await locate(group.id)
        if (located === null || !located.isGroup || !group.subject) return
        groupNames.set(located.chatJid, group.subject)
        await announce(located, group.subject)
      })
    },

    async contacts(contacts) {
      await each(contacts, saveContact)
    },

    learnLidMapping: ({ lid, pn }) => learn(lid, pn),
    aliasesOf,
    knownAliases: () => [...lidToPhone],
  }
}
