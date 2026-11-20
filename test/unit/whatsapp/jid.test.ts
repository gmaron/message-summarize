import { describe, expect, it } from 'vitest'
import {
  addressOf,
  isBroadcastJid,
  isGroupJid,
  isLid,
  isNewsletterJid,
  normalizeJid,
  selfChatJid,
} from '../../../src/infrastructure/whatsapp/jid.js'
import { OwnConversationIds } from '../../../src/infrastructure/whatsapp/own-ids.js'

describe('normalizeJid', () => {
  it('drops the device and agent, and maps c.us to s.whatsapp.net', () => {
    expect(normalizeJid('9911963367943:12@s.whatsapp.net')).toBe('9911963367943@s.whatsapp.net')
    expect(normalizeJid('9911963367943_1:3@s.whatsapp.net')).toBe('9911963367943@s.whatsapp.net')
    expect(normalizeJid('9911963367943@c.us')).toBe('9911963367943@s.whatsapp.net')
    expect(normalizeJid('120363146125332922@g.us')).toBe('120363146125332922@g.us')
    expect(normalizeJid('99900000001:4@lid')).toBe('99900000001@lid')
  })

  it('leaves what is not a jid alone', () => {
    expect(normalizeJid('nothing')).toBe('nothing')
  })
})

describe('jid kinds', () => {
  it('tells LIDs, groups, broadcasts and newsletters apart', () => {
    expect(isLid('99900000001@lid')).toBe(true)
    expect(isLid('9911963367943@s.whatsapp.net')).toBe(false)
    expect(isLid('plain')).toBe(false)
    expect(isGroupJid('120363146125332922@g.us')).toBe(true)
    expect(isBroadcastJid('status@broadcast')).toBe(true)
    expect(isBroadcastJid('9911963367943@s.whatsapp.net')).toBe(false)
    expect(isNewsletterJid('120363278292219878@newsletter')).toBe(true)
  })
})

describe('addressOf', () => {
  it('is +number for a phone number and the raw id for anything else', () => {
    expect(addressOf('9911963367943@s.whatsapp.net')).toBe('+9911963367943')
    expect(addressOf('99900000001@lid')).toBe('99900000001@lid')
    expect(addressOf('120363146125332922@g.us')).toBe('120363146125332922@g.us')
  })
})

describe('OwnConversationIds', () => {
  it('keeps normalized, distinct, non-empty ids and matches any variant of them', () => {
    const own = new OwnConversationIds()
    own.set(['9913174261432:7@s.whatsapp.net', '99900000009@lid', undefined, '', '99900000009:2@lid'])
    expect(own.get()).toEqual(['9913174261432@s.whatsapp.net', '99900000009@lid'])
    expect(own.has('9913174261432:3@s.whatsapp.net')).toBe(true)
    expect(own.has('9911963367943@s.whatsapp.net')).toBe(false)
  })
})

describe('selfChatJid', () => {
  it('is the normalized phone-number jid of the user', () => {
    expect(selfChatJid({ id: '9913174261432:12@s.whatsapp.net' })).toBe('9913174261432@s.whatsapp.net')
    expect(selfChatJid({ id: '9913174261432@c.us' })).toBe('9913174261432@s.whatsapp.net')
    expect(selfChatJid({ id: '9913174261432_1:3@s.whatsapp.net' })).toBe('9913174261432@s.whatsapp.net')
  })

  it('is null for anything that is not an individual phone-number jid', () => {
    expect(selfChatJid(undefined)).toBeNull()
    expect(selfChatJid(null)).toBeNull()
    expect(selfChatJid({})).toBeNull()
    expect(selfChatJid({ id: null })).toBeNull()
    expect(selfChatJid({ id: '' })).toBeNull()
    expect(selfChatJid({ id: 'plain' })).toBeNull()
    expect(selfChatJid({ id: '99900000009:1@lid' })).toBeNull()
    expect(selfChatJid({ id: '120363146125332922@g.us' })).toBeNull()
    expect(selfChatJid({ id: 'status@broadcast' })).toBeNull()
    expect(selfChatJid({ id: '120363278292219878@newsletter' })).toBeNull()
    expect(selfChatJid({ id: '@s.whatsapp.net' })).toBeNull()
    expect(selfChatJid({ id: 'abc@s.whatsapp.net' })).toBeNull()
    expect(selfChatJid({ id: '9913174261432@s.whatsapp.net.evil' })).toBeNull()
    expect(selfChatJid({ id: '9913174261432@s.whatsappXnet' })).toBeNull()
    expect(selfChatJid({ id: '9913174261432@s.whatsapp-net' })).toBeNull()
  })
})
