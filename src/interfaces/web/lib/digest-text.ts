/**
 * The text of a digest as it is sent (WhatsApp formatting) split into what the bubble draws. The text was written from
 * chats of third parties: this only cuts it into lines and `*bold*` spans, and the page draws every span as a text node,
 * so nothing in it can ever become markup (`<script>` stays the characters `<script>`).
 */

export interface Span {
  readonly text: string
  readonly bold: boolean
}

export type LineKind =
  /** The first line of the digest (its title). */
  | 'title'
  /** A line that is all bold: the head of a section. */
  | 'heading'
  /** "• *Name*: summary", with the todos that follow it. */
  | 'item'
  /** A "☐ todo" with no item before it. */
  | 'task'
  | 'text'

export interface Line {
  readonly kind: LineKind
  readonly spans: readonly Span[]
  /** The "☐ todo" lines that follow an item. */
  readonly tasks: readonly (readonly Span[])[]
}

/** Lines between blank lines: a section, or the head of the digest. */
export type Block = readonly Line[]

/** `*bold*` pairs on one line. An asterisk with no pair stays a character. */
export function spansOf(line: string): Span[] {
  const spans: Span[] = []
  let rest = line
  while (rest !== '') {
    const open = rest.indexOf('*')
    const close = open < 0 ? -1 : rest.indexOf('*', open + 1)
    // "**" is not a bold span of nothing: it is two asterisks
    if (open < 0 || close < 0 || close === open + 1) {
      spans.push({ text: rest, bold: false })
      break
    }
    if (open > 0) spans.push({ text: rest.slice(0, open), bold: false })
    spans.push({ text: rest.slice(open + 1, close), bold: true })
    rest = rest.slice(close + 1)
  }
  return spans
}

const isTask = (line: string): boolean => /^\s*☐/.test(line)
const isItem = (line: string): boolean => line.startsWith('•')

/**
 * The blocks of a text. `first` says that the text starts the digest, so its first line is the title (a later part of a
 * long digest starts in the middle of a section instead).
 */
export function parseDigest(text: string, first = true): Block[] {
  const blocks: Line[][] = []
  let current: Line[] = []
  let seenTitle = !first
  const flush = (): void => {
    if (current.length > 0) blocks.push(current)
    current = []
  }
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      flush()
      continue
    }
    if (isTask(line)) {
      const spans = spansOf(line.trim())
      const last = current[current.length - 1]
      if (last !== undefined && last.kind === 'item') {
        current[current.length - 1] = { ...last, tasks: [...last.tasks, spans] }
      } else current.push({ kind: 'task', spans, tasks: [] })
      continue
    }
    const spans = spansOf(line)
    if (!seenTitle) {
      seenTitle = true
      current.push({ kind: 'title', spans, tasks: [] })
    } else if (isItem(line)) current.push({ kind: 'item', spans, tasks: [] })
    else if (spans.length === 1 && spans[0]?.bold === true) current.push({ kind: 'heading', spans, tasks: [] })
    else current.push({ kind: 'text', spans, tasks: [] })
  }
  flush()
  return blocks
}
