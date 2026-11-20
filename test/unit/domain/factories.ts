import type { Conversation, Message, Participant } from '../../../src/domain/model.js'

export const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'm1',
  conversationId: 'c1',
  senderId: 'p1',
  senderName: null,
  senderAddress: '+9911963367943',
  fromMe: false,
  timestamp: 1_000,
  kind: 'text',
  text: 'hello',
  transcript: null,
  read: false,
  ...overrides,
})

export const participant = (overrides: Partial<Participant> = {}): Participant => ({
  id: 'p1',
  savedName: null,
  publicName: null,
  ...overrides,
})

export const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  isGroup: false,
  participantId: 'p1',
  name: null,
  address: '+9911963367943',
  ...overrides,
})

/** A text of exactly n ASCII characters. */
export const textOf = (n: number, fill = 'x'): string => fill.repeat(n)
