import {
  type MediaDetails,
  type MediaKind,
  type MessageExtras,
  type MessageKind,
  type PollDetails,
  QUOTED_TEXT_MAX,
  type QuotedMessage,
  type SharedContact,
} from '../../domain/model.js'
import type { Catalog } from '../i18n/index.js'
import { orderOf, productOf } from './commerce.js'
import { parseContent, unwrap } from './content.js'
import { toNumber } from './numbers.js'
import { rawJson } from './raw.js'
import type { WaContent, WaContextInfo, WaMediaFields, WaPoll } from './wa-types.js'

/** The pseudo-chat WhatsApp uses for statuses: a message whose context points at it is a reply to a status. */
export const STATUS_JID = 'status@broadcast'

/** Fields that wrap another message and mean "view once" (`viewOnce` on the media itself is checked too). */
const VIEW_ONCE_WRAPPERS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'] as const

const WRAPPER_FIELDS = [
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

const text = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value === '' ? null : value

/** Whether any wrapper between the outer content and the message is a view-once one. */
function wrappedViewOnce(outer: WaContent): boolean {
  let current: WaContent | null | undefined = outer
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth++) {
    if (VIEW_ONCE_WRAPPERS.some((field) => current?.[field]?.message)) return true
    const next: WaContent | null | undefined = WRAPPER_FIELDS.map((field) => current?.[field]?.message).find(Boolean)
    current = next
  }
  return false
}

/** The context (reply, forward) of a message: the `contextInfo` of whichever field carries one. */
export function contextOf(content: WaContent): WaContextInfo | null {
  for (const value of Object.values(content)) {
    if (value !== null && typeof value === 'object' && 'contextInfo' in value) {
      const context = (value as { contextInfo?: WaContextInfo | null }).contextInfo
      if (context) return context
    }
  }
  return null
}

/** The text of a quoted message worth showing: the text itself, or the caption of a media. Never a label. */
function quotedTextOf(quoted: WaContent): string | null {
  if (quoted.conversation) return quoted.conversation
  if (quoted.extendedTextMessage?.text) return quoted.extendedTextMessage.text
  const caption =
    quoted.imageMessage?.caption ?? quoted.videoMessage?.caption ?? quoted.documentMessage?.caption ?? null
  return text(caption)
}

function quotedOf(context: WaContextInfo | null, catalog: Catalog): QuotedMessage | null {
  if (context === null) return null
  const fromStatus = context.remoteJid === STATUS_JID
  const quotedContent = context.quotedMessage ? unwrap(context.quotedMessage) : null
  const id = text(context.stanzaId)
  if (id === null && quotedContent === null && !fromStatus) return null
  const kind: MessageKind | null = quotedContent === null ? null : (parseContent(quotedContent, catalog)?.kind ?? null)
  const quotedText = quotedContent === null ? null : quotedTextOf(quotedContent)
  return { id, kind, text: quotedText === null ? null : quotedText.slice(0, QUOTED_TEXT_MAX), fromStatus }
}

const MEDIA_FIELDS = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
] as const satisfies readonly (readonly [keyof WaContent, MediaKind])[]

function mediaOf(content: WaContent): MediaDetails | null {
  for (const [field, kind] of MEDIA_FIELDS) {
    const media: WaMediaFields | null | undefined = content[field]
    if (!media) continue
    return {
      kind,
      mimetype: text(media.mimetype),
      seconds: media.seconds ?? null,
      fileLength: toNumber(media.fileLength),
      fileName: text(media.fileName) ?? (kind === 'document' ? text(media.title) : null),
      pageCount: media.pageCount ?? null,
      width: media.width ?? null,
      height: media.height ?? null,
      caption: text(media.caption),
    }
  }
  return null
}

/** The phone numbers written in a vCard (`TEL` lines, with or without a group prefix or parameters). */
export function phonesOfVcard(vcard: string | null | undefined): string[] {
  if (!vcard) return []
  const phones: string[] = []
  for (const match of vcard.matchAll(/^(?:[\w-]+\.)?TEL[^:\r\n]*:([^\r\n]+)$/gim)) {
    const phone = match[1]?.trim()
    if (phone && !phones.includes(phone)) phones.push(phone)
  }
  return phones
}

function contactsOf(content: WaContent): SharedContact[] {
  const list = content.contactMessage ? [content.contactMessage] : (content.contactsArrayMessage?.contacts ?? [])
  return list
    .filter((contact): contact is NonNullable<typeof contact> => contact !== null && contact !== undefined)
    .map((contact) => ({ displayName: text(contact.displayName), phones: phonesOfVcard(contact.vcard) }))
}

function pollOf(content: WaContent): PollDetails | null {
  const poll: WaPoll | null | undefined =
    content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3
  if (!poll) return null
  return {
    question: text(poll.name),
    options: (poll.options ?? []).map((option) => option?.optionName ?? ''),
    selectableCount: poll.selectableOptionsCount ?? null,
  }
}

/**
 * Everything the adapter keeps of a message besides its text: the raw content, the reply, the forward and view-once
 * marks and the typed details of its media, place, contacts, poll, order or product. `outer` is the content as it came
 * (to see the wrappers) and `inner` the message inside them.
 */
export function parseExtras(outer: WaContent, inner: WaContent, catalog: Catalog): MessageExtras {
  const context = contextOf(inner)
  const media = mediaOf(inner)
  const place = inner.locationMessage ?? inner.liveLocationMessage
  const order = orderOf(inner.orderMessage)
  const product = productOf(inner.productMessage?.product)
  const mediaFields = MEDIA_FIELDS.map(([field]) => inner[field]).find(Boolean)
  return {
    raw: rawJson(inner),
    quoted: quotedOf(context, catalog),
    forwarded: context?.isForwarded === true || (context?.forwardingScore ?? 0) > 0,
    viewOnce: wrappedViewOnce(outer) || mediaFields?.viewOnce === true,
    media,
    location: place
      ? {
          lat: place.degreesLatitude ?? null,
          lng: place.degreesLongitude ?? null,
          name: text(place.name),
          address: text(place.address),
          live: inner.liveLocationMessage !== undefined && inner.liveLocationMessage !== null,
        }
      : null,
    contacts: contactsOf(inner),
    poll: pollOf(inner),
    order,
    product,
  }
}
