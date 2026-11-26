/**
 * A tiny reader of the simple markdown the answers use: `#` titles, `-` lists (and `1.` lists) and `**bold**`. It does
 * NOT produce HTML: it returns plain data (text pieces with a flag), and the page draws each piece as a text node. The
 * answer is derived from messages written by third parties, so nothing in it can ever become markup, a link or an image:
 * `<script>`, `[x](javascript:...)` or `![x](y)` are just characters.
 */
export interface Inline {
  readonly text: string
  readonly bold: boolean
}

export type Block =
  | {
      readonly kind: 'heading' /** 1 for `#` and `##`, 2 for `###`, 3 for deeper ones. */
      readonly level: 1 | 2 | 3
      readonly inline: readonly Inline[]
    }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | { readonly kind: 'paragraph'; readonly inline: readonly Inline[] }

/** Splits a line into plain and bold pieces. An unclosed `**` stays as written. */
export function parseInline(line: string): Inline[] {
  const pieces: Inline[] = []
  const bold = /\*\*(.+?)\*\*/g
  let from = 0
  for (const match of line.matchAll(bold)) {
    if (match.index > from) pieces.push({ text: line.slice(from, match.index), bold: false })
    pieces.push({ text: match[1] ?? '', bold: true })
    from = match.index + match[0].length
  }
  if (from < line.length) pieces.push({ text: line.slice(from), bold: false })
  return pieces
}

const HEADING = /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/
const BULLET = /^\s*[-*•][ \t]+(.*)$/
const NUMBERED = /^\s*\d{1,3}[.)][ \t]+(.*)$/

/** The blocks of a text: headings, lists and paragraphs (consecutive lines of a paragraph are kept as separate lines of it). */
export function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: Inline[][] } | null = null
  const closeParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join('\n')) })
    paragraph = []
  }
  const closeList = (): void => {
    if (list !== null) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items })
    list = null
  }
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '' || /^\s*-{3,}\s*$/.test(line)) {
      closeParagraph()
      closeList()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      closeParagraph()
      closeList()
      const hashes = (heading[1] ?? '#').length
      blocks.push({
        kind: 'heading',
        level: hashes <= 2 ? 1 : hashes === 3 ? 2 : 3,
        inline: parseInline(heading[2] ?? ''),
      })
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = bullet === null ? NUMBERED.exec(line) : null
    const item = bullet ?? numbered
    if (item !== null) {
      closeParagraph()
      const ordered = numbered !== null
      if (list !== null && list.ordered !== ordered) closeList()
      list ??= { ordered, items: [] }
      list.items.push(parseInline(item[1] ?? ''))
      continue
    }
    closeList()
    paragraph.push(line.trim())
  }
  closeParagraph()
  closeList()
  return blocks
}
