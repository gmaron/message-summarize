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

/** Label of the author of a message. The owner label is built by the caller. Empty names count as missing. */
export function senderLabel(
  message: Pick<Message, 'fromMe' | 'senderName' | 'senderAddress'>,
  participant: Participant | null,
  labels: { readonly ownerLabel: string },
): string {
  if (message.fromMe) return labels.ownerLabel
  return participant?.savedName || participant?.publicName || message.senderName || message.senderAddress || '?'
}
