import { describe, expect, it } from 'vitest'
import { type ChatResult, composeDigest } from '../../../src/domain/sections.js'
import type { Priority } from '../../../src/domain/summary.js'

const r = (
  name: string,
  priority: Priority,
  messageCount: number,
  o: { needsReply?: boolean; todos?: string[]; unsaved?: boolean } = {},
): ChatResult => ({
  name,
  messageCount,
  unsaved: o.unsaved ?? false,
  summary: { summary: name, todos: o.todos ?? [], needsReply: o.needsReply ?? false, priority },
})
const names = (list: readonly ChatResult[]) => list.map((x) => x.name)

describe('composeDigest', () => {
  it('sorts by priority, then by message count, within each section', () => {
    const d = composeDigest(
      [
        r('Marta', 'medium', 6, { needsReply: true }),
        r('Ana', 'high', 3, { needsReply: true }),
        r('Rosa', 'high', 5, { needsReply: true }),
        r('Carlos', 'low', 7),
        r('Ajedrez', 'medium', 5),
      ],
      false,
    )
    expect(names(d.needsReply)).toEqual(['Rosa', 'Ana', 'Marta'])
    expect(names(d.rest)).toEqual(['Ajedrez', 'Carlos'])
  })

  it('breaks priority ties by count, most first, regardless of input order', () => {
    const d = composeDigest([r('few', 'high', 4), r('many', 'high', 6)], false)
    expect(names(d.rest)).toEqual(['many', 'few'])
  })

  it('is stable for equal priority and count', () => {
    const d = composeDigest([r('first', 'high', 4), r('second', 'high', 4), r('third', 'high', 4)], false)
    expect(names(d.rest)).toEqual(['first', 'second', 'third'])
  })

  it('does not modify its input', () => {
    const input = [r('b', 'low', 1), r('a', 'high', 1)]
    composeDigest(input, false)
    expect(names(input)).toEqual(['b', 'a'])
  })

  it('splits into sections; a chat that needs a reply and has todos is only in needsReply', () => {
    const d = composeDigest(
      [
        r('reply', 'high', 5, { needsReply: true, todos: ['t'] }),
        r('todos', 'medium', 2, { todos: ['t'] }),
        r('rest', 'low', 1),
      ],
      false,
    )
    expect(names(d.needsReply)).toEqual(['reply'])
    expect(names(d.withTodos)).toEqual(['todos'])
    expect(names(d.rest)).toEqual(['rest'])
    expect(d.unsaved).toEqual([])
    expect(d.counts).toEqual({ total: 3, needsReply: 1, unsaved: 0, rest: 1 })
  })

  it('with the flag off, unsaved chats are like any other', () => {
    const d = composeDigest([r('nico', 'high', 2, { needsReply: true, unsaved: true })], false)
    expect(names(d.needsReply)).toEqual(['nico'])
    expect(d.unsaved).toEqual([])
    expect(d.counts.unsaved).toBe(0)
  })

  it('with the flag off, unsaved chats with todos or nothing pending land in their normal sections', () => {
    const d = composeDigest(
      [r('anon', 'medium', 3, { unsaved: true, todos: ['t'] }), r('mati', 'high', 2, { unsaved: true })],
      false,
    )
    expect(names(d.withTodos)).toEqual(['anon'])
    expect(names(d.rest)).toEqual(['mati'])
    expect(d.unsaved).toEqual([])
  })

  it('with the flag on, unsaved chats go to their own section, sorted, and leave the others', () => {
    const d = composeDigest(
      [
        r('tienda', 'low', 1, { unsaved: true }),
        r('nico', 'high', 2, { unsaved: true, needsReply: true }),
        r('anon', 'medium', 3, { unsaved: true, todos: ['t'] }),
        r('mati', 'high', 3, { unsaved: true }),
        r('saved', 'high', 1, { needsReply: true }),
      ],
      true,
    )
    expect(names(d.unsaved)).toEqual(['mati', 'nico', 'anon', 'tienda'])
    expect(names(d.needsReply)).toEqual(['saved'])
    expect(d.withTodos).toEqual([])
    expect(d.rest).toEqual([])
  })

  it('the needs-reply count leaves out unsaved chats when flagged (inherited), and counts them when not', () => {
    const results = [
      r('nico', 'high', 2, { unsaved: true, needsReply: true }),
      r('saved', 'high', 1, { needsReply: true }),
    ]
    expect(composeDigest(results, true).counts).toEqual({ total: 2, needsReply: 1, unsaved: 1, rest: 0 })
    expect(composeDigest(results, false).counts).toEqual({ total: 2, needsReply: 2, unsaved: 0, rest: 0 })
  })

  it('exposes the rest count even though hiding it is a rendering choice', () => {
    const d = composeDigest([r('a', 'low', 1), r('b', 'low', 2)], false)
    expect(d.counts.rest).toBe(2)
  })

  it('handles no results', () => {
    expect(composeDigest([], true).counts).toEqual({ total: 0, needsReply: 0, unsaved: 0, rest: 0 })
  })
})
