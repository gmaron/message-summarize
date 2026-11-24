import type { Conversation, Message, Participant } from './model.js'

/** WhatsApp masks some numbers with this character ("+54∙∙∙∙15"). A masked name is useless: treat it as no name. */
export const isMaskedName = (name: string): boolean => name.includes('∙')

export const unmaskedName = (name: string | null): string | null => (name !== null && !isMaskedName(name) ? name : null)

export interface ResolvedName {
  readonly name: string
  /** True when the contact is in the address book (always true for groups). */
  readonly saved: boolean
}

/**
 * Name of a conversation as the digest shows it. For an unsaved individual chat it is "alias ( address )", with
 * spaces inside the parentheses so that WhatsApp makes the number tappable. An empty string counts as no name.
 */
export function resolveConversationName(
  conversation: Conversation,
  participant: Participant | null,
  labels: { readonly unnamedGroup: string },
): ResolvedName {
  if (conversation.isGroup) return { name: conversation.name || labels.unnamedGroup, saved: true }
  if (participant?.savedName) return { name: participant.savedName, saved: true }
  const alias = participant?.publicName || conversation.name
  return { name: alias ? `${alias} ( ${conversation.address} )` : conversation.address, saved: false }
}

/**
 * How a chat is named where the owner may want to write to the contact (the Ask answer): an individual chat with a phone
 * number is "name - ( +number )", saved or not, with spaces inside the parentheses so that WhatsApp makes the number
 * tappable; with no name it is "( +number )". A group, or a chat whose address is no number (an id the platform did not
 * map to a phone), is named without a number.
 *
 * The push name and the group subject are chosen by other people, so every name is cleaned (`labelName`): it can neither
 * carry a number that would look like the contact's (a "( +number )" written into the name, to be tapped by mistake) nor
 * break the line it is on (a new line, or a "###" that would fake the heading of another chat).
 */
export function contactLabel(
  conversation: Conversation,
  participant: Participant | null,
  labels: { readonly unnamedGroup: string },
): string {
  if (conversation.isGroup) return labelName(conversation.name) || labels.unnamedGroup
  const name = labelName(participant?.savedName || participant?.publicName || conversation.name)
  if (!/^\+\d+$/.test(conversation.address)) return name || conversation.address
  const number = `( ${conversation.address} )`
  return name ? `${name} - ${number}` : number
}

// Anything that reads as a phone number: 7 or more digits of any script, with anything but letters in between ("+",
// spaces, dots, dashes, parentheses, symbols). Run last, on a name already normalized, so nothing removed later can join
// digits that were apart.
const PHONE_LIKE = /\p{Nd}(?:[^\p{L}\p{Nd}]*\p{Nd}){6,}/gu
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const LINE_BREAKERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
// Invisible characters (zero-width spaces and joiners, direction marks, variation selectors, and invisible "letters" such as
// the Hangul fillers): they could split a number so the pattern misses it.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu

/** A name made safe for a label line: no line breaks, no "#", no phone-like digits, no empty parentheses left behind. */
export function labelName(name: string | null | undefined): string {
  if (!name) return ''
  return name
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(LINE_BREAKERS, ' ')
    .replace(/#/g, ' ')
    .replace(PHONE_LIKE, ' ')
    .replace(/[+]/g, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s-]+|[\s-]+$/g, '')
}

/** Label of the author of a message. The owner label is built by the caller. Empty names count as missing. */
export function senderLabel(
  message: Pick<Message, 'fromMe' | 'senderName' | 'senderAddress'>,
  participant: Participant | null,
  labels: { readonly ownerLabel: string },
): string {
  if (message.fromMe) return labels.ownerLabel
  return participant?.savedName || participant?.publicName || message.senderName || message.senderAddress || '?'
}
