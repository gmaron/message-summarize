import { describe, expect, it } from 'vitest'
import {
  ASK_DELIVERY_PART_MAX,
  ASK_MAX_TOTAL_CHARS,
  ASK_PART_CHARS,
  type AskBlock,
  buildParts,
  cleanQuestion,
  deliveryParts,
  isNothing,
  MAX_QUESTION_CHARS,
  totalChars,
  toWhatsApp,
} from '../../../src/domain/ask-text.js'

describe('limits', () => {
  it('are the agreed ones', () => {
    expect([MAX_QUESTION_CHARS, ASK_PART_CHARS, ASK_MAX_TOTAL_CHARS]).toEqual([4000, 150_000, 1_200_000])
  })
})

describe('cleanQuestion', () => {
  it('keeps line breaks, collapses runs of blanks and of blank lines, and drops control characters', () => {
    expect(cleanQuestion('  Pedidos:\r\n\r\n\r\n\r\n-  uno\t\tdos  \n- tres\u0000\u0007 ')).toBe(
      'Pedidos:\n\n- uno dos\n- tres',
    )
  })

  it('turns a tab or a vertical tab into a blank and trims every line end', () => {
    expect(cleanQuestion('a \t \n \t b')).toBe('a\nb')
  })

  it.each([
    ['a lone carriage return is a line break', 'a\rb', 'a\nb'],
    ['a control character is a blank, not nothing', 'a\u0001b', 'a b'],
    ['a blank after a line break goes', 'a\n b', 'a\nb'],
    ['a blank before a line break goes', 'a \nb', 'a\nb'],
    [
      'blanks at the start do not take room from the text',
      ` ${'a'.repeat(MAX_QUESTION_CHARS + 5)}`,
      'a'.repeat(MAX_QUESTION_CHARS),
    ],
    [
      'no blank is left at the end after the cut',
      `${'a'.repeat(MAX_QUESTION_CHARS - 1)} b`,
      'a'.repeat(MAX_QUESTION_CHARS - 1),
    ],
  ])('%s', (_name, text, expected) => {
    expect(cleanQuestion(text)).toBe(expected)
  })

  it('is empty for blanks and control characters only', () => {
    expect(cleanQuestion(' \n\u0001\t ')).toBe('')
  })

  it('cuts at the limit', () => {
    expect(cleanQuestion('a'.repeat(MAX_QUESTION_CHARS + 500))).toHaveLength(MAX_QUESTION_CHARS)
  })
})

describe('isNothing', () => {
  it.each(['NADA', 'nada', ' Nada. ', '"NOTHING"', '**NOTHING**', 'nothing\n'])('is true for %j', (text) => {
    expect(isNothing(text)).toBe(true)
  })
  it.each(['NADA de pedidos hoy', 'Nothing was ordered', '', '-', 'nada\nPedro pidió una torta'])(
    'is false for %j',
    (text) => {
      expect(isNothing(text)).toBe(false)
    },
  )
})

const block = (name: string, lines: string[]): AskBlock => ({
  heading: (continued) => `### ${name}${continued ? ' (sigue)' : ''}`,
  lines,
})

describe('buildParts', () => {
  it('puts everything in one part when it fits, chats separated by a blank line', () => {
    expect(buildParts([block('A', ['a1', 'a2']), block('B', ['b1'])], 100)).toEqual(['### A\na1\na2\n\n### B\nb1'])
  })

  it('starts a new part when the next chat does not fit, keeping chats whole', () => {
    const parts = buildParts(
      [block('A', ['x'.repeat(30)]), block('B', ['y'.repeat(30)]), block('C', ['z'.repeat(10)])],
      50,
    )
    expect(parts).toEqual([`### A\n${'x'.repeat(30)}`, `### B\n${'y'.repeat(30)}`, `### C\n${'z'.repeat(10)}`])
  })

  it('splits a chat bigger than a part between lines and repeats the heading with the continued mark', () => {
    const lines = ['1'.repeat(20), '2'.repeat(20), '3'.repeat(20), '4'.repeat(20)]
    const parts = buildParts([block('Big', lines)], 60)
    expect(parts[0]?.startsWith('### Big\n')).toBe(true)
    expect(parts.slice(1).every((p) => p.startsWith('### Big (sigue)\n'))).toBe(true)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.length <= 60)).toBe(true)
    // Nothing is lost or repeated.
    const text = parts.join('\n')
    for (const line of lines) expect(text.split(line)).toHaveLength(2)
  })

  it('cuts a line longer than a part and never makes a part over the limit', () => {
    const parts = buildParts([block('Huge', ['q'.repeat(500)])], 80)
    expect(parts.every((p) => p.length <= 80)).toBe(true)
    expect(
      parts
        .join('')
        .replace(/### Huge( \(sigue\))?/g, '')
        .replaceAll('\n', ''),
    ).toBe('q'.repeat(500))
  })

  it('starts the part after an oversized chat clean', () => {
    const parts = buildParts(
      [block('Big', ['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50)]), block('Small', ['s'])],
      80,
    )
    expect(parts.at(-1)).toBe('### Small\ns')
  })

  it('a chat that fits exactly in what is left of the part stays in it; one character more starts the next', () => {
    const blocks = [block('A', ['a'.repeat(10)]), block('B', ['b'.repeat(10)])]
    expect(buildParts(blocks, 34)).toEqual([`### A\n${'a'.repeat(10)}\n\n### B\n${'b'.repeat(10)}`])
    expect(buildParts(blocks, 33)).toEqual([`### A\n${'a'.repeat(10)}`, `### B\n${'b'.repeat(10)}`])
  })

  it('fills a piece of an oversized chat up to the limit and not one character more', () => {
    const big = (second: number) => buildParts([block('Big', ['a'.repeat(44), 'b'.repeat(second), 'c'])], 60)
    expect(big(7)).toEqual([`### Big\n${'a'.repeat(44)}\nbbbbbbb`, '### Big (sigue)\nc'])
    expect(big(8)).toEqual([`### Big\n${'a'.repeat(44)}`, '### Big (sigue)\nbbbbbbbb\nc'])
  })

  it('keeps an empty line of an oversized chat, and a line as long as the room is not followed by an empty one', () => {
    const parts = buildParts([block('Big', ['a'.repeat(20), '', 'b'.repeat(40), 'c'.repeat(44)])], 60)
    expect(parts[0]).toBe(`### Big\n${'a'.repeat(20)}\n`)
    expect(parts).toHaveLength(3)
    expect(parts[2]).toBe(`### Big (sigue)\n${'c'.repeat(44)}`)
  })

  it('an oversized chat starts its own part: what came before is not mixed with its first piece', () => {
    const parts = buildParts(
      [block('Small', ['s']), block('Big', ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)])],
      60,
    )
    expect(parts[0]).toBe('### Small\ns')
    expect(parts[1]?.startsWith('### Big\n')).toBe(true)
  })

  it('makes no part for nothing', () => {
    expect(buildParts([], 100)).toEqual([])
  })

  it('counts the total with the separators between parts', () => {
    expect(totalChars(['abc', 'de'])).toBe(3 + 2 + 2)
    expect(totalChars([])).toBe(0)
  })
})

describe('toWhatsApp', () => {
  it('turns titles into a bold line, bold into WhatsApp bold and list dashes into bullets', () => {
    const markdown = '## Pedidos\n\n- **Ana**: una torta\n  - para el sábado\n* Beto: dos\n\n### Pendientes\n1. llamar'
    expect(toWhatsApp(markdown)).toBe(
      '*Pedidos*\n\n• *Ana*: una torta\n  • para el sábado\n• Beto: dos\n\n*Pendientes*\n1. llamar',
    )
  })

  it('leaves a tappable number as is: "name - ( +number )", with the spaces inside the parentheses', () => {
    expect(toWhatsApp('- Ana Gómez - ( +9911963367943 ): 3 cajas')).toBe('• Ana Gómez - ( +9911963367943 ): 3 cajas')
    expect(toWhatsApp('### Beto - ( +9911963367944 )')).toBe('*Beto - ( +9911963367944 )*')
  })

  it('removes rules and extra blank lines, and trims', () => {
    expect(toWhatsApp('\n\nuno\n---\n\n\n\ndos\n\n')).toBe('uno\n\ndos')
  })

  it.each([
    ['a lone carriage return is a line break', '## T\rtext\rmore', '*T*\ntext\nmore'],
    ['a title only at the start of a line', 'see ## here', 'see ## here'],
    ['a title with several blanks after the marks', '##  Title', '*Title*'],
    ['a bullet with several blanks after the dash', '-  item', '• item'],
    ['a rule only when it is the whole line', 'a---b\nwait ---\n---not a rule\n----', 'a---b\nwait ---\n---not a rule'],
  ])('%s', (_name, markdown, expected) => {
    expect(toWhatsApp(markdown)).toBe(expected)
  })

  it('does not touch a dash that is not a list marker', () => {
    expect(toWhatsApp('Ana - Beto, 3-4 piezas, -5')).toBe('Ana - Beto, 3-4 piezas, -5')
  })
})

describe('deliveryParts', () => {
  it('sends the header first and then the answer cut between lines like the digest', () => {
    const body = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(1000)).join('\n')
    const parts = deliveryParts('HEADER', body)
    expect(parts[0]).toBe('HEADER')
    expect(parts.length).toBeGreaterThan(2)
    expect(parts.every((p) => p.length <= ASK_DELIVERY_PART_MAX)).toBe(true)
    expect(parts.slice(1).join('\n')).toBe(body)
  })

  it('cuts a line that is a whole number of parts without a last empty piece', () => {
    expect(deliveryParts('H', 'abcdef', 3)).toEqual(['H', 'abc', 'def'])
    expect(deliveryParts('H', 'abcdefg', 3)).toEqual(['H', 'abc', 'def', 'g'])
  })

  it('cuts a line longer than a part', () => {
    const parts = deliveryParts('H', 'x'.repeat(ASK_DELIVERY_PART_MAX * 2 + 5))
    expect(parts.every((p) => p.length <= ASK_DELIVERY_PART_MAX)).toBe(true)
    expect(parts.slice(1).join('')).toHaveLength(ASK_DELIVERY_PART_MAX * 2 + 5)
  })
})
