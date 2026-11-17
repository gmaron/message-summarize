import { describe, expect, it } from 'vitest'
import { parseDigestSettings, type SettingsIssueCode } from '../../../src/domain/settings.js'
import { resolveWindow, type WindowError } from '../../../src/domain/window.js'
import { createRenderers } from '../../../src/infrastructure/rendering/index.js'
import { BA } from './support.js'

const es = createRenderers('es', BA).errors
const en = createRenderers('en', BA).errors

const settingsCodes: SettingsIssueCode[] = [
  'notString',
  'emptyString',
  'notArray',
  'notStringList',
  'emptyPattern',
  'notNumber',
  'notPositive',
  'notInteger',
  'notBoolean',
  'notObject',
]
const windowCodes: WindowError[] = [
  'invalidEnd',
  'invalidStart',
  'invalidHours',
  'invalidPointer',
  'invalidDefaultHours',
  'startNotBeforeEnd',
]

describe('settings issues (RF-73)', () => {
  it.each(settingsCodes.filter((c) => c !== 'notObject'))('%s names the option', (code) => {
    expect(es.settingsIssue({ option: 'maxCharsPerConversation', code })).toContain('maxCharsPerConversation')
    expect(en.settingsIssue({ option: 'maxCharsPerConversation', code })).toContain('maxCharsPerConversation')
  })
  it('gives a different message for each reason', () => {
    const messages = settingsCodes.map((code) => es.settingsIssue({ option: 'x', code }))
    expect(new Set(messages).size).toBe(settingsCodes.length)
  })
  it('writes exact messages for a few reasons', () => {
    expect(es.settingsIssue({ option: 'hideRest', code: 'notBoolean' })).toBe(
      'La opción "hideRest" tiene que ser verdadero o falso.',
    )
    expect(es.settingsIssue({ option: 'defaultWindowHours', code: 'notPositive' })).toBe(
      'La opción "defaultWindowHours" tiene que ser un número mayor que cero.',
    )
    expect(en.settingsIssue({ option: 'excludePatterns', code: 'notStringList' })).toBe(
      'The option "excludePatterns" must be a list of texts.',
    )
    expect(es.settingsIssue({ option: '(settings)', code: 'notObject' })).toBe(
      'La configuración tiene que ser un objeto con las opciones.',
    )
  })
  it('explains every issue the domain really reports', () => {
    const result = parseDigestSettings({
      ownerName: 3,
      excludePatterns: ['ok', ' '],
      defaultWindowHours: -1,
      maxCharsPerConversation: 1.5,
      unreadOnly: 'yes',
    })
    if (result.ok) throw new Error('expected issues')
    const lines = result.error.map((issue) => es.settingsIssue(issue))
    expect(lines).toEqual([
      'La opción "ownerName" tiene que ser un texto.',
      expect.stringContaining('"excludePatterns" tiene un patrón vacío'),
      'La opción "defaultWindowHours" tiene que ser un número mayor que cero.',
      'La opción "maxCharsPerConversation" tiene que ser un número entero.',
      'La opción "unreadOnly" tiene que ser verdadero o falso.',
    ])
  })
})

describe('window errors (RF-32)', () => {
  it('gives a different, non-empty explanation for each code, in both languages', () => {
    for (const messages of [es, en]) {
      const texts = windowCodes.map((code) => messages.windowError(code))
      expect(texts.every((t) => t.length > 0)).toBe(true)
      expect(new Set(texts).size).toBe(windowCodes.length)
    }
  })
  it('writes exact messages', () => {
    expect(es.windowError('startNotBeforeEnd')).toBe('El inicio de la ventana tiene que ser anterior a su fin.')
    expect(es.windowError('invalidHours')).toBe('La cantidad de horas tiene que ser un número mayor que cero.')
    expect(en.windowError('invalidStart')).toBe('The start date is not valid.')
  })
  it('names the option of the default window hours', () => {
    expect(es.windowError('invalidDefaultHours')).toContain('defaultWindowHours')
    expect(en.windowError('invalidDefaultHours')).toContain('defaultWindowHours')
  })
  it('explains the errors the domain really reports', () => {
    const result = resolveWindow({ until: 10, from: 20, hours: -1, defaultHours: 24 })
    if (result.ok) throw new Error('expected errors')
    expect(result.error.map((code) => es.windowError(code))).toEqual([
      'La cantidad de horas tiene que ser un número mayor que cero.',
    ])
  })
})
