import type { MessageKind } from './model.js'

/** Texts shorter than this (UTF-16 units, after trim) are never treated as the same notice. */
export const DEDUPE_MIN_LENGTH = 40

export interface DedupeMessage {
  readonly senderId: string | null
  readonly senderName: string | null
  readonly fromMe: boolean
  readonly kind: MessageKind
  readonly text: string | null
}

export interface DedupeConversation {
  readonly isGroup: boolean
  readonly messages: readonly DedupeMessage[]
}

/** `copies`: how many equal messages were removed in favour of this one (0 for most). */
export type WithCopies<M> = M & { readonly copies: number }

export type Deduplicated<C extends DedupeConversation> = Omit<C, 'messages'> & {
  readonly messages: WithCopies<C['messages'][number]>[]
}

/**
 * The same notice (same author, same trimmed text) sent to several groups is summarized once (RF-34).
 *
 * - Conversations are taken in the given order and the first occurrence is kept, with the number of copies
 *   dropped, including repeats inside the same group.
 * - Only groups are touched. Audios and messages without text are never deduplicated.
 * - My own messages share the key "yo"; an author with neither id nor name has the key "?".
 * - Afterwards, conversations with no messages, or with only my messages, are dropped (also individual ones).
 *
 * Inputs are not modified.
 */
export function deduplicateAcrossGroups<C extends DedupeConversation>(conversations: readonly C[]): Deduplicated<C>[] {
  const counters = new Map<string, { copies: number }>()
  const pending: { conversation: C; kept: { message: C['messages'][number]; counter: { copies: number } }[] }[] = []
  for (const conversation of conversations) {
    const kept: { message: C['messages'][number]; counter: { copies: number } }[] = []
    for (const message of conversation.messages) {
      const counter = { copies: 0 }
      let keep = true
      if (conversation.isGroup && message.kind !== 'audio' && message.text !== null) {
        const trimmed = message.text.trim()
        if (trimmed.length >= DEDUPE_MIN_LENGTH) {
          const key = `${message.fromMe ? 'yo' : (message.senderId ?? message.senderName ?? '?')}\n${trimmed}`
          const original = counters.get(key)
          if (original === undefined) counters.set(key, counter)
          else {
            original.copies++
            keep = false
          }
        }
      }
      if (keep) kept.push({ message, counter })
    }
    pending.push({ conversation, kept })
  }
  return pending
    .map(({ conversation, kept }) => ({
      ...conversation,
      messages: kept.map(({ message, counter }) => ({ ...message, copies: counter.copies })),
    }))
    .filter((c) => c.messages.length > 0 && !c.messages.every((m) => m.fromMe))
}
