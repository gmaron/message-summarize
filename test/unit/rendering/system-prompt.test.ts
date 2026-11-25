import { describe, expect, it } from 'vitest'
import { createRenderers } from '../../../src/infrastructure/rendering/index.js'
import { BA } from './support.js'

const es = createRenderers('es', BA).systemPrompt
const en = createRenderers('en', BA).systemPrompt

describe('custom templates', () => {
  it('replaces every {{name}} with the owner name', () => {
    expect(es.render('Sos el asistente de {{name}}. Ayudá a {{name}}.', 'Sofía')).toBe(
      'Sos el asistente de Sofía. Ayudá a Sofía.',
    )
  })
  it('removes HTML comments, also several and across lines, and then trims', () => {
    const template = '\n  <!-- nota\nde varias líneas -->Hola <!-- otra -->{{name}}.\n<!-- fin -->\n\n'
    expect(es.render(template, 'Sofía')).toBe('Hola Sofía.')
  })
  it('does not remove text between a comment and a later one', () => {
    expect(es.render('a<!-- 1 -->b<!-- 2 -->c', 'x')).toBe('abc')
  })
  it('trims the result', () => {
    expect(es.render('  \n texto \n  ', 'x')).toBe('texto')
  })
  it('uses the translated default name when the owner has none', () => {
    expect(es.render('Hola {{name}}', null)).toBe('Hola la persona usuaria')
    expect(en.render('Hi {{name}}', null)).toBe('Hi the user')
  })
  it('treats an empty or blank owner name as absent', () => {
    expect(es.render('Hola {{name}}', '')).toBe('Hola la persona usuaria')
    expect(en.render('Hi {{name}}', '   ')).toBe('Hi the user')
  })
  it('does not interpret replacement patterns in the name', () => {
    expect(es.render('Hola {{name}}', "$& $' $1 $$")).toBe("Hola $& $' $1 $$")
  })
  it('does not let a name that looks like a comment hide the rest of the prompt', () => {
    expect(es.render('A {{name}} B', '<!--')).toBe('A <!-- B')
  })
  it('does not support the legacy {{nombre}} variable', () => {
    expect(es.render('Hola {{nombre}}', 'Sofía')).toBe('Hola {{nombre}}')
  })
  it('keeps the text as is when there is nothing to replace', () => {
    expect(es.render('Resumí cada conversación.', 'Sofía')).toBe('Resumí cada conversación.')
  })
})

describe('default prompts (RF-39)', () => {
  const cases = [
    ['es', es, 'Sofía'],
    ['en', en, 'Sam'],
  ] as const

  it.each(cases)('%s: is used when there is no custom template', (_, renderer, name) => {
    expect(renderer.render(null, name)).toBe(renderer.render(renderer.defaultTemplate, name))
  })
  it.each(cases)('%s: has the owner name, no comments and no variables left, and is trimmed', (_, renderer, name) => {
    const prompt = renderer.render(null, name)
    expect(prompt).toContain(name)
    expect(prompt).not.toContain('{{')
    expect(prompt).not.toContain('<!--')
    expect(prompt).not.toContain('-->')
    expect(prompt).toBe(prompt.trim())
  })
  it.each(cases)('%s: asks for the four fields of the answer', (_, renderer, name) => {
    const prompt = renderer.render(null, name)
    for (const field of ['resumen', 'pendientes', 'necesita_respuesta', 'prioridad']) expect(prompt).toContain(field)
    for (const priority of ['alta', 'media', 'baja']) expect(prompt).toContain(priority)
  })
  it.each(cases)('%s: treats the chat text as untrusted', (_, renderer, name) => {
    expect(renderer.render(null, name)).toMatch(/instrucciones|instructions/)
  })
  it('shows the editor the template with its variable and comment', () => {
    for (const renderer of [es, en]) {
      expect(renderer.defaultTemplate).toContain('{{name}}')
      expect(renderer.defaultTemplate).toContain('<!--')
    }
  })
  it('tells the model which tag marks the owner, the one the transcript uses', () => {
    expect(es.render(null, 'Sofía')).toContain('[VOS]')
    expect(en.render(null, 'Sam')).toContain('[YOU]')
  })
  it('reads naturally with no owner name', () => {
    const prompt = es.render(null, null)
    expect(prompt).toContain('Sos el asistente de la persona usuaria.')
    expect(prompt).toContain('cosas que la persona usuaria tiene que hacer')
    expect(prompt).toContain('una respuesta de la persona usuaria')
    expect(prompt).toContain('Los mensajes de la persona usuaria están marcados')
    expect(prompt).not.toMatch(/\bYo\b/)
    const english = en.render(null, null)
    expect(english).toContain('You are the assistant of the user.')
    expect(english).toContain('things the user has to do')
    expect(english).toContain('an answer from the user')
    expect(english).toContain('The messages of the user are marked')
    expect(english).not.toMatch(/\bMe\b/)
  })
  it('is written in each language', () => {
    expect(es.render(null, 'x')).toContain('Sos el asistente de x')
    expect(en.render(null, 'x')).toContain('You are the assistant of x')
  })
})
