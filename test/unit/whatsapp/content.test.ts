import { describe, expect, it } from 'vitest'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import {
  parseContent,
  parseEdit,
  parseEditedBody,
  toNumber,
  unwrap,
} from '../../../src/infrastructure/whatsapp/content.js'
import type { WaContent } from '../../../src/infrastructure/whatsapp/wa-types.js'

const es = getCatalog('es')
const en = getCatalog('en')

describe('parseContent: one text per kind, in the language of the account (RF-10)', () => {
  const cases: [string, WaContent, string, string, string][] = [
    ['plain text', { conversation: 'hello' }, 'text', 'hello', 'hello'],
    ['extended text', { extendedTextMessage: { text: 'see you' } }, 'text', 'see you', 'see you'],
    ['image with caption', { imageMessage: { caption: 'the dog' } }, 'image', '[imagen] the dog', '[image] the dog'],
    ['image', { imageMessage: {} }, 'image', '[imagen]', '[image]'],
    ['video with caption', { videoMessage: { caption: 'beach' } }, 'video', '[video] beach', '[video] beach'],
    ['audio', { audioMessage: {} }, 'audio', '[audio]', '[audio]'],
    [
      'document',
      { documentMessage: { fileName: 'plan.pdf', caption: 'read it' } },
      'document',
      '[documento: plan.pdf] read it',
      '[document: plan.pdf] read it',
    ],
    ['document by title', { documentMessage: { title: 'Plan' } }, 'document', '[documento: Plan]', '[document: Plan]'],
    ['unnamed document', { documentMessage: {} }, 'document', '[documento: sin nombre]', '[document: unnamed]'],
    ['sticker', { stickerMessage: {} }, 'sticker', '[sticker]', '[sticker]'],
    [
      'location',
      { locationMessage: { name: 'Home', address: '1 Main St' } },
      'location',
      '[ubicación] Home 1 Main St',
      '[location] Home 1 Main St',
    ],
    ['live location', { liveLocationMessage: { address: 'Park' } }, 'location', '[ubicación] Park', '[location] Park'],
    ['one contact', { contactMessage: { displayName: 'Ana' } }, 'contact', '[contacto: Ana]', '[contact: Ana]'],
    [
      'several contacts',
      { contactsArrayMessage: { contacts: [{ displayName: 'Ana' }, { displayName: 'Beto' }] } },
      'contact',
      '[contactos: Ana, Beto]',
      '[contacts: Ana, Beto]',
    ],
    [
      'poll',
      { pollCreationMessageV3: { name: 'Lunch?', options: [{ optionName: 'Pizza' }, { optionName: 'Sushi' }] } },
      'poll',
      '[encuesta] Lunch?: Pizza / Sushi',
      '[poll] Lunch?: Pizza / Sushi',
    ],
    [
      'event',
      { eventMessage: { name: 'Party', description: 'at 9' } },
      'event',
      '[evento] Party at 9',
      '[event] Party at 9',
    ],
  ]

  for (const [label, content, kind, spanish, english] of cases) {
    it(label, () => {
      expect(parseContent(content, es)).toEqual({ kind, text: spanish })
      expect(parseContent(content, en)).toEqual({ kind, text: english })
    })
  }

  it('returns null for what is not a message of the user, and for an empty text', () => {
    expect(parseContent({}, es)).toBeNull()
    expect(parseContent({ conversation: '' }, es)).toBeNull()
    expect(parseContent({ extendedTextMessage: { text: null } }, es)).toBeNull()
    expect(parseContent({ protocolMessage: { type: 0 } }, es)).toBeNull()
  })
})

describe('unwrap', () => {
  it('goes through wrappers (disappearing, view once, document with caption, device sent)', () => {
    const inner: WaContent = { conversation: 'deep' }
    expect(unwrap({ ephemeralMessage: { message: { viewOnceMessage: { message: inner } } } })).toBe(inner)
    expect(unwrap({ documentWithCaptionMessage: { message: inner } })).toBe(inner)
    expect(unwrap({ deviceSentMessage: { message: inner } })).toBe(inner)
    expect(unwrap(inner)).toBe(inner)
    expect(unwrap(null)).toBeNull()
  })

  it('stops after a bounded number of wrappers', () => {
    let content: WaContent = { conversation: 'x' }
    for (let i = 0; i < 8; i++) content = { ephemeralMessage: { message: content } }
    expect(unwrap(content)?.conversation).toBeUndefined()
  })
})

describe('edits (RF-11)', () => {
  it('an edit protocol message carries the original id and the text with the catalog prefix', () => {
    const content: WaContent = {
      protocolMessage: { type: 14, key: { id: 'ORIG1' }, editedMessage: { conversation: 'new text' } },
    }
    expect(parseEdit(content, es)).toEqual({
      originalId: 'ORIG1',
      parsed: { kind: 'text', text: '(editado) new text' },
    })
    expect(parseEdit(content, en)?.parsed.text).toBe('(edited) new text')
  })

  it('an edit of a caption keeps the kind', () => {
    const edit = parseEditedBody('ORIG2', { imageMessage: { caption: 'fixed' } }, es)
    expect(edit?.parsed).toEqual({ kind: 'image', text: '(editado) [imagen] fixed' })
  })

  it('a protocol message of another type, or without original id, is no edit', () => {
    const other = { protocolMessage: { type: 0, key: { id: 'X' }, editedMessage: { conversation: 'a' } } }
    expect(parseEdit(other, es)).toBeNull()
    expect(parseEdit({ protocolMessage: { type: 14, editedMessage: { conversation: 'a' } } }, es)).toBeNull()
    expect(parseEdit({ conversation: 'a' }, es)).toBeNull()
  })

  it('an edit with nothing to show is dropped', () => {
    expect(parseEditedBody('X', { conversation: '' }, es)).toBeNull()
    expect(parseEditedBody('X', {}, es)).toBeNull()
  })
})

describe('toNumber', () => {
  it('reads numbers, bigints, numeric strings and Long-like objects', () => {
    expect(toNumber(5)).toBe(5)
    expect(toNumber(7n)).toBe(7)
    expect(toNumber('9')).toBe(9)
    expect(toNumber({ toNumber: () => 11 })).toBe(11)
    expect(toNumber(null)).toBeNull()
    expect(toNumber(undefined)).toBeNull()
    expect(toNumber('abc')).toBeNull()
  })
})
