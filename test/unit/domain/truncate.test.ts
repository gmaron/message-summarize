import { describe, expect, it } from 'vitest'
import { truncateTranscript } from '../../../src/domain/truncate.js'

describe('truncateTranscript (RF-37)', () => {
  it('does not cut a text of exactly the limit', () => {
    expect(truncateTranscript('abcde', 5)).toEqual({ text: 'abcde', truncated: false })
  })
  it('keeps the last characters, dropping the first, when one over', () => {
    expect(truncateTranscript('abcdef', 5)).toEqual({ text: 'bcdef', truncated: true })
  })
  it('cuts in the middle of a line', () => {
    expect(truncateTranscript('first line\nsecond line', 11)).toEqual({
      text: '\nsecond line'.slice(1),
      truncated: true,
    })
  })
  it('can split a surrogate pair, leaving the second half', () => {
    const r = truncateTranscript('😀abc', 4)
    expect(r.truncated).toBe(true)
    expect(r.text).toHaveLength(4)
    expect(r.text.charCodeAt(0)).toBe('😀'.charCodeAt(1))
  })
  it('keeps a short text whole', () => {
    expect(truncateTranscript('ab', 100)).toEqual({ text: 'ab', truncated: false })
  })
  it('a limit of 0 keeps nothing', () => {
    expect(truncateTranscript('abc', 0)).toEqual({ text: '', truncated: true })
  })
})
