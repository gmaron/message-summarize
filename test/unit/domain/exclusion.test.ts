import { describe, expect, it } from 'vitest'
import { exactIdOf, hasIdPattern, idPattern, isExcluded } from '../../../src/domain/exclusion.js'

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
    expect(isExcluded(['43136842'], '9962543136842@s.whatsapp.net', 'Proveedor')).toBe(true)
    expect(isExcluded(['G.US'], '120363@g.us', 'x')).toBe(true)
  })
  it('is a plain substring: "ana" excludes "Mariana"', () => {
    expect(isExcluded(['ana'], 'p1', 'Mariana Paz')).toBe(true)
  })
  it('matches the number shown in an unsaved name but not "+" in the id', () => {
    expect(isExcluded(['+9962744354761'], '9962744354761@s.whatsapp.net', 'Nico ( +9962744354761 )')).toBe(true)
    expect(isExcluded(['+9962744354761'], '9962744354761@s.whatsapp.net', null)).toBe(false)
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
  describe('the exact form id:<conversation id>', () => {
    const mine = '9922979713568@s.whatsapp.net'
    it('matches only that id', () => {
      expect(isExcluded([`id:${mine}`], mine, 'Nico')).toBe(true)
      expect(isExcluded([`id:${mine}`], '9911243739479@s.whatsapp.net', 'Nico')).toBe(false)
    })
    it('is not caught by the substring trap: the id of another chat that contains it is not matched', () => {
      expect(isExcluded([mine], `1${mine}`, 'Other')).toBe(true) // the plain form IS a substring
      expect(isExcluded([`id:${mine}`], `1${mine}`, 'Other')).toBe(false)
      expect(isExcluded([`id:${mine}`], `${mine}x`, 'Other')).toBe(false)
    })
    it('is case-insensitive, in the prefix and in the id', () => {
      expect(isExcluded([`ID:${mine.toUpperCase()}`], mine, null)).toBe(true)
      expect(isExcluded(['id:ABC@g.us'], 'abc@g.us', null)).toBe(true)
    })
    it('never matches by name, and a name that contains the text does not match', () => {
      expect(isExcluded([`id:${mine}`], 'p1', mine)).toBe(false)
      expect(isExcluded(['id:p1'], 'p10', 'id:p1')).toBe(false)
    })
    it('lives next to substring patterns', () => {
      expect(isExcluded(['id:nope', 'gym'], 'a', 'Gym')).toBe(true)
      expect(isExcluded(['id:nope', 'zzz'], 'a', 'Gym')).toBe(false)
    })
    it('idPattern builds it', () => {
      expect(idPattern('x@g.us')).toBe('id:x@g.us')
      expect(isExcluded([idPattern('x@g.us')], 'x@g.us', null)).toBe(true)
    })
  })
  describe('spaces and case in the exact form', () => {
    it('ignores spaces after the prefix and around the id, in the prefix and in the id', () => {
      expect(isExcluded(['id: P1'], 'p1', null)).toBe(true)
      expect(isExcluded(['Id:  p1  '], 'P1', null)).toBe(true)
      expect(isExcluded(['id:p1'], ' p1 ', null)).toBe(true)
    })
    it('"id:" alone matches nothing (the configuration refuses it), not even every chat', () => {
      expect(isExcluded(['id:'], 'p1', 'x')).toBe(false)
      expect(isExcluded(['id:   '], '', null)).toBe(false)
    })
    it('exactIdOf and hasIdPattern normalize', () => {
      expect(exactIdOf('ID: ABC@g.us ')).toBe('abc@g.us')
      expect(exactIdOf('gym')).toBeNull()
      expect(exactIdOf('id:')).toBe('')
      expect(hasIdPattern(['gym', 'ID:ABC@G.US'], 'abc@g.us')).toBe(true)
      expect(hasIdPattern(['gym', 'abc@g.us'], 'abc@g.us')).toBe(false)
    })
  })
})
