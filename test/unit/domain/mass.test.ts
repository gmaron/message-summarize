import { describe, expect, it } from 'vitest'
import { codePointLength, findMassTexts, isMassAtReceipt } from '../../../src/domain/mass.js'
import { textOf } from './factories.js'

const sentTo = (text: string | null, ...conversations: string[]) =>
  conversations.map((conversationId) => ({ conversationId, text }))

describe('codePointLength', () => {
  it('counts an emoji outside the BMP as one', () => {
    expect(codePointLength('a😀')).toBe(2)
    expect('a😀'.length).toBe(3)
  })
  it('is 0 for the empty string', () => expect(codePointLength('')).toBe(0))
})

describe('findMassTexts', () => {
  it('flags a text of 40 characters in 3 conversations', () => {
    const t = textOf(40)
    expect(findMassTexts(sentTo(t, 'a', 'b', 'c'))).toEqual(new Set([t]))
  })
  it('does not flag 39 characters', () => {
    expect(findMassTexts(sentTo(textOf(39), 'a', 'b', 'c')).size).toBe(0)
  })
  it('does not flag 40 characters in only 2 conversations', () => {
    expect(findMassTexts(sentTo(textOf(40), 'a', 'b')).size).toBe(0)
  })
  it('counts distinct conversations, not messages', () => {
    expect(findMassTexts(sentTo(textOf(47), 'a', 'a', 'b')).size).toBe(0)
  })
  it('measures the length in code points: 39 code points with 40 UTF-16 units is not mass', () => {
    const e39 = `${textOf(37)}😀 `
    expect(codePointLength(e39)).toBe(39)
    expect(e39.length).toBe(40)
    expect(findMassTexts(sentTo(e39, 'a', 'b', 'c')).size).toBe(0)
  })
  it('flags 40 code points even though it has more UTF-16 units', () => {
    const t = `${textOf(38)}😀 `
    expect(codePointLength(t)).toBe(40)
    expect(findMassTexts(sentTo(t, 'a', 'b', 'c'))).toEqual(new Set([t]))
  })
  it('matches exactly: a near copy or a copy with trailing space is a different text', () => {
    const t = textOf(45)
    const input = [...sentTo(t, 'a', 'b'), ...sentTo(`${t.slice(0, -1)}!`, 'c'), ...sentTo(`${t} `, 'd')]
    expect(findMassTexts(input).size).toBe(0)
  })
  it('does not trim before measuring: 39 characters plus spaces is 40 and counts', () => {
    const t = `${textOf(39)} `
    expect(findMassTexts(sentTo(t, 'a', 'b', 'c'))).toEqual(new Set([t]))
  })
  it('ignores messages without text', () => {
    expect(findMassTexts(sentTo(null, 'a', 'b', 'c')).size).toBe(0)
  })
  it('works with a generator input', () => {
    function* gen() {
      yield* sentTo(textOf(41), 'a', 'b', 'c')
    }
    expect(findMassTexts(gen()).size).toBe(1)
  })
})

describe('isMassAtReceipt', () => {
  it('is mass with 2 other conversations and 40 code points', () => {
    expect(isMassAtReceipt(textOf(40), 2)).toBe(true)
  })
  it('is not mass with only 1 other conversation', () => {
    expect(isMassAtReceipt(textOf(40), 1)).toBe(false)
  })
  it('is not mass below 40 code points', () => {
    expect(isMassAtReceipt(textOf(39), 5)).toBe(false)
  })
  it('measures in code points, like findMassTexts', () => {
    expect(isMassAtReceipt(`${textOf(37)}😀 `, 5)).toBe(false)
    expect(isMassAtReceipt(`${textOf(38)}😀 `, 5)).toBe(true)
  })
})
