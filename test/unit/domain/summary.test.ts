import { describe, expect, it } from 'vitest'
import { parseSummaryResponse } from '../../../src/domain/summary.js'

const good = { resumen: 'Todo bien', pendientes: ['llamar'], necesita_respuesta: true, prioridad: 'alta' }
const errorsOf = (input: unknown) => {
  const r = parseSummaryResponse(input)
  if (r.ok) throw new Error('expected an error')
  return r.error
}

describe('parseSummaryResponse', () => {
  it('maps the wire format to the domain names', () => {
    expect(parseSummaryResponse(good)).toEqual({
      ok: true,
      value: { summary: 'Todo bien', todos: ['llamar'], needsReply: true, priority: 'high' },
    })
  })

  it.each([
    ['alta', 'high'],
    ['media', 'medium'],
    ['baja', 'low'],
  ])('maps priority %s to %s', (wire, priority) => {
    const r = parseSummaryResponse({ ...good, prioridad: wire })
    expect(r.ok && r.value.priority).toBe(priority)
  })

  it.each(['urgente', 'ALTA', 'high', '', 'toString', '__proto__'])('rejects the unknown priority %j', (prioridad) => {
    expect(errorsOf({ ...good, prioridad })).toEqual(['prioridad must be alta, media or baja'])
  })

  it('accepts an empty list of to-dos and an empty summary string', () => {
    expect(parseSummaryResponse({ ...good, pendientes: [], resumen: '' }).ok).toBe(true)
  })

  it.each(['resumen', 'pendientes', 'necesita_respuesta', 'prioridad'])('rejects a missing %s', (key) => {
    const { [key]: _removed, ...rest } = good as Record<string, unknown>
    const e = errorsOf(rest)
    expect(e).toHaveLength(1)
    expect(e[0]).toContain(key)
  })

  it.each([
    ['resumen', 5],
    ['resumen', null],
    ['pendientes', 'llamar'],
    ['pendientes', ['a', 3]],
    ['necesita_respuesta', 'si'],
    ['necesita_respuesta', 1],
    ['prioridad', 1],
    ['prioridad', null],
  ])('rejects %s = %j', (key, value) => {
    const e = errorsOf({ ...good, [key]: value })
    expect(e).toHaveLength(1)
    expect(e[0]).toContain(key)
  })

  it('reports every problem', () => {
    expect(errorsOf({})).toHaveLength(4)
  })

  it.each([null, 'text', 4, ['a'], undefined])('rejects a response that is not an object (%j)', (input) => {
    expect(errorsOf(input)).toEqual(['the response must be a JSON object'])
  })

  it('ignores extra keys', () => {
    const r = parseSummaryResponse({ ...good, extra: 1 })
    expect(r.ok && Object.keys(r.value).sort()).toEqual(['needsReply', 'priority', 'summary', 'todos'])
  })

  it('copies the to-do list', () => {
    const list = ['a']
    const r = parseSummaryResponse({ ...good, pendientes: list })
    expect(r.ok && r.value.todos).not.toBe(list)
  })
})
