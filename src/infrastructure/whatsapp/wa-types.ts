/**
 * The part of the Baileys event payloads that the adapter reads, as structural types. The pure translation depends on
 * these and not on Baileys, so it is tested with plain objects. Baileys' own types are assignable to them (checked at
 * the one place where the real socket is wired: `baileys-socket.ts`).
 */

/** Seconds or milliseconds as number, a protobuf Long, a bigint or a numeric string. */
export type WaNumber = number | bigint | string | { toNumber(): number } | null | undefined

export interface WaKey {
  remoteJid?: string | null
  remoteJidAlt?: string | null
  fromMe?: boolean | null
  id?: string | null
  participant?: string | null
  participantAlt?: string | null
}

/** `contextInfo` of a message: what it replies to, and whether it was forwarded. */
export interface WaContextInfo {
  stanzaId?: string | null
  participant?: string | null
  quotedMessage?: WaContent | null
  /** The chat of the quoted message: `status@broadcast` for a reply to a status. */
  remoteJid?: string | null
  isForwarded?: boolean | null
  forwardingScore?: number | null
}

/** What every message with media shares (an image, a video, a document, a sticker, an audio). */
export interface WaMediaFields {
  mimetype?: string | null
  fileLength?: WaNumber
  seconds?: number | null
  fileName?: string | null
  title?: string | null
  pageCount?: number | null
  width?: number | null
  height?: number | null
  caption?: string | null
  viewOnce?: boolean | null
  contextInfo?: WaContextInfo | null
}

/** A protobuf message, as loosely as it is read: the kind is whichever field is set. */
export interface WaContent {
  conversation?: string | null
  extendedTextMessage?: { text?: string | null; contextInfo?: WaContextInfo | null } | null
  imageMessage?: WaMediaFields | null
  videoMessage?: WaMediaFields | null
  /**
   * What is read of an audio. ALL of it is written by the sender, so none of it is trusted: `fileLength` (bytes, to refuse
   * a huge download), `mimetype` (to pick the format), `directPath` (where on WhatsApp's media host the file is: checked
   * with `isSafeDirectPath`), `mediaKey` (the decryption key of the file: a secret, stored only in the account database).
   * `url` is never used: it could point anywhere.
   */
  audioMessage?:
    | (WaMediaFields & {
        directPath?: string | null
        mediaKey?: Uint8Array | string | null
        url?: string | null
      })
    | null
  documentMessage?: WaMediaFields | null
  stickerMessage?: WaMediaFields | null
  locationMessage?: WaLocation | null
  liveLocationMessage?: WaLocation | null
  contactMessage?: WaContact1 | null
  contactsArrayMessage?: { contacts?: (WaContact1 | null)[] | null; contextInfo?: WaContextInfo | null } | null
  reactionMessage?: { key?: WaKey | null; text?: string | null; senderTimestampMs?: WaNumber } | null
  /** A vote on a poll (encrypted). */
  pollUpdateMessage?: { pollCreationMessageKey?: WaKey | null; senderTimestampMs?: WaNumber } | null
  orderMessage?: WaOrder | null
  productMessage?: { product?: WaProduct | null; contextInfo?: WaContextInfo | null } | null
  pollCreationMessage?: WaPoll | null
  pollCreationMessageV2?: WaPoll | null
  pollCreationMessageV3?: WaPoll | null
  eventMessage?: { name?: string | null; description?: string | null } | null
  protocolMessage?: {
    type?: number | null
    key?: WaKey | null
    editedMessage?: WaContent | null
    timestampMs?: WaNumber
  } | null
  // Wrappers that carry another message ("future proof" messages).
  ephemeralMessage?: { message?: WaContent | null } | null
  viewOnceMessage?: { message?: WaContent | null } | null
  viewOnceMessageV2?: { message?: WaContent | null } | null
  viewOnceMessageV2Extension?: { message?: WaContent | null } | null
  documentWithCaptionMessage?: { message?: WaContent | null } | null
  editedMessage?: { message?: WaContent | null } | null
  associatedChildMessage?: { message?: WaContent | null } | null
  groupStatusMessage?: { message?: WaContent | null } | null
  groupStatusMessageV2?: { message?: WaContent | null } | null
  deviceSentMessage?: { message?: WaContent | null } | null
}

export interface WaLocation {
  degreesLatitude?: number | null
  degreesLongitude?: number | null
  name?: string | null
  address?: string | null
  caption?: string | null
  contextInfo?: WaContextInfo | null
}

export interface WaContact1 {
  displayName?: string | null
  vcard?: string | null
  contextInfo?: WaContextInfo | null
}

export interface WaOrder {
  orderId?: string | null
  itemCount?: number | null
  message?: string | null
  orderTitle?: string | null
  totalAmount1000?: WaNumber
  totalCurrencyCode?: string | null
  contextInfo?: WaContextInfo | null
}

export interface WaProduct {
  productId?: string | null
  title?: string | null
  currencyCode?: string | null
  priceAmount1000?: WaNumber
  retailerId?: string | null
}

export interface WaPoll {
  name?: string | null
  options?: ({ optionName?: string | null } | null)[] | null
  selectableOptionsCount?: number | null
  contextInfo?: WaContextInfo | null
}

export interface WaMessage {
  key?: WaKey | null
  message?: WaContent | null
  messageTimestamp?: WaNumber
  pushName?: string | null
  /** `WebMessageInfo.StubType`: 2 (CIPHERTEXT) is a message that could not be decrypted. */
  messageStubType?: number | null
}

export interface WaChat {
  id?: string | null
  name?: string | null
  unreadCount?: number | null
  markedAsUnread?: boolean | null
}

export interface WaContact {
  id?: string | null
  lid?: string | null
  phoneNumber?: string | null
  /** Name in the address book of the owner. */
  name?: string | null
  /** Name the person chose for themselves (push name). */
  notify?: string | null
  verifiedName?: string | null
}

export interface WaGroup {
  id?: string | null
  subject?: string | null
}

export interface WaMessageUpdate {
  key?: WaKey | null
  update?: {
    status?: number | null
    message?: WaContent | null
    messageTimestamp?: WaNumber
  } | null
}

export interface WaHistorySet {
  chats?: readonly WaChat[] | null
  contacts?: readonly WaContact[] | null
  messages?: readonly WaMessage[] | null
  lidPnMappings?: readonly { lid: string; pn: string }[] | null
  /** Baileys' `HistorySyncType` (a number): see `HISTORY_SYNC_RECENT`. */
  syncType?: number | null
  /** 0 to 100, how much of the sync of this `syncType` the server has sent. */
  progress?: number | null
  /** The last chunk of this sync type. */
  isLatest?: boolean | null
}

/** `messaging-history.status`: a milestone of a history sync. No content. */
export interface WaHistoryStatus {
  syncType?: number | null
  status?: string | null
  /** The server sent progress 100. False: completion was inferred because no more chunks arrived. */
  explicit?: boolean | null
}

export interface WaMessagesUpsert {
  messages?: readonly WaMessage[] | null
  /** 'notify': arrived while connected. 'append': added from elsewhere (offline delivery, history). */
  type?: string | null
}
