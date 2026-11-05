import { describe, expect, it } from 'vitest'
import { isExcluded } from '../../../src/domain/exclusion.js'

describe('isExcluded', () => {
  it('excludes nothing without patterns', () => {
    expect(isExcluded([], 'x@g.us', 'Gym')).toBe(false)
  })
  it('matches by name', () => expect(isExcluded(['gym'], 'x@g.us', 'Gym Fuerza')).toBe(true))
  it('is case-insensitive in both directions', () => {
    expect(isExcluded(['LAVADERO'], 'a', 'Lavadero Express')).toBe(true)
    expect(isExcluded(['lavadero'], 'a', 'LAVADERO EXPRESS')).toBe(true)
    expect(isExcluded(['CERÁMICA'], 'a', 'Taller de Cerámica')).toBe(true)
  })
  it('matches by identifier', () => {
    expect(isExcluded(['55550203'], '5491155550203@s.whatsapp.net', 'Proveedor')).toBe(true)
    expect(isExcluded(['G.US'], '120363@g.us', 'x')).toBe(true)
  })
  it('is a plain substring: "ana" excludes "Mariana"', () => {
    expect(isExcluded(['ana'], 'p1', 'Mariana Paz')).toBe(true)
  })
  it('matches the number shown in an unsaved name but not "+" in the id', () => {
    expect(isExcluded(['+5491155550205'], '5491155550205@s.whatsapp.net', 'Nico ( +5491155550205 )')).toBe(true)
    expect(isExcluded(['+5491155550205'], '5491155550205@s.whatsapp.net', null)).toBe(false)
  })
  it('does not treat a pattern as a regular expression', () => {
    expect(isExcluded(['a.c'], 'abc', 'abc')).toBe(false)
  })
  it('matches the separator space, so id and name can match together', () => {
    expect(isExcluded(['g.us gym'], 'x@g.us', 'Gym')).toBe(true)
  })
  it('does not match what is not in id or name', () => {
    expect(isExcluded(['ofertas'], 'p1', 'Camila Ortiz')).toBe(false)
  })
  it('works with a null name', () => {
    expect(isExcluded(['p1'], 'p1', null)).toBe(true)
    expect(isExcluded(['null'], 'p1', null)).toBe(false)
  })
  it('excludes when any pattern matches', () => {
    expect(isExcluded(['zzz', 'gym'], 'a', 'Gym')).toBe(true)
  })
})
