import { describe, expect, it } from 'vitest'
import {
  ASK_MAX_PENDING_PER_CHAT,
  isUsefulMessage,
  isUsefulOwn,
  lastUsefulOwn,
  pickUnanswered,
} from '../../../src/domain/ask-selection.js'
import { ASK_CONTEXT_MESSAGES } from '../../../src/domain/ask-text.js'
import type { Message } from '../../../src/domain/model.js'
import { message } from './factories.js'

const MASS = 'Big sale this weekend only, write me to order your pieces now!'
const mass = new Set([MASS])
const theirs = (id: string, timestamp: number, overrides: Partial<Message> = {}) =>
  message({ id, timestamp, fromMe: false, text: `text ${id}`, ...overrides })
const mine = (id: string, timestamp: number, overrides: Partial<Message> = {}) =>
  message({ id, timestamp, fromMe: true, senderId: null, text: `reply ${id}`, ...overrides })
const ids = (messages: readonly Message[]) => messages.map((m) => m.id)

describe('what says something', () => {
  const cases: [string, Partial<Message>, boolean][] = [
    ['a text', { text: 'hola' }, true],
    ['a blank text', { text: '   ' }, false],
    ['an empty text', { text: '' }, false],
    ['no text, not an audio', { text: null, kind: 'image' }, false],
    ['no text, an audio', { text: null, kind: 'audio' }, true],
    ['a blank text on an audio', { text: '  ', kind: 'audio' }, true],
    ['a blank text on a text', { text: '  ', kind: 'text' }, false],
  ]

  it.each(cases)('a message of someone else with %s: useful to read is %s', (_name, overrides, useful) => {
    expect(isUsefulMessage(theirs('a', 1, overrides))).toBe(useful)
  })

  it.each(cases)('an own message with %s: a useful answer is %s', (_name, overrides, useful) => {
    expect(isUsefulOwn(mass, mine('a', 1, overrides))).toBe(useful)
  })

  it('an own mass message is not an answer, and a message of someone else never is', () => {
    expect(isUsefulOwn(mass, mine('a', 1, { text: MASS }))).toBe(false)
    expect(isUsefulOwn(mass, theirs('b', 1, { text: 'hola' }))).toBe(false)
    expect(isUsefulOwn(mass, theirs('c', 1, { text: MASS }))).toBe(false)
  })
})

describe('lastUsefulOwn', () => {
  it('is the newest own message that says something, skipping mass and empty ones', () => {
    const newestFirst = [
      mine('mass', 50, { text: MASS }),
      mine('blank', 40, { text: ' ' }),
      mine('real', 30),
      mine('older', 10),
    ]
    expect(lastUsefulOwn(newestFirst, mass)).toBe(30)
  })

  it('is undefined when the owner never said anything useful', () => {
    expect(lastUsefulOwn([], mass)).toBeUndefined()
    expect(lastUsefulOwn([mine('mass', 50, { text: MASS })], mass)).toBeUndefined()
  })
})

describe('pickUnanswered', () => {
  const NONE = { messages: [], contextBefore: null, contextLimit: ASK_CONTEXT_MESSAGES }

  it('takes what others wrote after the owner last answered, oldest first, and reads the context before it', () => {
    const window = [theirs('a', 10), mine('r', 20), theirs('b', 30), theirs('c', 40)]
    const pick = pickUnanswered(false, window, [mine('r', 20)], mass, 0)
    expect(ids(pick.messages)).toEqual(['b', 'c'])
    expect(pick.contextBefore).toBe(30)
    expect(pick.contextLimit).toBe(ASK_CONTEXT_MESSAGES)
  })

  it('a message at the very time of the answer is not pending', () => {
    const pick = pickUnanswered(false, [theirs('a', 20), theirs('b', 21)], [mine('r', 20)], mass, 0)
    expect(ids(pick.messages)).toEqual(['b'])
  })

  it('leaves out the owner’s own messages and what has nothing to read, and keeps audios', () => {
    const window = [
      theirs('image', 30, { text: null, kind: 'image' }),
      theirs('blank', 31, { text: ' ' }),
      theirs('audio', 32, { text: null, kind: 'audio' }),
      mine('late-own', 33),
      theirs('text', 34),
    ]
    expect(ids(pickUnanswered(false, window, [mine('r', 20)], mass, 0).messages)).toEqual(['audio', 'text'])
  })

  it('an individual chat the owner never wrote in is all unanswered, with no context to read', () => {
    const pick = pickUnanswered(false, [theirs('a', 10), theirs('b', 20)], [], mass, 0)
    expect(ids(pick.messages)).toEqual(['a', 'b'])
    expect(pick.contextBefore).toBeNull()
  })

  it('a group the owner never wrote in has nothing unanswered, but one they did write in does', () => {
    expect(pickUnanswered(true, [theirs('a', 10)], [], mass, 0)).toEqual(NONE)
    expect(pickUnanswered(true, [theirs('a', 10)], [mine('mass', 5, { text: MASS })], mass, 0)).toEqual(NONE)
    expect(ids(pickUnanswered(true, [theirs('a', 10)], [mine('r', 5)], mass, 0).messages)).toEqual(['a'])
  })

  it('an own mass message does not count as an answer', () => {
    const pick = pickUnanswered(false, [theirs('a', 10), theirs('b', 30)], [mine('mass', 20, { text: MASS })], mass, 0)
    expect(ids(pick.messages)).toEqual(['a', 'b'])
  })

  it('counts what was pending before the window, but only for a chat with something pending inside it', () => {
    const window = [theirs('old', 10), theirs('new', 100)]
    expect(ids(pickUnanswered(false, window, [mine('r', 5)], mass, 100).messages)).toEqual(['old', 'new'])
    expect(ids(pickUnanswered(false, window, [mine('r', 5)], mass, 101).messages)).toEqual([])
    expect(pickUnanswered(false, [theirs('old', 10)], [mine('r', 5)], mass, 11)).toEqual(NONE)
  })

  it('skips a chat with nothing pending', () => {
    expect(pickUnanswered(false, [theirs('a', 10), mine('r', 20)], [mine('r', 20)], mass, 0)).toEqual(NONE)
    expect(pickUnanswered(false, [], [], mass, 0)).toEqual(NONE)
  })

  it('keeps the latest ones of a long pending list, and then reads no context (what is before is pending too)', () => {
    const many = Array.from({ length: ASK_MAX_PENDING_PER_CHAT + 5 }, (_, i) => theirs(`m${i}`, 100 + i))
    const pick = pickUnanswered(false, many, [mine('r', 50)], mass, 0)
    expect(pick.messages).toHaveLength(ASK_MAX_PENDING_PER_CHAT)
    expect(pick.messages[0]?.id).toBe('m5')
    expect(pick.messages.at(-1)?.id).toBe(`m${ASK_MAX_PENDING_PER_CHAT + 4}`)
    expect(pick.contextBefore).toBeNull()
    const exact = pickUnanswered(false, many.slice(5), [mine('r', 50)], mass, 0)
    expect(exact.messages).toHaveLength(ASK_MAX_PENDING_PER_CHAT)
    expect(exact.contextBefore).toBe(105)
  })
})
