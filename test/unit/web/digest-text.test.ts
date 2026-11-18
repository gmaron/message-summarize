import { describe, expect, it } from 'vitest'
import { parseDigest, spansOf } from '../../../src/interfaces/web/lib/digest-text.js'

const SENT = [
  '*Resumen WhatsApp — mar 10-03, 20:00*',
  '7 chats con novedades desde mar 10-03, 08:00 · 3 necesitan respuesta',
  '',
  '*🔴 Necesitan respuesta*',
  '• *Rosa Molina*: Rosa pide confirmar la reunión del lunes.',
  '   ☐ Confirmar la reunión del lunes y cuántos van',
  '   ☐ Mandar la agenda a Rosa',
  '• *Ana Gómez*: Ana pide el presupuesto de hoy.',
  '',
  '*⚪ El resto*',
  '• *Club de Ajedrez*: Pedro ganó el torneo.',
].join('\n')

describe('the bold spans of a line', () => {
  it('cuts *bold* out of the text and keeps the rest as it is', () => {
    expect(spansOf('• *Rosa*: hola')).toEqual([
      { text: '• ', bold: false },
      { text: 'Rosa', bold: true },
      { text: ': hola', bold: false },
    ])
    expect(spansOf('*a* y *b*')).toEqual([
      { text: 'a', bold: true },
      { text: ' y ', bold: false },
      { text: 'b', bold: true },
    ])
  })

  it('leaves an asterisk with no pair, and "**", as characters', () => {
    expect(spansOf('2 * 3 = 6')).toEqual([{ text: '2 * 3 = 6', bold: false }])
    expect(spansOf('a ** b')).toEqual([{ text: 'a ** b', bold: false }])
    expect(spansOf('')).toEqual([])
  })
})

describe('the blocks of a digest', () => {
  const blocks = parseDigest(SENT)

  it('splits at the blank lines: the head, then one block per section', () => {
    expect(blocks.map((block) => block.length)).toEqual([2, 3, 2])
  })

  it('knows the title, the line under it, the heads of the sections and the items', () => {
    expect(blocks[0]?.map((line) => line.kind)).toEqual(['title', 'text'])
    expect(blocks[1]?.map((line) => line.kind)).toEqual(['heading', 'item', 'item'])
    expect(blocks[1]?.[0]?.spans).toEqual([{ text: '🔴 Necesitan respuesta', bold: true }])
  })

  it('puts the todos under their item, without the indentation', () => {
    const item = blocks[1]?.[1]
    expect(item?.spans[1]).toEqual({ text: 'Rosa Molina', bold: true })
    expect(item?.tasks).toEqual([
      [{ text: '☐ Confirmar la reunión del lunes y cuántos van', bold: false }],
      [{ text: '☐ Mandar la agenda a Rosa', bold: false }],
    ])
    expect(blocks[1]?.[2]?.tasks).toEqual([])
  })

  it('a part that does not start the digest has no title', () => {
    const part = parseDigest('*🟡 Con pendientes*\n• *Luis*: contrato\n   ☐ Firmarlo', false)
    expect(part[0]?.map((line) => line.kind)).toEqual(['heading', 'item'])
    expect(parseDigest('• *Luis*: contrato', false)[0]?.[0]?.kind).toBe('item')
  })

  it('a todo with no item before it is a line of its own', () => {
    expect(parseDigest('*a*\n   ☐ suelta', false)[0]?.map((line) => line.kind)).toEqual(['heading', 'task'])
  })

  it('handles empty text, CRLF and a lot of blank lines', () => {
    expect(parseDigest('')).toEqual([])
    expect(parseDigest('\n\n\n')).toEqual([])
    expect(parseDigest('*T*\r\nlinea\r\n\r\n\r\n• *x*: y').map((block) => block.length)).toEqual([2, 1])
  })
})

describe('text of third parties', () => {
  it('stays text: markup in a name or a summary is never produced, it is only characters of a span', () => {
    const hostile = '*Resumen*\n• *<img src=x onerror=alert(1)>*: <script>alert(1)</script> *<b>no</b>*'
    const lines = parseDigest(hostile).flat()
    const every = lines.flatMap((line) => [...line.spans, ...line.tasks.flat()])
    // every span is a plain string with its characters untouched: it is drawn as a text node
    expect(every.map((span) => span.text).join('')).toContain('<script>alert(1)</script>')
    expect(every.some((span) => span.text === '<img src=x onerror=alert(1)>' && span.bold)).toBe(true)
    for (const span of every) expect(Object.keys(span).sort()).toEqual(['bold', 'text'])
  })
})
