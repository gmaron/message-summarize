import type { MessageKind } from '../../domain/model.js'
import type { Catalog } from '../i18n/index.js'
import { moneyText, orderOf, productOf } from './commerce.js'
import type { WaContent } from './wa-types.js'

/** `ProtocolMessage.Type.MESSAGE_EDIT` of the WhatsApp protocol. */
const PROTOCOL_MESSAGE_EDIT = 14

/** Fields that wrap another message (disappearing, view once, a document with caption, an edit, ...). */
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'documentWithCaptionMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'editedMessage',
  'associatedChildMessage',
  'groupStatusMessage',
  'groupStatusMessageV2',
  'deviceSentMessage',
] as const

/** The message a wrapper carries, however deep (bounded, like the platform library does). */
export function unwrap(content: WaContent | null | undefined): WaContent | null {
  let current = content ?? null
  for (let depth = 0; depth < 5 && current !== null; depth++) {
    const inner = WRAPPERS.map((field) => current?.[field]?.message).find((m) => m !== undefined && m !== null)
    if (inner === undefined || inner === null) break
    current = inner
  }
  return current
}

export interface ParsedContent {
  readonly kind: MessageKind
  readonly text: string
}

/** "[image]" + caption, trimmed: the legacy "[imagen] caption" shape, in the language of the catalog. */
const labelled = (label: string, detail: string | null | undefined): string => `${label} ${detail ?? ''}`.trim()

/** "[document]" + "name" into "[document: name]". A label without closing bracket just gets the detail after it. */
function labelledWith(label: string, detail: string): string {
  return label.endsWith(']') ? `${label.slice(0, -1)}: ${detail}]` : `${label}: ${detail}`
}

/**
 * The kind and the text of a message in the account language (RF-10), or null for what is not a message of the
 * user (reactions, protocol messages, key distribution, ...) or has no text at all (an empty text message).
 */
export function parseContent(content: WaContent, catalog: Catalog): ParsedContent | null {
  const label = catalog.transcript.kinds
  const nonEmpty = (kind: MessageKind, text: string): ParsedContent | null => (text === '' ? null : { kind, text })

  if (content.conversation !== undefined && content.conversation !== null) {
    return nonEmpty('text', content.conversation)
  }
  if (content.extendedTextMessage) return nonEmpty('text', content.extendedTextMessage.text ?? '')
  if (content.imageMessage) return { kind: 'image', text: labelled(label.image, content.imageMessage.caption) }
  const video = content.videoMessage ?? content.ptvMessage
  if (video) return { kind: 'video', text: labelled(label.video, video.caption) }
  if (content.audioMessage) return { kind: 'audio', text: label.audio }
  if (content.documentMessage) {
    const doc = content.documentMessage
    const name = doc.fileName ?? doc.title ?? catalog.capture.unnamedDocument
    return { kind: 'document', text: labelled(labelledWith(label.document, name), doc.caption) }
  }
  if (content.stickerMessage) return { kind: 'sticker', text: label.sticker }
  const place = content.locationMessage ?? content.liveLocationMessage
  if (place)
    return { kind: 'location', text: labelled(label.location, `${place.name ?? ''} ${place.address ?? ''}`.trim()) }
  if (content.contactMessage) {
    return { kind: 'contact', text: labelledWith(label.contact, content.contactMessage.displayName ?? '') }
  }
  if (content.contactsArrayMessage) {
    const names = (content.contactsArrayMessage.contacts ?? []).map((c) => c?.displayName ?? '').join(', ')
    return { kind: 'contact', text: labelledWith(catalog.capture.contacts, names) }
  }
  const poll = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3
  if (poll) {
    const options = (poll.options ?? []).map((o) => o?.optionName ?? '').join(' / ')
    return { kind: 'poll', text: labelled(label.poll, `${poll.name ?? ''}: ${options}`) }
  }
  if (content.orderMessage) {
    const order = orderOf(content.orderMessage)
    const total = order === null ? null : moneyText(order.totalAmount, order.currency, catalog.dateLocale)
    return { kind: 'order', text: catalog.capture.order(order?.itemCount ?? null, total) }
  }
  if (content.productMessage?.product) {
    const product = productOf(content.productMessage.product)
    const price = product === null ? null : moneyText(product.price, product.currency, catalog.dateLocale)
    return { kind: 'product', text: catalog.capture.product(product?.title ?? null, price) }
  }
  if (content.eventMessage) {
    const event = content.eventMessage
    return { kind: 'event', text: labelled(label.event, `${event.name ?? ''} ${event.description ?? ''}`.trim()) }
  }
  const other = otherTypeOf(content)
  return other === null ? null : { kind: 'other', text: catalog.capture.otherType(other) }
}

/**
 * Fields that are not a message of the user: protocol traffic (edits are read apart, deletions, history notices),
 * sender key distribution, the context that rides along, and reactions and poll votes (routed before this).
 */
const NOT_A_MESSAGE = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'fastRatchetKeyContent',
  'messageContextInfo',
  'reactionMessage',
  'encReactionMessage',
  'pollUpdateMessage',
  'encEventResponseMessage',
])

/**
 * The protocol's field name of a content of a type that is not handled (`groupInviteMessage`, `buttonsResponseMessage`,
 * `pinInChatMessage`, ...), or null when there is nothing but protocol traffic. It is a fixed identifier of the
 * protocol, never text written by the sender; anything that does not look like one is called `unknown`.
 */
function otherTypeOf(content: WaContent): string | null {
  for (const [field, value] of Object.entries(content)) {
    if (value === undefined || value === null || NOT_A_MESSAGE.has(field)) continue
    if (WRAPPERS.some((wrapper) => wrapper === field)) continue
    return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(field) ? field : 'unknown'
  }
  return null
}

/**
 * An edit: the protocol message that says "this message now reads ...". Null when the content is not an edit.
 * `text` already carries the "edited" marker of the catalog, so the digest shows that the message was edited.
 */
export interface ParsedEdit {
  /** Id of the ORIGINAL message. */
  readonly originalId: string
  readonly parsed: ParsedContent
}

export function parseEdit(content: WaContent, catalog: Catalog): ParsedEdit | null {
  const protocol = content.protocolMessage
  const originalId = protocol?.key?.id
  if (!protocol?.editedMessage || !originalId) return null
  if (protocol.type !== undefined && protocol.type !== null && protocol.type !== PROTOCOL_MESSAGE_EDIT) return null
  return parseEditedBody(originalId, protocol.editedMessage, catalog)
}

/** The body of an edit, once the original id and the edited content are known (both edit paths end here). */
export function parseEditedBody(originalId: string, edited: WaContent, catalog: Catalog): ParsedEdit | null {
  const inner = unwrap(edited)
  const parsed = inner === null ? null : parseContent(inner, catalog)
  if (parsed === null) return null
  return { originalId, parsed: { kind: parsed.kind, text: `${catalog.capture.editedPrefix}${parsed.text}` } }
}

export { toNumber } from './numbers.js'
