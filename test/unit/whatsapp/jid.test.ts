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
    expect(normalizeJid('5491100000001:12@s.whatsapp.net')).toBe('5491100000001@s.whatsapp.net')
    expect(normalizeJid('5491100000001_1:3@s.whatsapp.net')).toBe('5491100000001@s.whatsapp.net')
    expect(normalizeJid('5491100000001@c.us')).toBe('5491100000001@s.whatsapp.net')
    expect(normalizeJid('120363000000000001@g.us')).toBe('120363000000000001@g.us')
    expect(normalizeJid('99900000001:4@lid')).toBe('99900000001@lid')
  })

  it('leaves what is not a jid alone', () => {
    expect(normalizeJid('nothing')).toBe('nothing')
  })
})

describe('jid kinds', () => {
  it('tells LIDs, groups, broadcasts and newsletters apart', () => {
    expect(isLid('99900000001@lid')).toBe(true)
    expect(isLid('5491100000001@s.whatsapp.net')).toBe(false)
    expect(isLid('plain')).toBe(false)
    expect(isGroupJid('120363000000000001@g.us')).toBe(true)
    expect(isBroadcastJid('status@broadcast')).toBe(true)
    expect(isBroadcastJid('5491100000001@s.whatsapp.net')).toBe(false)
    expect(isNewsletterJid('120363000000000002@newsletter')).toBe(true)
  })
})

describe('addressOf', () => {
  it('is +number for a phone number and the raw id for anything else', () => {
    expect(addressOf('5491100000001@s.whatsapp.net')).toBe('+5491100000001')
    expect(addressOf('99900000001@lid')).toBe('99900000001@lid')
    expect(addressOf('120363000000000001@g.us')).toBe('120363000000000001@g.us')
  })
})

describe('OwnConversationIds', () => {
  it('keeps normalized, distinct, non-empty ids and matches any variant of them', () => {
    const own = new OwnConversationIds()
    own.set(['5491100000009:7@s.whatsapp.net', '99900000009@lid', undefined, '', '99900000009:2@lid'])
    expect(own.get()).toEqual(['5491100000009@s.whatsapp.net', '99900000009@lid'])
    expect(own.has('5491100000009:3@s.whatsapp.net')).toBe(true)
    expect(own.has('5491100000001@s.whatsapp.net')).toBe(false)
  })
})

describe('selfChatJid', () => {
  it('is the normalized phone-number jid of the user', () => {
    expect(selfChatJid({ id: '5491100000009:12@s.whatsapp.net' })).toBe('5491100000009@s.whatsapp.net')
    expect(selfChatJid({ id: '5491100000009@c.us' })).toBe('5491100000009@s.whatsapp.net')
    expect(selfChatJid({ id: '5491100000009_1:3@s.whatsapp.net' })).toBe('5491100000009@s.whatsapp.net')
  })

  it('is null for anything that is not an individual phone-number jid', () => {
    expect(selfChatJid(undefined)).toBeNull()
    expect(selfChatJid(null)).toBeNull()
    expect(selfChatJid({})).toBeNull()
    expect(selfChatJid({ id: null })).toBeNull()
    expect(selfChatJid({ id: '' })).toBeNull()
    expect(selfChatJid({ id: 'plain' })).toBeNull()
    expect(selfChatJid({ id: '99900000009:1@lid' })).toBeNull()
    expect(selfChatJid({ id: '120363000000000001@g.us' })).toBeNull()
    expect(selfChatJid({ id: 'status@broadcast' })).toBeNull()
    expect(selfChatJid({ id: '120363000000000002@newsletter' })).toBeNull()
    expect(selfChatJid({ id: '@s.whatsapp.net' })).toBeNull()
    expect(selfChatJid({ id: 'abc@s.whatsapp.net' })).toBeNull()
    expect(selfChatJid({ id: '5491100000009@s.whatsapp.net.evil' })).toBeNull()
    expect(selfChatJid({ id: '5491100000009@s.whatsappXnet' })).toBeNull()
    expect(selfChatJid({ id: '5491100000009@s.whatsapp-net' })).toBeNull()
  })
})
