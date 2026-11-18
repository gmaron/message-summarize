import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, parseDigestSettings } from '../../../src/domain/settings.js'

const valid = { ownerName: 'Ana Test' }

const issuesOf = (input: unknown) => {
  const r = parseDigestSettings(input)
  if (r.ok) throw new Error('expected an error')
  return r.error
}

describe('parseDigestSettings', () => {
  it('fills every missing option with its default', () => {
    const r = parseDigestSettings({})
    expect(r).toEqual({
      ok: true,
      value: {
        ownerName: null,
        excludePatterns: [],
        defaultWindowHours: 24,
        maxCharsPerConversation: 24000,
        unreadOnly: false,
        flagUnsaved: false,
        hideRest: false,
      },
    })
    expect(DEFAULT_SETTINGS.defaultWindowHours).toBe(24)
  })

  it('treats an undefined value as missing', () => {
    const r = parseDigestSettings({ ...valid, maxCharsPerConversation: undefined })
    expect(r.ok && r.value.maxCharsPerConversation).toBe(24000)
  })

  it('keeps valid values', () => {
    const r = parseDigestSettings({
      ownerName: 'Ana Test',
      excludePatterns: ['gym', 'Spam'],
      defaultWindowHours: 6.5,
      maxCharsPerConversation: 300,
      unreadOnly: true,
      flagUnsaved: true,
      hideRest: true,
    })
    expect(r).toEqual({
      ok: true,
      value: {
        ownerName: 'Ana Test',
        excludePatterns: ['gym', 'Spam'],
        defaultWindowHours: 6.5,
        maxCharsPerConversation: 300,
        unreadOnly: true,
        flagUnsaved: true,
        hideRest: true,
      },
    })
  })

  it('does not alias the caller list and ignores unknown keys', () => {
    const patterns = ['a']
    const r = parseDigestSettings({ ...valid, excludePatterns: patterns, language: 'es' })
    expect(r.ok && r.value.excludePatterns).not.toBe(patterns)
    expect(r.ok && 'language' in r.value).toBe(false)
  })

  it('ownerName has a default: null', () => {
    const r = parseDigestSettings({})
    expect(r.ok && r.value.ownerName).toBeNull()
  })

  it.each([
    ['', 'emptyString'],
    ['   ', 'emptyString'],
    [5, 'notString'],
    [null, 'notString'],
  ])('rejects ownerName = %j with %s', (value, code) => {
    expect(issuesOf({ ownerName: value })).toEqual([{ option: 'ownerName', code }])
  })

  it.each([
    ['defaultWindowHours', 0, 'notPositive'],
    ['defaultWindowHours', -1, 'notPositive'],
    ['defaultWindowHours', Number.NaN, 'notPositive'],
    ['defaultWindowHours', Number.POSITIVE_INFINITY, 'notPositive'],
    ['defaultWindowHours', '24', 'notNumber'],
    ['defaultWindowHours', null, 'notNumber'],
    ['maxCharsPerConversation', 0, 'notPositive'],
    ['maxCharsPerConversation', 1.5, 'notInteger'],
    ['maxCharsPerConversation', -10, 'notPositive'],
    ['maxCharsPerConversation', '300', 'notNumber'],
    ['unreadOnly', 'yes', 'notBoolean'],
    ['flagUnsaved', 1, 'notBoolean'],
    ['hideRest', null, 'notBoolean'],
    ['excludePatterns', 'gym', 'notArray'],
    ['excludePatterns', ['gym', 3], 'notStringList'],
    ['excludePatterns', ['gym', ''], 'emptyPattern'],
    ['excludePatterns', ['  '], 'emptyPattern'],
    ['excludePatterns', ['gym', 'id:'], 'emptyIdPattern'],
    ['excludePatterns', ['ID:   '], 'emptyIdPattern'],
  ])('rejects %s = %j with %s instead of falling back to the default', (option, value, code) => {
    expect(issuesOf({ ...valid, [option]: value })).toEqual([{ option, code }])
  })

  it('reports every invalid option, each with its code', () => {
    const issues = issuesOf({ ownerName: 3, defaultWindowHours: 0, unreadOnly: 'x', maxCharsPerConversation: -1 })
    expect(issues.map((i) => i.option).sort()).toEqual(
      ['defaultWindowHours', 'maxCharsPerConversation', 'ownerName', 'unreadOnly'].sort(),
    )
  })

  it.each([null, 'text', 3, [], undefined])('rejects a non-object input (%j)', (input) => {
    expect(issuesOf(input)).toEqual([{ option: '(settings)', code: 'notObject' }])
  })
})
