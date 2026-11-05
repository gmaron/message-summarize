import { describe, expect, it } from 'vitest'
import { splitIntoParts } from '../../../src/domain/chunk.js'

describe('splitIntoParts', () => {
  it('joins lines with a newline into one part when they fit', () => {
    expect(splitIntoParts(['aa', 'bb', 'cc'], 10)).toEqual(['aa\nbb\ncc'])
  })
  it('allows a part of exactly max', () => {
    expect(splitIntoParts(['aaaa', 'bbbb'], 9)).toEqual(['aaaa\nbbbb'])
  })
  it('splits when a part would be max + 1', () => {
    expect(splitIntoParts(['aaaa', 'bbbb'], 8)).toEqual(['aaaa', 'bbbb'])
  })
  it('splits only between lines, keeping an oversized line whole', () => {
    const big = 'x'.repeat(20)
    expect(splitIntoParts(['a', big, 'b'], 10)).toEqual(['a', big, 'b'])
  })
  it('keeps a blank line that fits at the end of a part (case a)', () => {
    expect(splitIntoParts(['aaaa', '', 'TITLE'], 6)).toEqual(['aaaa\n', 'TITLE'])
  })
  it('drops a blank line that does not fit, so no part starts with a blank line (case b)', () => {
    const big = 'x'.repeat(20)
    expect(splitIntoParts([big, '', 'TITLE'], 10)).toEqual([big, 'TITLE'])
  })
  it('drops a blank line after a full part', () => {
    expect(splitIntoParts(['aaaa', 'bbbb', '', 'cc'], 9)).toEqual(['aaaa\nbbbb', 'cc'])
  })
  it('has no part for no lines, and drops leading blanks', () => {
    expect(splitIntoParts([])).toEqual([])
    expect(splitIntoParts(['', '', 'a'])).toEqual(['a'])
  })
  it('uses UTF-16 length and 3500 by default', () => {
    const line = '😀'.repeat(1000) // 2000 units
    expect(splitIntoParts([line, line])).toEqual([line, line])
    expect(splitIntoParts(['x'.repeat(1749), 'y'.repeat(1750)])).toHaveLength(1)
    expect(splitIntoParts(['x'.repeat(1750), 'y'.repeat(1750)])).toHaveLength(2)
  })
})
