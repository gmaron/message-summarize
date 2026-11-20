import { describe, expect, it } from 'vitest'
import { PROMPT_PRESET_IDS, promptIssue, unknownPromptVariables } from '../../../src/domain/prompt.js'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import { createSystemPromptRenderer } from '../../../src/infrastructure/rendering/system-prompt.js'

describe('the templates of the prompt editor (RF-38)', () => {
  it('start from the built-in prompt, then the personal and work profiles and the brief one', () => {
    expect(PROMPT_PRESET_IDS).toEqual(['full', 'personal', 'work', 'brief'])
  })

  describe.each(['es', 'en'] as const)('in %s', (language) => {
    const catalog = getCatalog(language)
    const texts: Array<[string, string]> = PROMPT_PRESET_IDS.map((id) => [
      id,
      id === 'full' ? catalog.defaultSystemPrompt : catalog.promptPresets[id],
    ])

    it.each(texts)('%s passes the same validation as a prompt the user writes', (_id, text) => {
      expect(promptIssue(text)).toBeNull()
      expect(unknownPromptVariables(text)).toEqual([])
    })

    it.each(texts)(
      '%s keeps the fields, the owner mark and the guard against instructions inside the chats',
      (_id, text) => {
        expect(text).toContain('{{name}}')
        for (const field of ['resumen', 'pendientes', 'necesita_respuesta', 'prioridad']) expect(text).toContain(field)
        expect(text).toContain(language === 'es' ? '[VOS]' : '[YOU]')
        expect(text).toMatch(language === 'es' ? /nunca instrucciones/ : /never instructions/)
      },
    )

    it.each(texts)('%s renders with the name and without the notes for the editor', (_id, text) => {
      const rendered = createSystemPromptRenderer(catalog).render(text, 'Marta Prueba')
      expect(rendered).toContain('Marta Prueba')
      expect(rendered).not.toContain('{{')
      expect(rendered).not.toContain('<!--')
    })

    it('the variants are different texts, and the built-in one is the catalog prompt itself', () => {
      const all = new Set(texts.map(([, text]) => text))
      expect(all.size).toBe(PROMPT_PRESET_IDS.length)
      expect(texts[0]?.[1]).toBe(catalog.defaultSystemPrompt)
    })
  })
})
