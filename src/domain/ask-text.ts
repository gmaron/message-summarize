import { splitIntoParts } from './chunk.js'

/** The longest question accepted, in characters. The owner pastes structured requests, so it is long. */
export const MAX_QUESTION_CHARS = 4000
/** The most chat text one model call gets, in characters (about 40 000 tokens). */
export const ASK_PART_CHARS = 150_000
/** More chat text than this (about 8 parts) is too slow for one request: the owner is asked to narrow it. */
export const ASK_MAX_TOTAL_CHARS = 1_200_000
/** How many extract calls run at once when the text is read in parts. */
export const ASK_EXTRACT_CONCURRENCY = 3
/** Messages that were already answered (or read) shown before what is pending, to understand what is talked about. */
export const ASK_CONTEXT_MESSAGES = 3

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/**
 * The question as the model gets it: no control characters (line breaks stay, as the owner pastes lists and structured
 * requests), runs of blanks collapsed, no blanks at the ends of a line, no more than one blank line in a row, trimmed
 * and cut at `MAX_QUESTION_CHARS`.
 */
export function cleanQuestion(question: string): string {
  return question
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_QUESTION_CHARS)
    .trim()
}

/** What an extract call answers when its part has nothing for the request: exactly this, in either language. */
const NOTHING_WORDS = new Set(['nada', 'nothing'])
const WRAPPING = /^[\s"'«»“”‘’`*_.!]+|[\s"'«»“”‘’`*_.!]+$/g

/** True when an extract is the "nothing" word, alone, even with quotes, a final period or emphasis around it. */
export function isNothing(text: string): boolean {
  return NOTHING_WORDS.has(text.replace(WRAPPING, '').toLowerCase())
}

/** One conversation ready to be put in the text: a heading (the continued one says it goes on) and its lines. */
export interface AskBlock {
  readonly heading: (continued: boolean) => string
  readonly lines: readonly string[]
}

const PART_SEPARATOR = '\n\n'

/** The text of the whole block, in one piece. */
export function renderBlock(block: AskBlock): string {
  return [block.heading(false), ...block.lines].join('\n')
}

/**
 * Packs the blocks, in order, into parts of at most `max` characters. A part holds whole chats where it can; a chat that
 * does not fit in what is left of the part starts the next one, and a chat bigger than a part is split between lines
 * (a line longer than a part is cut), the heading repeated with the "continued" mark on every piece after the first.
 * No part is empty and none is longer than `max`.
 */
export function buildParts(blocks: readonly AskBlock[], max: number = ASK_PART_CHARS): string[] {
  const parts: string[] = []
  let current = ''
  const close = (): void => {
    if (current !== '') parts.push(current)
    current = ''
  }
  const add = (piece: string): void => {
    if (current !== '' && current.length + PART_SEPARATOR.length + piece.length > max) close()
    current += (current === '' ? '' : PART_SEPARATOR) + piece
  }
  for (const block of blocks) {
    const whole = renderBlock(block)
    if (whole.length <= max) {
      add(whole)
      continue
    }
    // Bigger than a part: its own pieces, each with its heading.
    close()
    let continued = false
    let piece = block.heading(false)
    const flush = (): void => {
      add(piece)
      close()
      continued = true
      piece = block.heading(true)
    }
    for (const line of block.lines) {
      const room = Math.max(1, max - block.heading(true).length - 1)
      for (let from = 0; from === 0 || from < line.length; from += room) {
        const slice = line.length <= room ? line : line.slice(from, from + room)
        if (piece.length + 1 + slice.length > max) flush()
        piece += `\n${slice}`
      }
    }
    if (piece !== block.heading(continued)) add(piece)
    close()
  }
  close()
  return parts
}

/** Total characters of the text of the parts, separators included: what `ASK_MAX_TOTAL_CHARS` limits. */
export const totalChars = (parts: readonly string[]): number =>
  parts.reduce((n, part) => n + part.length, 0) + Math.max(0, parts.length - 1) * PART_SEPARATOR.length

/** WhatsApp's own formatting from the simple markdown the model writes: `##` titles, `**bold**` and `-` lists. */
export function toWhatsApp(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^([ \t]*)[-*][ \t]+/gm, '$1• ')
    .replace(/^-{3,}$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The most one delivered part holds (the same as the digest's). */
export const ASK_DELIVERY_PART_MAX = 3500

/** The parts of the message to the owner's own chat: a header, then the answer cut between lines like the digest. */
export function deliveryParts(header: string, whatsappText: string, max: number = ASK_DELIVERY_PART_MAX): string[] {
  const body = whatsappText.split('\n').flatMap((line) => {
    // A line longer than a part is cut, so no part goes over the limit of the channel.
    if (line.length <= max) return [line]
    const pieces: string[] = []
    for (let from = 0; from < line.length; from += max) pieces.push(line.slice(from, from + max))
    return pieces
  })
  return [header, ...splitIntoParts(body, max)]
}
