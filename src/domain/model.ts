/**
 * A chat. The adapter hands names over already cleaned: a masked name ("+54∙∙∙∙15") is null (`unmaskedName`). A
 * conversation that has messages but no stored metadata still exists as a Conversation (a group with no name has
 * `name` null and `isGroup` true).
 */
export interface Conversation {
  readonly id: string
  readonly isGroup: boolean
  /** Null: the platform has no name for it. */
  readonly name: string | null
  /** The participant whose name and saved state identify an individual chat. Null for groups. */
  readonly participantId: string | null
  /** What to show for an individual chat with no name. The adapter computes it at capture ("+9963667784458" or the raw id). */
  readonly address: string
}

export interface Participant {
  readonly id: string
  /** Name in the user's address book. Already cleaned by the adapter: a masked name is null. */
  readonly savedName: string | null
  /** Name the person chose for themselves (push name). Already cleaned by the adapter: a masked name is null. */
  readonly publicName: string | null
}

export const MESSAGE_KINDS = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contact',
  'poll',
  'event',
  'order',
  'product',
  // Any other type WhatsApp sends (round video notes aside): stored with its raw content, but left out of digests and
  // Ask transcripts, so it never counts as a message to summarize or to reply to.
  'other',
] as const

export type MessageKind = (typeof MESSAGE_KINDS)[number]

export interface Message {
  readonly id: string
  readonly conversationId: string
  readonly senderId: string | null
  readonly senderName: string | null
  /** Formatted address of the sender, computed by the adapter. Null only when the sender id is null. */
  readonly senderAddress: string | null
  readonly fromMe: boolean
  /** Epoch milliseconds. */
  readonly timestamp: number
  readonly kind: MessageKind
  readonly text: string | null
  readonly transcript: string | null
  readonly read: boolean
  /**
   * What this message replies to, when the digest shows it (read side only: the capture does not set it, the digest
   * source fills it from the typed columns). Absent for a message that is not a reply.
   */
  readonly reply?: ReplyContext
}

/** The message another one replies to, reduced to what a transcript shows. */
export interface ReplyContext {
  /** The kind of the quoted message, null when it is not known. */
  readonly kind: MessageKind | null
  /** Short text of the quoted message (already cut by the capture), null when it has none. */
  readonly text: string | null
  /** True when the reply is to a status (story) of the owner. */
  readonly fromStatus: boolean
}

/** Longest quoted text the capture stores in `quoted_text`. */
export const QUOTED_TEXT_MAX = 200

/**
 * Everything the adapter understood of a message beyond its text, to be stored next to it (typed columns, side tables and
 * the raw content). Platform neutral: a new platform fills what it has. All fields optional; absent means "none".
 */
export interface MessageExtras {
  /** The decoded content of the message as JSON text (media descriptors kept, binary noise and keys dropped). */
  readonly raw?: string | null
  readonly quoted?: QuotedMessage | null
  readonly forwarded?: boolean
  readonly viewOnce?: boolean
  readonly media?: MediaDetails | null
  readonly location?: LocationDetails | null
  readonly contacts?: readonly SharedContact[]
  readonly poll?: PollDetails | null
  readonly order?: OrderDetails | null
  readonly product?: ProductDetails | null
}

export interface QuotedMessage {
  /** Id of the quoted message on the platform. */
  readonly id: string | null
  readonly kind: MessageKind | null
  /** Short text (at most QUOTED_TEXT_MAX characters). */
  readonly text: string | null
  /** The message replies to a status. */
  readonly fromStatus: boolean
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker'

export interface MediaDetails {
  readonly kind: MediaKind
  readonly mimetype: string | null
  readonly seconds: number | null
  readonly fileLength: number | null
  readonly fileName: string | null
  readonly pageCount: number | null
  readonly width: number | null
  readonly height: number | null
  readonly caption: string | null
}

export interface LocationDetails {
  readonly lat: number | null
  readonly lng: number | null
  readonly name: string | null
  readonly address: string | null
  readonly live: boolean
}

export interface SharedContact {
  readonly displayName: string | null
  /** Phone numbers found in the vCard, as written there. */
  readonly phones: readonly string[]
}

export interface PollDetails {
  readonly question: string | null
  readonly options: readonly string[]
  readonly selectableCount: number | null
}

export interface OrderDetails {
  readonly orderId: string | null
  readonly itemCount: number | null
  /** In currency units (the platform sends thousandths). */
  readonly totalAmount: number | null
  readonly currency: string | null
  readonly title: string | null
  readonly message: string | null
}

export interface ProductDetails {
  readonly productId: string | null
  readonly title: string | null
  readonly price: number | null
  readonly currency: string | null
  readonly retailerId: string | null
}

/** An emoji reaction to a message. Not a message: it never appears in a digest. An empty emoji removes the reaction. */
export interface Reaction {
  readonly conversationId: string
  readonly targetId: string
  /** Null for the owner's own reaction. */
  readonly senderId: string | null
  readonly fromMe: boolean
  readonly emoji: string
  /** Epoch milliseconds. */
  readonly timestamp: number
}

/** A vote on a poll. The platform encrypts it; it is stored as received (see the TODO in the writer). */
export interface PollVote {
  readonly conversationId: string
  readonly pollId: string
  readonly senderId: string | null
  readonly fromMe: boolean
  readonly timestamp: number
  /** JSON text of the vote payload as received (still encrypted). */
  readonly raw: string
}

/**
 * What the source says about unread messages of a conversation.
 * - unknown: the source does not tell (legacy null).
 * - markedUnread: the user marked the conversation as unread by hand (legacy -1).
 * - count: the number of unread incoming messages (0 or more).
 */
export type UnreadState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'markedUnread' }
  | { readonly kind: 'count'; readonly count: number }
