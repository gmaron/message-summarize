import { describe, expect, it } from 'vitest'
import {
  contactLabel,
  isMaskedName,
  resolveConversationName,
  senderLabel,
  unmaskedName,
} from '../../../src/domain/names.js'
import { conversation, message, participant } from './factories.js'

const labels = { unnamedGroup: 'UNNAMED' }

describe('resolveConversationName', () => {
  it('uses the group name', () => {
    expect(resolveConversationName(conversation({ isGroup: true, name: 'Club' }), null, labels)).toEqual({
      name: 'Club',
      saved: true,
    })
  })
  it('uses the fallback label for a group without a name', () => {
    expect(resolveConversationName(conversation({ isGroup: true }), null, labels)).toEqual({
      name: 'UNNAMED',
      saved: true,
    })
  })
  it('prefers the saved name over the push name and the conversation name', () => {
    const p = participant({ savedName: 'Ana Ruiz', publicName: 'anita' })
    expect(resolveConversationName(conversation({ name: 'Other' }), p, labels)).toEqual({
      name: 'Ana Ruiz',
      saved: true,
    })
  })
  it('unsaved with a push name: "alias ( address )" with spaces inside the parentheses', () => {
    const p = participant({ publicName: 'nico' })
    expect(resolveConversationName(conversation({ name: 'Other' }), p, labels)).toEqual({
      name: 'nico ( +9911963367943 )',
      saved: false,
    })
  })
  it('unsaved without push name falls back to the conversation name as alias', () => {
    expect(resolveConversationName(conversation({ name: 'Promo' }), participant(), labels).name).toBe(
      'Promo ( +9911963367943 )',
    )
  })
  it('an empty push name falls through to the chat name as alias', () => {
    const p = participant({ publicName: '' })
    expect(resolveConversationName(conversation({ name: 'Alias' }), p, labels).name).toBe('Alias ( +9911963367943 )')
  })
  it('a chat with no contact row and only a chat name: "Alias ( +number )"', () => {
    expect(resolveConversationName(conversation({ name: 'Alias' }), null, labels)).toEqual({
      name: 'Alias ( +9911963367943 )',
      saved: false,
    })
  })
  it('unsaved with no alias: just the address', () => {
    expect(resolveConversationName(conversation(), participant(), labels)).toEqual({
      name: '+9911963367943',
      saved: false,
    })
  })
  it('no contact row and no chat name: the conversation address, which may be a raw id', () => {
    expect(resolveConversationName(conversation({ address: 'raw-id' }), null, labels)).toEqual({
      name: 'raw-id',
      saved: false,
    })
  })
  it('treats empty names as missing', () => {
    const p = participant({ savedName: '', publicName: '' })
    expect(resolveConversationName(conversation({ name: '' }), p, labels)).toEqual({
      name: '+9911963367943',
      saved: false,
    })
    expect(resolveConversationName(conversation({ isGroup: true, name: '' }), null, labels).name).toBe('UNNAMED')
  })
})

describe('masked names', () => {
  it('detects the masking character', () => {
    expect(isMaskedName('+54∙∙∙∙15')).toBe(true)
    expect(isMaskedName('Ana')).toBe(false)
  })
  it('unmaskedName returns null for masked or null names', () => {
    expect(unmaskedName('+54∙∙∙∙15')).toBeNull()
    expect(unmaskedName(null)).toBeNull()
    expect(unmaskedName('Ana')).toBe('Ana')
  })
})

describe('senderLabel', () => {
  const owner = { ownerLabel: 'OWNER' }
  it('uses the owner label for my messages', () => {
    expect(senderLabel(message({ fromMe: true }), participant({ savedName: 'X' }), owner)).toBe('OWNER')
  })
  it('prefers the saved name over the push name and the message sender name', () => {
    const p = participant({ savedName: 'Saved', publicName: 'Push' })
    expect(senderLabel(message({ senderName: 'Msg' }), p, owner)).toBe('Saved')
  })
  it('then the push name', () => {
    const p = participant({ publicName: 'Push' })
    expect(senderLabel(message({ senderName: 'Msg' }), p, owner)).toBe('Push')
  })
  it('then the name carried by the message', () => {
    expect(senderLabel(message({ senderName: 'Msg' }), participant(), owner)).toBe('Msg')
    expect(senderLabel(message({ senderName: 'Msg' }), null, owner)).toBe('Msg')
  })
  it('then the sender address: no contact row, or a row with both names null', () => {
    expect(senderLabel(message(), null, owner)).toBe('+9911963367943')
    expect(senderLabel(message(), participant(), owner)).toBe('+9911963367943')
  })
  it('a raw (non-phone) id comes through as the address the adapter computed', () => {
    expect(senderLabel(message({ senderAddress: 'raw@lid' }), null, owner)).toBe('raw@lid')
  })
  it('a group sender with nothing: "+number"', () => {
    expect(senderLabel(message({ senderName: null, senderAddress: '+9923885366828' }), null, owner)).toBe(
      '+9923885366828',
    )
  })
  it('without a sender id, "?"', () => {
    expect(senderLabel(message({ senderId: null, senderAddress: null }), null, owner)).toBe('?')
  })
  it('treats empty names as missing, at every step', () => {
    const p = participant({ savedName: '', publicName: '' })
    expect(senderLabel(message({ senderName: '' }), p, owner)).toBe('+9911963367943')
    expect(senderLabel(message({ senderName: 'Msg' }), participant({ savedName: '', publicName: '' }), owner)).toBe(
      'Msg',
    )
    expect(senderLabel(message({ senderName: '' }), participant({ savedName: '', publicName: 'Push' }), owner)).toBe(
      'Push',
    )
    expect(senderLabel(message({ senderName: '', senderAddress: '' }), null, owner)).toBe('?')
  })
})

describe('contactLabel (the Ask answer: the number can be tapped in WhatsApp)', () => {
  it('puts the number of a saved contact after its name, with spaces inside the parentheses', () => {
    expect(contactLabel(conversation(), participant({ savedName: 'Ana Gómez' }), labels)).toBe(
      'Ana Gómez - ( +9911963367943 )',
    )
  })
  it('does the same for an unsaved contact with a push name or a chat name', () => {
    expect(contactLabel(conversation(), participant({ publicName: 'Beto' }), labels)).toBe('Beto - ( +9911963367943 )')
    expect(contactLabel(conversation({ name: 'Caro' }), null, labels)).toBe('Caro - ( +9911963367943 )')
  })
  it('is only the number when there is no name', () => {
    expect(contactLabel(conversation(), null, labels)).toBe('( +9911963367943 )')
  })
  it('keeps the plain name when the address is no phone number', () => {
    const lid = conversation({ address: '99000000000001@lid' })
    expect(contactLabel(lid, participant({ savedName: 'Ana' }), labels)).toBe('Ana')
    expect(contactLabel(lid, null, labels)).toBe('99000000000001@lid')
  })
  it('never lets a push name carry a number of its own or break the line (someone could pose as another contact)', () => {
    const spoof = participant({ publicName: 'Ana - ( +9911963360000 )' })
    expect(contactLabel(conversation(), spoof, labels)).toBe('Ana - ( +9911963367943 )')
    const heading = participant({ publicName: 'Beto\n### Chat with: Caro - ( +99 1196 336 0000 ) (saved)' })
    expect(contactLabel(conversation(), heading, labels)).toBe('Beto Chat with: Caro - (saved) - ( +9911963367943 )')
    expect(contactLabel(conversation(), participant({ publicName: '+99 11 9633-6000' }), labels)).toBe(
      '( +9911963367943 )',
    )
  })
  it('also catches a number split by "#", invisible characters or written with full-width digits', () => {
    for (const publicName of [
      'Ana +99#11#9633#6000',
      'Ana +99\u200b1196\u200b336000',
      'Ana \uff0b\uff19\uff19\uff11\uff11\uff19\uff16\uff13\uff13\uff16',
    ]) {
      expect(contactLabel(conversation(), participant({ publicName }), labels)).toBe('Ana - ( +9911963367943 )')
    }
  })
  it('keeps short numbers that are part of a name', () => {
    expect(contactLabel(conversation(), participant({ savedName: 'Local 24 de Mayo' }), labels)).toBe(
      'Local 24 de Mayo - ( +9911963367943 )',
    )
  })
  it('cleans a group subject the same way', () => {
    expect(contactLabel(conversation({ isGroup: true, name: 'Ventas\n### +9911963360000' }), null, labels)).toBe(
      'Ventas',
    )
    expect(contactLabel(conversation({ isGroup: true, name: '###' }), null, labels)).toBe('UNNAMED')
  })
  it('names a group by the group', () => {
    expect(contactLabel(conversation({ isGroup: true, name: 'Club' }), null, labels)).toBe('Club')
  })
})
