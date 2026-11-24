import { describe, expect, it } from 'vitest'
import type { UnreadState } from '../../../src/domain/model.js'
import { CONTEXT_MESSAGES, selectUnreadTail } from '../../../src/domain/unread.js'

const win = [
  { id: 'a', timestamp: 10 },
  { id: 'b', timestamp: 20 },
  { id: 'c', timestamp: 30 },
  { id: 'd', timestamp: 40 },
]
const count = (n: number): UnreadState => ({ kind: 'count', count: n })
const ids = (r: { messages: readonly { id: string }[] }) => r.messages.map((m) => m.id)

describe('selectUnreadTail', () => {
  it('exports the context size', () => expect(CONTEXT_MESSAGES).toBe(5))

  it('markedUnread: every window message, no context, whatever lastIncoming says', () => {
    const r = selectUnreadTail({ kind: 'markedUnread' }, win, [])
    expect(ids(r)).toEqual(['a', 'b', 'c', 'd'])
    expect(r.contextBefore).toBeNull()
  })

  it('unknown state: skipped even if messages look unread', () => {
    const r = selectUnreadTail({ kind: 'unknown' }, win, [{ id: 'a', read: false }])
    expect(r).toEqual({ messages: [], contextBefore: null })
  })

  it('count 0: skipped even with stale unread messages', () => {
    const r = selectUnreadTail(count(0), win, [{ id: 'a', read: false }])
    expect(r).toEqual({ messages: [], contextBefore: null })
  })

  it('a negative count (a sentinel, not a number of messages) is skipped like zero', () => {
    const r = selectUnreadTail(count(-1), win, [
      { id: 'd', read: false },
      { id: 'c', read: false },
    ])
    expect(r).toEqual({ messages: [], contextBefore: null })
  })

  it('starts at the first unread message in the window and asks for context before it', () => {
    const r = selectUnreadTail(count(2), win, [
      { id: 'd', read: false },
      { id: 'b', read: false },
    ])
    expect(ids(r)).toEqual(['b', 'c', 'd'])
    expect(r.contextBefore).toBe(20)
  })

  it('keeps read and own messages that come after the first unread one', () => {
    const r = selectUnreadTail(count(1), win, [{ id: 'b', read: false }])
    expect(ids(r)).toEqual(['b', 'c', 'd'])
  })

  it('filters read messages after taking the last N: the tail starts at the first unread one', () => {
    // last 3 incoming (newest first): d (read), c (unread), a (read)... c is the first unread
    const r = selectUnreadTail(count(3), win, [
      { id: 'd', read: true },
      { id: 'c', read: false },
      { id: 'a', read: true },
    ])
    expect(ids(r)).toEqual(['c', 'd'])
    expect(r.contextBefore).toBe(30)
  })

  it('takes the limit before dropping read messages: an unread one beyond N does not count', () => {
    // N = 1: only 'd' is among the last incoming and it is read. 'c' is unread but is the 2nd, so it is not unread.
    const r = selectUnreadTail(count(1), win, [
      { id: 'd', read: true },
      { id: 'c', read: false },
    ])
    expect(r).toEqual({ messages: [], contextBefore: null })
  })

  it('does not look past N: an older unread message is context, not tail', () => {
    const r = selectUnreadTail(count(1), win, [
      { id: 'c', read: false },
      { id: 'a', read: false },
    ])
    expect(ids(r)).toEqual(['c', 'd'])
  })

  it('counts only the first N even when the caller passes more', () => {
    const r = selectUnreadTail(count(2), win, [
      { id: 'd', read: false },
      { id: 'c', read: false },
      { id: 'a', read: false },
    ])
    expect(ids(r)).toEqual(['c', 'd'])
  })

  it('skips when the last N are all read', () => {
    const r = selectUnreadTail(count(2), win, [
      { id: 'd', read: true },
      { id: 'c', read: true },
    ])
    expect(r.messages).toEqual([])
  })

  it('skips when no unread message is inside the window', () => {
    const r = selectUnreadTail(count(2), win, [
      { id: 'z1', read: false },
      { id: 'z2', read: false },
    ])
    expect(r).toEqual({ messages: [], contextBefore: null })
  })

  it('skips an empty window', () => {
    expect(selectUnreadTail(count(1), [], [{ id: 'a', read: false }]).messages).toEqual([])
  })

  it('has no context when the first unread message is the first of the window', () => {
    const r = selectUnreadTail(count(4), win, [{ id: 'a', read: false }])
    expect(ids(r)).toHaveLength(4)
    expect(r.contextBefore).toBe(10)
  })
})
