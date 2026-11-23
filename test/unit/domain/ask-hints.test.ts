import { describe, expect, it } from 'vitest'
import { type AskHint, matchAskHints, normalizeForMatch } from '../../../src/domain/ask-hints.js'

const hint = (when: string[], text = `text of ${when.join('/')}`): AskHint => ({ when, text })

describe('normalizeForMatch', () => {
  it('lowercases, removes accents and collapses blanks', () => {
    expect(normalizeForMatch('  ¿Qué  ENCARGOS\ttengo? Mañana, Ñandú ')).toBe('¿que encargos tengo? manana, nandu')
  })
})

describe('matchAskHints', () => {
  it('matches a whole word, ignoring case and accents', () => {
    const hints = [hint(['Encárgo'])]
    expect(matchAskHints(hints, '¿Qué ENCARGO tengo?')).toEqual(['text of Encárgo'])
    expect(matchAskHints([hint(['encargo'])], 'qué encárgo tengo')).toEqual(['text of encargo'])
  })

  it('does not match inside another word, nor a plural that is not listed', () => {
    expect(matchAskHints([hint(['encargo'])], 'qué encargos tengo')).toEqual([])
    expect(matchAskHints([hint(['pedido'])], 'qué expedido tengo')).toEqual([])
    expect(matchAskHints([hint(['pedido'])], 'repedido o pedidos')).toEqual([])
    expect(matchAskHints([hint(['encargo', 'encargos'])], 'qué encargos tengo')).toHaveLength(1)
  })

  it('treats Spanish letters as part of a word', () => {
    // Accent-insensitive means the tilde of the ñ folds too: "año" is read as "ano".
    expect(matchAskHints([hint(['ano'])], 'el año pasado')).toHaveLength(1)
    expect(matchAskHints([hint(['ano'])], 'el anoche')).toEqual([])
    expect(matchAskHints([hint(['cafe'])], 'un café')).toHaveLength(1)
    expect(matchAskHints([hint(['cafe'])], 'cafés')).toEqual([])
  })

  it('matches at the edges and next to punctuation', () => {
    const hints = [hint(['torta'])]
    expect(matchAskHints(hints, 'torta')).toHaveLength(1)
    expect(matchAskHints(hints, '¿torta? sí, torta.')).toHaveLength(1)
    expect(matchAskHints(hints, '(torta)')).toHaveLength(1)
  })

  it('matches a phrase with any amount of blanks, and not a part of it', () => {
    const hints = [hint(['torta de cumpleaños'])]
    expect(matchAskHints(hints, 'la TORTA  de   cumpleaños de Ana')).toHaveLength(1)
    expect(matchAskHints(hints, 'la torta cumpleaños')).toEqual([])
    expect(matchAskHints(hints, 'la torta de cumpleaños2')).toEqual([])
  })

  it('treats the terms as text, not as a pattern', () => {
    expect(matchAskHints([hint(['a.c', '(x'])], 'abc')).toEqual([])
    expect(matchAskHints([hint(['a.c', '(x'])], 'mirá a.c ahora')).toHaveLength(1)
  })

  it('applies every matching hint in configuration order, without repeating a text', () => {
    const hints = [
      hint(['uno'], 'A'),
      hint(['dos'], 'B'),
      hint(['tres'], 'A'),
      hint(['cuatro'], 'C'),
      hint(['dos'], 'D'),
    ]
    expect(matchAskHints(hints, 'dos y uno y tres')).toEqual(['A', 'B', 'D'])
  })

  it('gives nothing without hints or without a match', () => {
    expect(matchAskHints([], 'lo que sea')).toEqual([])
    expect(matchAskHints([hint(['encargo'])], 'qué dijo Ana')).toEqual([])
  })

  it('ignores a term that is empty once normalized', () => {
    expect(matchAskHints([hint([' '])], 'algo')).toEqual([])
  })
})
