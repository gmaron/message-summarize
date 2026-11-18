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

/** A protobuf message, as loosely as it is read: the kind is whichever field is set. */
export interface WaContent {
  conversation?: string | null
  extendedTextMessage?: { text?: string | null } | null
  imageMessage?: { caption?: string | null } | null
  videoMessage?: { caption?: string | null } | null
  /**
   * What is read of an audio. ALL of it is written by the sender, so none of it is trusted: `fileLength` (bytes, to refuse
   * a huge download), `mimetype` (to pick the format), `directPath` (where on WhatsApp's media host the file is: checked
   * with `isSafeDirectPath`), `mediaKey` (the decryption key of the file: a secret, stored only in the account database).
   * `url` is never used: it could point anywhere.
   */
  audioMessage?: {
    fileLength?: WaNumber
    mimetype?: string | null
    directPath?: string | null
    mediaKey?: Uint8Array | string | null
    url?: string | null
  } | null
  documentMessage?: { fileName?: string | null; title?: string | null; caption?: string | null } | null
  stickerMessage?: object | null
  locationMessage?: { name?: string | null; address?: string | null } | null
  liveLocationMessage?: { name?: string | null; address?: string | null; caption?: string | null } | null
  contactMessage?: { displayName?: string | null } | null
  contactsArrayMessage?: { contacts?: ({ displayName?: string | null } | null)[] | null } | null
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

export interface WaPoll {
  name?: string | null
  options?: ({ optionName?: string | null } | null)[] | null
}

export interface WaMessage {
  key?: WaKey | null
  message?: WaContent | null
  messageTimestamp?: WaNumber
  pushName?: string | null
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
