import { describe, expect, it } from 'vitest'
import { PROMPT_MAX_LENGTH, PROMPT_VARIABLES, promptIssue, unknownPromptVariables } from '../../../src/domain/prompt.js'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'

describe('the prompt rules (RF-38)', () => {
  it('has one variable, {{name}}', () => {
    expect(PROMPT_VARIABLES).toEqual(['{{name}}'])
  })

  it('finds the placeholders that are not variables, each once, typos included', () => {
    expect(unknownPromptVariables('{{name}} and {{name}}')).toEqual([])
    expect(unknownPromptVariables('{{ name }} {{Name}} {{x}} {{x}} {{}}')).toEqual([
      '{{ name }}',
      '{{Name}}',
      '{{x}}',
      '{{}}',
    ])
    expect(unknownPromptVariables('no braces, {single} and an open {{name')).toEqual([])
  })

  it('accepts the built-in prompts of every language', () => {
    for (const language of ['es', 'en'] as const) {
      expect(promptIssue(getCatalog(language).defaultSystemPrompt)).toBeNull()
    }
  })

  it('says blank for nothing, spaces or only comments', () => {
    expect(promptIssue('')).toEqual({ code: 'blank' })
    expect(promptIssue(' \n\t')).toEqual({ code: 'blank' })
    expect(promptIssue('<!-- {{nope}} -->')).toEqual({ code: 'blank' })
  })

  it('limits the length, exactly at the limit', () => {
    expect(promptIssue('a'.repeat(PROMPT_MAX_LENGTH))).toBeNull()
    expect(promptIssue('a'.repeat(PROMPT_MAX_LENGTH + 1))).toEqual({ code: 'tooLong' })
  })

  it('ignores placeholders inside comments, as the renderer does', () => {
    expect(unknownPromptVariables('a {{name}} <!-- {{x}} -->')).toEqual([])
    expect(promptIssue('a <!-- {{x}} --> b')).toBeNull()
    expect(promptIssue('a {{x}} <!-- {{name}} -->')).toEqual({ code: 'unknownVariable', variables: ['{{x}}'] })
  })

  it('checks the length before the comment pattern: a huge adversarial text is refused fast', () => {
    const text = '<!--'.repeat(2_000_000)
    const started = performance.now()
    expect(promptIssue(text)).toEqual({ code: 'tooLong' })
    expect(performance.now() - started).toBeLessThan(200)
    // and at the limit the pattern still runs in a bounded time
    const atLimit = '<!--'.repeat(PROMPT_MAX_LENGTH / 4)
    const t0 = performance.now()
    expect(promptIssue(`${atLimit}x`)).toEqual({ code: 'tooLong' })
    expect(promptIssue(atLimit)).toBeNull()
    expect(performance.now() - t0).toBeLessThan(2_000)
  })

  it('names the unknown variables', () => {
    expect(promptIssue('hi {{who}}')).toEqual({ code: 'unknownVariable', variables: ['{{who}}'] })
  })
})
