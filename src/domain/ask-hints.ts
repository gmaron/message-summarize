/**
 * Context the owner wrote about their own business or vocabulary, added to the system prompt of an Ask only when the
 * question mentions one of its words. It is trusted text (the owner wrote it), unlike the chats.
 */
export interface AskHint {
  /** Words or short phrases: the hint applies when the question contains any of them as a whole word or phrase. */
  readonly when: readonly string[]
  /** What the model should know. */
  readonly text: string
}

export const MAX_ASK_HINTS = 20
export const MAX_ASK_HINT_TERMS = 20
export const MAX_ASK_HINT_TEXT_CHARS = 2000

/** Lowercase, no accents, blanks collapsed: "  Expedición\tPEDIDOS " -> "expedicion pedidos". */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A letter or a digit of any alphabet: what a "word" is made of. */
const WORD_CHAR = '[\\p{L}\\p{N}_]'

function mentions(question: string, term: string): boolean {
  const normalized = normalizeForMatch(term)
  if (normalized === '') return false
  const body = escapeRegExp(normalized).replace(/ /g, '\\s+')
  return new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, 'u').test(question)
}

/**
 * The texts of the hints that apply to a question, in the order of the configuration and without repeats. A hint applies
 * when any of its `when` terms appears in the question as a whole word or phrase, ignoring case and accents ("pedidos"
 * does not match "pedido" unless it is listed, and "expedido" never matches "pedido").
 */
export function matchAskHints(hints: readonly AskHint[], question: string): string[] {
  const normalized = normalizeForMatch(question)
  const texts: string[] = []
  for (const hint of hints) {
    if (hint.when.some((term) => mentions(normalized, term)) && !texts.includes(hint.text)) texts.push(hint.text)
  }
  return texts
}
