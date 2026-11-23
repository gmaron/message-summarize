/** Own mass messages (RF-33): an own text of at least 40 code points found identical in 3 or more conversations. */
export const MASS_MIN_LENGTH = 40
export const MASS_MIN_CONVERSATIONS = 3

/** Length in Unicode code points (not UTF-16 units: an emoji outside the BMP counts as 1). */
export function codePointLength(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

export interface OwnMessageText {
  readonly conversationId: string
  readonly text: string | null
}

/**
 * Texts that are mass messages. Expects every own message of the whole history, of any kind, not only the window.
 * The match is exact: no trimming, no case folding.
 */
export function findMassTexts(ownMessages: Iterable<OwnMessageText>): Set<string> {
  const conversationsByText = new Map<string, Set<string>>()
  for (const { conversationId, text } of ownMessages) {
    if (text === null || codePointLength(text) < MASS_MIN_LENGTH) continue
    const set = conversationsByText.get(text) ?? new Set<string>()
    set.add(conversationId)
    conversationsByText.set(text, set)
  }
  const mass = new Set<string>()
  for (const [text, conversations] of conversationsByText) {
    if (conversations.size >= MASS_MIN_CONVERSATIONS) mass.add(text)
  }
  return mass
}

/**
 * Same rule at the time a message is received: `otherConversationsWithSameText` counts the conversations, other than
 * the current one, that already hold an own message with exactly this text.
 */
export const isMassAtReceipt = (text: string, otherConversationsWithSameText: number): boolean =>
  codePointLength(text) >= MASS_MIN_LENGTH && otherConversationsWithSameText >= MASS_MIN_CONVERSATIONS - 1

/** Whether an own message is a mass one: its text is one of `mass` (from `findMassTexts`). */
export const isMassMessage = (
  mass: ReadonlySet<string>,
  m: { readonly fromMe: boolean; readonly text: string | null },
): boolean => m.fromMe && m.text !== null && mass.has(m.text)
