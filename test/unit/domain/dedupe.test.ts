import { describe, expect, it } from 'vitest'
import { deduplicateAcrossGroups } from '../../../src/domain/dedupe.js'
import type { MessageKind } from '../../../src/domain/model.js'
import { textOf } from './factories.js'

interface M {
  id: string
  senderId: string | null
  senderName: string | null
  fromMe: boolean
  kind: MessageKind
  text: string | null
}
interface C {
  name: string
  isGroup: boolean
  messages: M[]
}

const msg = (id: string, text: string | null, o: Partial<M> = {}): M => ({
  id,
  senderId: 'marcos',
  senderName: null,
  fromMe: false,
  kind: 'text',
  text,
  ...o,
})
const group = (name: string, ...messages: M[]): C => ({ name, isGroup: true, messages })
const chat = (name: string, ...messages: M[]): C => ({ name, isGroup: false, messages })
const N = textOf(50, 'n')
const summary = (cs: { name: string; messages: { id: string; copies: number }[] }[]) =>
  cs.map((c) => [c.name, c.messages.map((m) => `${m.id}:${m.copies}`)])

describe('deduplicateAcrossGroups (RF-34)', () => {
  it('keeps the first occurrence in conversation order and counts the copies', () => {
    const out = deduplicateAcrossGroups([
      group('GA', msg('a', N)),
      group('GB', msg('b', N), msg('b2', 'other text')),
      group('GC', msg('c', N)),
    ])
    expect(summary(out)).toEqual([
      ['GA', ['a:2']],
      ['GB', ['b2:0']],
    ])
  })

  it('keeps it in the first group in the given order, not the earliest timestamp', () => {
    const out = deduplicateAcrossGroups([group('GA', msg('late', N)), group('GB', msg('early', N))])
    expect(summary(out)).toEqual([['GA', ['late:1']]])
  })

  it('counts a repeat inside the same group as a copy', () => {
    const out = deduplicateAcrossGroups([group('GC', msg('1', N), msg('2', N))])
    expect(summary(out)).toEqual([['GC', ['1:1']]])
  })

  it('never touches individual conversations, even if they come first', () => {
    const out = deduplicateAcrossGroups([chat('P', msg('p1', N), msg('p2', N)), group('GA', msg('a', N))])
    expect(summary(out)).toEqual([
      ['P', ['p1:0', 'p2:0']],
      ['GA', ['a:0']],
    ])
  })

  it('does not dedupe texts under 40 UTF-16 units after trimming, and does at exactly 40', () => {
    const t39 = textOf(39)
    const t40 = textOf(40)
    const out = deduplicateAcrossGroups([
      group('GA', msg('a', t39), msg('a2', t40)),
      group('GB', msg('b', t39), msg('b2', t40)),
    ])
    expect(summary(out)).toEqual([
      ['GA', ['a:0', 'a2:1']],
      ['GB', ['b:0']],
    ])
  })

  it('measures the threshold in UTF-16 units, not code points', () => {
    const e = `${textOf(38)}😀` // 39 code points, 40 UTF-16 units: deduplicated
    expect(e.length).toBe(40)
    const out = deduplicateAcrossGroups([group('GA', msg('a', e)), group('GB', msg('b', e), msg('b2', 'hello there'))])
    expect(summary(out)).toEqual([
      ['GA', ['a:1']],
      ['GB', ['b2:0']],
    ])
  })

  it('trims before measuring and before comparing', () => {
    const t39 = textOf(39)
    const out = deduplicateAcrossGroups([
      group('GA', msg('a', `${t39} `)),
      group('GB', msg('b', `${t39} `)),
      group('GC', msg('c', N), msg('c2', 'x')),
      group('GD', msg('d', `${N}   `), msg('d2', 'y')),
    ])
    expect(summary(out)).toEqual([
      ['GA', ['a:0']],
      ['GB', ['b:0']],
      ['GC', ['c:1', 'c2:0']],
      ['GD', ['d2:0']],
    ])
  })

  it('does not dedupe across different senders', () => {
    const out = deduplicateAcrossGroups([group('GA', msg('a', N)), group('GB', msg('b', N, { senderId: 'nora' }))])
    expect(summary(out)).toEqual([
      ['GA', ['a:0']],
      ['GB', ['b:0']],
    ])
  })

  it('uses the sender name when there is no id, and "?" when there is neither', () => {
    const named = (id: string) => msg(id, N, { senderId: null, senderName: 'Rita' })
    const anon = (id: string) => msg(id, N, { senderId: null })
    const out = deduplicateAcrossGroups([
      group('GA', named('a'), anon('a2')),
      group('GB', named('b'), anon('b2'), msg('b3', 'short')),
    ])
    expect(summary(out)).toEqual([
      ['GA', ['a:1', 'a2:1']],
      ['GB', ['b3:0']],
    ])
  })

  it('my own messages share the key "yo" and do not mix with an anonymous sender', () => {
    const mine = (id: string) => msg(id, N, { fromMe: true, senderId: null })
    const anon = (id: string) => msg(id, N, { senderId: null })
    const out = deduplicateAcrossGroups([
      group('GA', mine('m1'), anon('x1')),
      group('GB', mine('m2'), msg('b', 'hi!')),
      group('GC', anon('x2'), mine('m3'), msg('c', 'hola')),
    ])
    expect(summary(out)).toEqual([
      ['GA', ['m1:2', 'x1:1']],
      ['GB', ['b:0']],
      ['GC', ['c:0']],
    ])
  })

  it('never dedupes audios, with or without a long text', () => {
    const audio = (id: string) => msg(id, N, { kind: 'audio' })
    const out = deduplicateAcrossGroups([
      group('GA', audio('a'), msg('a2', 'hi')),
      group('GB', audio('b'), msg('b2', 'hi')),
    ])
    expect(summary(out)).toEqual([
      ['GA', ['a:0', 'a2:0']],
      ['GB', ['b:0', 'b2:0']],
    ])
  })

  it('ignores messages without text in a group, without failing', () => {
    const image = (id: string) => msg(id, null, { kind: 'image' })
    const out = deduplicateAcrossGroups([group('GA', image('a')), group('GB', image('b'))])
    expect(summary(out)).toEqual([
      ['GA', ['a:0']],
      ['GB', ['b:0']],
    ])
  })

  it('drops conversations left empty', () => {
    const out = deduplicateAcrossGroups([group('GA', msg('a', N)), group('GE', msg('e', N))])
    expect(out.map((c) => c.name)).toEqual(['GA'])
  })

  it('drops conversations left with only my messages, also after deduplication', () => {
    const out = deduplicateAcrossGroups([
      group('GA', msg('a', N)),
      group('GF', msg('f', N), msg('mine', 'ok', { fromMe: true, senderId: null })),
    ])
    expect(out.map((c) => c.name)).toEqual(['GA'])
  })

  it('drops a conversation that had only my messages from the start, even an individual one', () => {
    const mine = msg('m', 'hi', { fromMe: true, senderId: null })
    expect(deduplicateAcrossGroups([chat('P', mine), group('G', mine)])).toEqual([])
  })

  it('keeps a conversation that has at least one incoming message', () => {
    const mine = msg('m', 'hi', { fromMe: true, senderId: null })
    expect(deduplicateAcrossGroups([chat('P', mine, msg('i', 'yo'))]).map((c) => c.name)).toEqual(['P'])
  })

  it('does not mutate its input', () => {
    const input = [group('GA', msg('a', N)), group('GB', msg('b', N))]
    const snapshot = structuredClone(input)
    deduplicateAcrossGroups(input)
    expect(input).toEqual(snapshot)
  })

  it('returns nothing for no conversations', () => {
    expect(deduplicateAcrossGroups([])).toEqual([])
  })
})
