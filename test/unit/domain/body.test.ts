import { describe, expect, it } from 'vitest'
import { messageBody } from '../../../src/domain/body.js'

describe('messageBody', () => {
  it('returns the text', () => {
    expect(messageBody({ kind: 'text', text: 'hi', transcript: null })).toEqual({ type: 'text', text: 'hi' })
  })
  it('keeps the caption of an image', () => {
    expect(messageBody({ kind: 'image', text: 'look', transcript: null })).toEqual({ type: 'text', text: 'look' })
  })
  it('an image whose text was read keeps its label and caption and carries what it says', () => {
    expect(messageBody({ kind: 'image', text: '[imagen] look', transcript: 'Concert, Friday 8 pm' })).toEqual({
      type: 'image',
      text: '[imagen] look',
      transcript: 'Concert, Friday 8 pm',
    })
  })
  it('an image with an empty transcript (nothing to read) shows as before', () => {
    expect(messageBody({ kind: 'image', text: '[imagen] look', transcript: '' })).toEqual({
      type: 'text',
      text: '[imagen] look',
    })
    expect(messageBody({ kind: 'image', text: null, transcript: 'x' })).toEqual({ type: 'placeholder', kind: 'image' })
  })
  it('returns a placeholder by kind when a non-audio message has no text', () => {
    expect(messageBody({ kind: 'image', text: null, transcript: null })).toEqual({ type: 'placeholder', kind: 'image' })
    expect(messageBody({ kind: 'sticker', text: null, transcript: null })).toEqual({
      type: 'placeholder',
      kind: 'sticker',
    })
  })
  it('an empty text on a non-audio message counts as no text: placeholder by kind', () => {
    expect(messageBody({ kind: 'image', text: '', transcript: null })).toEqual({ type: 'placeholder', kind: 'image' })
    expect(messageBody({ kind: 'text', text: '', transcript: null })).toEqual({ type: 'placeholder', kind: 'text' })
  })
  it('returns the transcript of an audio and ignores its caption', () => {
    expect(messageBody({ kind: 'audio', text: 'caption', transcript: 'spoken' })).toEqual({
      type: 'audio',
      transcript: 'spoken',
    })
  })
  it('an empty or missing transcript is the same: none', () => {
    expect(messageBody({ kind: 'audio', text: 'caption', transcript: '' })).toEqual({ type: 'audio', transcript: null })
    expect(messageBody({ kind: 'audio', text: null, transcript: null })).toEqual({ type: 'audio', transcript: null })
  })
})
