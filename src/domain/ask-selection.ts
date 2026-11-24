import { ASK_CONTEXT_MESSAGES } from './ask-text.js'
import { isMassMessage } from './mass.js'
import type { Message } from './model.js'

/** Which messages of each chat a request reads. */
export const ASK_SELECTIONS = ['unanswered', 'unread', 'all'] as const
export type AskSelection = (typeof ASK_SELECTIONS)[number]

/** A message the owner wrote that says something: text or an audio, and not a mass message (RF-33). */
export function isUsefulOwn(mass: ReadonlySet<string>, m: Message): boolean {
  if (!m.fromMe || isMassMessage(mass, m)) return false
  return (m.text !== null && m.text.trim() !== '') || m.kind === 'audio'
}

/** A message that says something to read: text, or an audio (its transcript, or the note that it was not transcribed). */
export const isUsefulMessage = (m: Message): boolean => (m.text !== null && m.text.trim() !== '') || m.kind === 'audio'

/** When the owner last said something useful in a chat (not a mass message), or undefined when they never did. `ownNewestFirst` is their latest messages of the whole chat. */
export const lastUsefulOwn = (ownNewestFirst: readonly Message[], mass: ReadonlySet<string>): number | undefined =>
  ownNewestFirst.find((m) => isUsefulOwn(mass, m))?.timestamp

/** The most pending messages of one chat that a request reads (the latest ones): a chat never answered can be years long. */
export const ASK_MAX_PENDING_PER_CHAT = 200

export interface UnansweredPick {
  /** What others wrote after the owner's last useful message, oldest first. Empty: nothing pending, skip the chat. */
  readonly messages: readonly Message[]
  /** Where to read the context before the first pending message: its timestamp, or null when there is none to read. */
  readonly contextBefore: number | null
  readonly contextLimit: number
}

/**
 * What a chat has left unanswered: EVERYTHING others wrote after the owner's last own useful message, also what came
 * before the window (an order of Monday is still pending on Tuesday). The chat counts only if at least one pending
 * message is inside the window, so a request about "today" does not drag in chats that were quiet today.
 * `windowMessages` are the messages of the chat from `min(window.since, last own message)` (from the start of the chat when
 * the owner never wrote) to the end of the window.
 * A group where the owner never wrote has nothing "unanswered": its messages are notices for everybody, so it is
 * skipped; an individual chat where the owner never wrote has all of it unanswered (the latest `ASK_MAX_PENDING_PER_CHAT`).
 * The context is read before the first pending message, so everything in it is at or before the owner's last answer.
 */
export function pickUnanswered(
  isGroup: boolean,
  windowMessages: readonly Message[],
  ownNewestFirst: readonly Message[],
  mass: ReadonlySet<string>,
  windowSince: number,
): UnansweredPick {
  const none: UnansweredPick = { messages: [], contextBefore: null, contextLimit: ASK_CONTEXT_MESSAGES }
  const lastOwn = lastUsefulOwn(ownNewestFirst, mass)
  if (isGroup && lastOwn === undefined) return none
  const messages = windowMessages.filter((m) => !m.fromMe && isUsefulMessage(m) && m.timestamp > (lastOwn ?? -Infinity))
  if (messages.length === 0 || !messages.some((m) => m.timestamp >= windowSince)) return none
  const kept = messages.slice(-ASK_MAX_PENDING_PER_CHAT)
  // Context only where there IS something answered before the first pending message: with no answer at all, or when the
  // oldest pending ones were cut, what lies before is pending too and must not be shown as "already answered".
  const contextBefore = lastOwn === undefined || kept.length < messages.length ? null : (kept[0]?.timestamp ?? null)
  return { messages: kept, contextBefore, contextLimit: ASK_CONTEXT_MESSAGES }
}
