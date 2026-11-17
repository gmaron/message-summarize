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
  /** What to show for an individual chat with no name. The adapter computes it at capture ("+5491155550000" or the raw id). */
  readonly address: string
}

export interface Participant {
  readonly id: string
  /** Name in the user's address book. Already cleaned by the adapter: a masked name is null. */
  readonly savedName: string | null
  /** Name the person chose for themselves (push name). Already cleaned by the adapter: a masked name is null. */
  readonly publicName: string | null
}

export type MessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'event'

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
