import type { UnreadState } from './model.js'

/** How many messages before the unread tail are passed as context. */
export const CONTEXT_MESSAGES = 5

export interface WindowMessage {
  readonly id: string
  readonly timestamp: number
}

export interface IncomingMessage {
  readonly id: string
  readonly read: boolean
}

export interface UnreadTail<M> {
  readonly messages: readonly M[]
  /** The use case fetches the CONTEXT_MESSAGES messages with a timestamp before this one. Null: no context. */
  readonly contextBefore: number | null
}

/**
 * Chooses what to summarize in a conversation when only unread messages are wanted (RF-31).
 *
 * `windowMessages`: the conversation's messages inside the window, oldest first.
 * `lastIncoming`: the incoming messages of the WHOLE conversation, newest first (the caller may fetch just N or more:
 * only the first N, N = the unread count, are used). Messages after the window take places among those N. Read ones
 * are filtered out after the limit, so fewer than N can count as unread.
 *
 * An empty `messages` means the conversation is skipped.
 */
export function selectUnreadTail<M extends WindowMessage>(
  state: UnreadState,
  windowMessages: readonly M[],
  lastIncoming: readonly IncomingMessage[],
): UnreadTail<M> {
  const skip: UnreadTail<M> = { messages: [], contextBefore: null }
  if (state.kind === 'markedUnread') return { messages: windowMessages, contextBefore: null }
  // A count of 0 or less means nothing unread. The guard matters for a negative count (WhatsApp uses -1 for "marked
  // unread"): `slice(0, -1)` would otherwise take every incoming message but the last. Callers do not send one today.
  if (state.kind === 'unknown' || state.count <= 0) return skip

  const unreadIds = new Set(
    lastIncoming
      .slice(0, state.count)
      .filter((m) => !m.read)
      .map((m) => m.id),
  )
  const first = windowMessages.findIndex((m) => unreadIds.has(m.id))
  const firstMessage = windowMessages[first]
  if (firstMessage === undefined) return skip
  return { messages: windowMessages.slice(first), contextBefore: firstMessage.timestamp }
}
