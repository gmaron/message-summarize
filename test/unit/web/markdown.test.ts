import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from '../../../src/interfaces/web/lib/markdown.js'

const plain = (pieces: readonly { text: string; bold: boolean }[]) =>
  pieces.map((p) => (p.bold ? `**${p.text}**` : p.text)).join('')

describe('parseInline', () => {
  it('splits bold and plain pieces', () => {
    expect(parseInline('a **b** c **d**')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c ', bold: false },
      { text: 'd', bold: true },
    ])
  })
  it('leaves an unclosed ** as written', () => {
    expect(parseInline('a **b')).toEqual([{ text: 'a **b', bold: false }])
  })
  it('is empty for an empty line', () => {
    expect(parseInline('')).toEqual([])
  })
})

describe('parseMarkdown', () => {
  it('reads titles, bullet and numbered lists and paragraphs', () => {
    const blocks = parseMarkdown(
      '# Uno\n## Dos\n### Tres\n#### Cuatro\n\nTexto **fuerte**\nsigue\n\n- a\n* b\n• c\n\n1. x\n2) y\n',
    )
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'heading', 'heading', 'heading', 'paragraph', 'list', 'list'])
    expect(blocks.filter((b) => b.kind === 'heading').map((b) => (b.kind === 'heading' ? b.level : 0))).toEqual([
      1, 1, 2, 3,
    ])
    const paragraph = blocks[4]
    expect(paragraph?.kind === 'paragraph' && plain(paragraph.inline)).toBe('Texto **fuerte**\nsigue')
    const bullets = blocks[5]
    expect(bullets?.kind === 'list' && bullets.ordered).toBe(false)
    expect(bullets?.kind === 'list' && bullets.items.map(plain)).toEqual(['a', 'b', 'c'])
    const numbered = blocks[6]
    expect(numbered?.kind === 'list' && numbered.ordered).toBe(true)
    expect(numbered?.kind === 'list' && numbered.items.map(plain)).toEqual(['x', 'y'])
  })

  it('never produces HTML: markup, links and images stay as characters of the text', () => {
    const hostile =
      '<script>alert(1)</script>\n## <img src=x onerror=alert(1)>\n- [click](javascript:alert(1))\n- ![x](http://evil/x.png)\n**<b>bold</b>**'
    const blocks = parseMarkdown(hostile)
    const text = JSON.stringify(blocks)
    expect(text).toContain('<script>alert(1)</script>')
    expect(text).toContain('<img src=x onerror=alert(1)>')
    expect(text).toContain('[click](javascript:alert(1))')
    expect(text).toContain('![x](http://evil/x.png)')
    // Data only: every piece is {text, bold}; there is no field that could carry markup, a link or an image.
    const keys = new Set<string>()
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk)
      else if (typeof value === 'object' && value !== null) {
        for (const [k, v] of Object.entries(value)) {
          keys.add(k)
          walk(v)
        }
      }
    }
    walk(blocks)
    expect([...keys].sort()).toEqual(['bold', 'inline', 'items', 'kind', 'level', 'ordered', 'text'])
  })

  it('treats a rule and blank lines as separators, and drops them', () => {
    expect(parseMarkdown('uno\n---\n\n\ndos').map((b) => b.kind)).toEqual(['paragraph', 'paragraph'])
  })

  it('does not take a dash inside a text for a list', () => {
    const [block] = parseMarkdown('Ana - Beto')
    expect(block?.kind).toBe('paragraph')
  })

  it('is empty for an empty text', () => {
    expect(parseMarkdown('')).toEqual([])
  })
})

describe('the Ask page', () => {
  const source = readFileSync(new URL('../../../src/interfaces/web/pages/Ask.svelte', import.meta.url), 'utf8')
  it('never injects HTML: no {@html} and no innerHTML', () => {
    expect(source).not.toMatch(/\{@html/)
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/)
  })
  it('has no mode selector: the only mode is the one text over every chat', () => {
    expect(source).not.toMatch(/perChat|mode\b/)
  })
  it('keeps the textarea limit tied to the shared constant, not a literal', () => {
    expect(source).toContain('maxlength={MAX_QUESTION_CHARS}')
  })
})
