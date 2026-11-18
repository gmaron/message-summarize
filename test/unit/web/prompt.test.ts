import { describe, expect, it } from 'vitest'
import { webEn } from '../../../src/infrastructure/i18n/web-en.js'
import { webEs } from '../../../src/infrastructure/i18n/web-es.js'
import { accountActions } from '../../../src/interfaces/web/lib/accounts.js'
import { ApiError, createApi } from '../../../src/interfaces/web/lib/api.js'
import {
  clientProblem,
  differsFromOriginal,
  isDirty,
  nameNote,
  normalizeText,
  problemOf,
  problemText,
} from '../../../src/interfaces/web/lib/prompt.js'
import type { PromptView } from '../../../src/interfaces/web/lib/types.js'
import { account, fakeFetch } from './support.js'

const view = (over: Partial<PromptView> = {}): PromptView => ({
  source: 'default',
  text: 'Original for {{name}}.',
  defaultText: 'Original for {{name}}.',
  variables: ['{{name}}'],
  maxLength: 100,
  ownerName: 'Marta Prueba',
  ...over,
})

describe('the prompt form logic', () => {
  it('checks the text as the daemon does: blank, too long (by the limit of the view), unknown variables', () => {
    expect(clientProblem('Hello {{name}}', 100)).toBeNull()
    expect(clientProblem('   ', 100)).toEqual({ code: 'blank' })
    expect(clientProblem('x'.repeat(101), 100)).toEqual({ code: 'tooLong', maxLength: 100 })
    expect(clientProblem('x'.repeat(100), 100)).toBeNull()
    // a newer daemon may allow more than this build's constant
    expect(clientProblem('x'.repeat(30_000), 40_000)).toBeNull()
    expect(clientProblem('a {{who}} {{ name }}', 100)).toEqual({
      code: 'unknownVariable',
      variables: ['{{who}}', '{{ name }}'],
    })
  })

  it('ignores placeholders in comments and checks the length first', () => {
    expect(clientProblem('a {{name}} <!-- {{x}} -->', 100)).toBeNull()
    expect(clientProblem('<!--'.repeat(1_000_000), 100)).toEqual({ code: 'tooLong', maxLength: 100 })
  })

  it('says it in both languages', () => {
    for (const texts of [webEn, webEs]) {
      expect(problemText({ code: 'blank' }, texts, 10)).toBe(texts.ui.prompt.blank)
      expect(problemText({ code: 'tooLong' }, texts, 10)).toContain('10')
      expect(problemText({ code: 'tooLong', maxLength: 7 }, texts, 10)).toContain('7')
      const unknown = problemText({ code: 'unknownVariable', variables: ['{{a}}', '{{b}}'] }, texts, 10)
      expect(unknown).toContain('{{a}}, {{b}}')
      expect(unknown).toContain('{{name}}')
    }
  })

  it('reads the problems of a refused save from the API errors', () => {
    expect(problemOf(new ApiError(422, 'blankPrompt'))).toEqual({ code: 'blank' })
    expect(problemOf(new ApiError(422, 'promptTooLong', undefined, undefined, undefined, undefined, 50))).toEqual({
      code: 'tooLong',
      maxLength: 50,
    })
    expect(problemOf(new ApiError(422, 'promptTooLong'))).toEqual({ code: 'tooLong' })
    expect(problemOf(new ApiError(422, 'unknownVariable', undefined, undefined, undefined, ['{{x}}']))).toEqual({
      code: 'unknownVariable',
      variables: ['{{x}}'],
    })
    expect(problemOf(new ApiError(422, 'unknownVariable'))).toEqual({ code: 'unknownVariable', variables: [] })
    expect(problemOf(new ApiError(422, 'invalidConfig'))).toBeNull()
    expect(problemOf(new ApiError(500, 'internal'))).toBeNull()
    expect(problemOf(new Error('x'))).toBeNull()
  })

  it('knows when the text differs from the original and when there is something to save, ignoring line endings', () => {
    const v = view({ text: 'a\r\nb', defaultText: 'a\nb\n' })
    expect(differsFromOriginal('a\nb', v)).toBe(false)
    expect(differsFromOriginal('a\nc', v)).toBe(true)
    expect(isDirty('a\nb', v)).toBe(false)
    expect(isDirty('a\nb ', v)).toBe(true)
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('explains {{name}} with the configured name, or says that none is set', () => {
    for (const texts of [webEn, webEs]) {
      expect(nameNote(view(), texts)).toContain('Marta Prueba')
      expect(nameNote(view(), texts)).toContain('{{name}}')
      expect(nameNote(view({ ownerName: null }), texts)).not.toContain('Marta')
      expect(nameNote(view({ ownerName: '  ' }), texts)).toBe(nameNote(view({ ownerName: null }), texts))
    }
  })

  it('offers the dialog only when the configuration is valid', () => {
    expect(accountActions(account()).prompt).toBe(true)
    expect(accountActions(account({ configValid: false })).prompt).toBe(false)
  })

  it('has the texts of the dialog in both languages with the same placeholders', () => {
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}(?!\})/g)].map((m) => m[1]).sort()
    for (const key of Object.keys(webEn.ui.prompt) as (keyof typeof webEn.ui.prompt)[]) {
      const en = webEn.ui.prompt[key]
      const es = webEs.ui.prompt[key]
      if (typeof en === 'string') expect(holes(String(es)), key).toEqual(holes(en))
    }
  })

  it('calls the API: GET, PUT { text } and DELETE on the prompt of the account', async () => {
    const { fetchFn, calls } = fakeFetch({
      'GET /api/accounts/alpha/prompt': { body: view() },
      'PUT /api/accounts/alpha/prompt': { body: view({ source: 'account', text: 'new' }) },
      'DELETE /api/accounts/alpha/prompt': { body: view() },
    })
    const api = createApi(fetchFn)
    expect((await api.prompt('alpha')).source).toBe('default')
    expect((await api.savePrompt('alpha', 'new')).text).toBe('new')
    expect((await api.restorePrompt('alpha')).source).toBe('default')
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['GET', '/api/accounts/alpha/prompt', undefined],
      ['PUT', '/api/accounts/alpha/prompt', { text: 'new' }],
      ['DELETE', '/api/accounts/alpha/prompt', undefined],
    ])
  })

  it('keeps the extra fields of a refused save in the error', async () => {
    const { fetchFn } = fakeFetch({
      'PUT /api/accounts/alpha/prompt': { status: 422, body: { error: 'unknownVariable', variables: ['{{x}}', 3] } },
    })
    const error = await createApi(fetchFn)
      .savePrompt('alpha', '{{x}}')
      .catch((e: unknown) => e)
    expect(problemOf(error)).toEqual({ code: 'unknownVariable', variables: ['{{x}}'] })
  })
})
