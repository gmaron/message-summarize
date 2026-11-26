import { describe, expect, it } from 'vitest'
import type { DigestInput } from '../../../src/application/ports/rendering.js'
import { splitIntoParts } from '../../../src/domain/chunk.js'
import { type ChatResult, composeDigest } from '../../../src/domain/sections.js'
import { createRenderers } from '../../../src/infrastructure/rendering/index.js'
import { BA, ba, golden, goldenJson, result } from './support.js'

const es = createRenderers('es', BA).digest
const en = createRenderers('en', BA).digest

const SINCE = ba(4, 20, 8, 0) // lun 20-04, 08:00
const UNTIL = ba(4, 20, 20, 0) // lun 20-04, 20:00

const input = (results: readonly ChatResult[], overrides: Partial<DigestInput> & { flagUnsaved?: boolean } = {}) => {
  const { flagUnsaved = false, ...rest } = overrides
  return {
    sections: composeDigest(results, flagUnsaved),
    errors: 0,
    since: SINCE,
    until: UNTIL,
    unreadOnly: false,
    hideRest: false,
    platformName: 'WhatsApp',
    ...rest,
  } satisfies DigestInput
}

const full = (results: readonly ChatResult[], overrides = {}) => es.render(input(results, overrides)).fullLines
const delivery = (results: readonly ChatResult[], overrides = {}) => es.render(input(results, overrides)).deliveryLines

const needsReply = (name: string, summary: string, extra = {}) => result(name, summary, { needsReply: true, ...extra })
const withTodos = (name: string, summary: string, todos: string[], extra = {}) =>
  result(name, summary, { todos, ...extra })

describe('title and headline', () => {
  it('writes the title with the platform name and the END of the window', () => {
    expect(full([result('A', 'x')])[0]).toBe('*Resumen WhatsApp — lun 20-04, 20:00*')
    expect(full([result('A', 'x')], { platformName: 'Telegram' })[0]).toBe('*Resumen Telegram — lun 20-04, 20:00*')
  })
  it('writes the headline with the start of the window and the counts', () => {
    const lines = full([needsReply('A', 'x'), result('B', 'y'), result('C', 'z')])
    expect(lines[1]).toBe('3 chats con novedades desde lun 20-04, 08:00 · 1 necesitan respuesta')
  })
  it('says "con mensajes sin leer" when only unread messages are summarized', () => {
    expect(full([result('A', 'x')], { unreadOnly: true })[1]).toBe(
      '1 chats con mensajes sin leer desde lun 20-04, 08:00 · 0 necesitan respuesta',
    )
  })
  it('keeps the plural for one chat and one reply (inherited)', () => {
    expect(full([needsReply('A', 'x')])[1]).toBe('1 chats con novedades desde lun 20-04, 08:00 · 1 necesitan respuesta')
  })
  it('adds the unsaved count only when it is above zero', () => {
    const results = [result('A', 'x', { unsaved: true }), result('B', 'y')]
    expect(full(results, { flagUnsaved: true })[1]).toBe(
      '2 chats con novedades desde lun 20-04, 08:00 · 0 necesitan respuesta · 1 sin agendar',
    )
    expect(full(results, { flagUnsaved: false })[1]).toBe(
      '2 chats con novedades desde lun 20-04, 08:00 · 0 necesitan respuesta',
    )
    expect(full([result('B', 'y')], { flagUnsaved: true })[1]).not.toContain('sin agendar')
  })
  it('shows dates in the given time zone', () => {
    const tokyo = createRenderers('es', 'Asia/Tokyo').digest.render(input([result('A', 'x')])).fullLines
    expect(tokyo.slice(0, 2)).toEqual([
      '*Resumen WhatsApp — mar 21-04, 08:00*',
      '1 chats con novedades desde lun 20-04, 20:00 · 0 necesitan respuesta',
    ])
  })
})

describe('sections', () => {
  it('writes a blank line, the bold title and the chats, with the todos indented under their chat', () => {
    const lines = full([withTodos('Bea', 'Dejó las llaves.', ['Retirar llaves', 'Llamar'])])
    expect(lines.slice(2)).toEqual([
      '',
      '*🟡 Con pendientes*',
      '• *Bea*: Dejó las llaves.',
      '   ☐ Retirar llaves',
      '   ☐ Llamar',
    ])
  })
  it('keeps the order: unsaved, need a reply, with todos, the rest', () => {
    const lines = full(
      [
        result('Resto', 'r'),
        withTodos('Pend', 'p', ['t']),
        needsReply('Resp', 'a'),
        result('Nuevo', 'n', { unsaved: true }),
      ],
      { flagUnsaved: true },
    )
    expect(lines.slice(2)).toEqual([
      '',
      '*🔴 Sin agendar: tenés 1 chat de números que no agendaste*',
      '• *Nuevo*: n',
      '',
      '*🔴 Necesitan respuesta*',
      '• *Resp*: a',
      '',
      '*🟡 Con pendientes*',
      '• *Pend*: p',
      '   ☐ t',
      '',
      '*⚪ El resto*',
      '• *Resto*: r',
    ])
  })
  it('uses the plural of "chat" in the unsaved title', () => {
    const lines = full([result('A', 'x', { unsaved: true }), result('B', 'y', { unsaved: true })], {
      flagUnsaved: true,
    })
    expect(lines[3]).toBe('*🔴 Sin agendar: tenés 2 chats de números que no agendaste*')
  })
  it('leaves out empty sections', () => {
    expect(full([result('A', 'x')])).toEqual([
      '*Resumen WhatsApp — lun 20-04, 20:00*',
      '1 chats con novedades desde lun 20-04, 08:00 · 0 necesitan respuesta',
      '',
      '*⚪ El resto*',
      '• *A*: x',
    ])
  })
  it('writes only the head for no results', () => {
    expect(full([])).toEqual([
      '*Resumen WhatsApp — lun 20-04, 20:00*',
      '0 chats con novedades desde lun 20-04, 08:00 · 0 necesitan respuesta',
    ])
  })
})

describe('errors line', () => {
  it('adds a blank line and the warning when some chats failed', () => {
    expect(full([], { errors: 3 }).slice(2)).toEqual(['', '⚠️ 3 chats no se pudieron resumir'])
  })
  it('keeps the plural for one failure (inherited)', () => {
    expect(full([], { errors: 1 }).slice(2)).toEqual(['', '⚠️ 1 chats no se pudieron resumir'])
  })
  it('adds nothing for zero errors', () => {
    expect(full([result('A', 'x')]).join('\n')).not.toContain('⚠️')
  })
  it('goes last, after every section', () => {
    expect(full([needsReply('A', 'x')], { errors: 1 }).at(-1)).toBe('⚠️ 1 chats no se pudieron resumir')
  })
})

describe('hiding the rest in the delivered version', () => {
  const results = [needsReply('A', 'x'), result('B', 'y'), result('C', 'z')]
  it('replaces the detail with a count and keeps the full version with the detail', () => {
    const rendered = es.render(input(results, { hideRest: true }))
    expect(rendered.deliveryLines.slice(-2)).toEqual(['', '*⚪ El resto:* 2 chats sin nada para vos'])
    expect(rendered.deliveryLines.join('\n')).not.toContain('• *B*')
    expect(rendered.fullLines.slice(-4)).toEqual(['', '*⚪ El resto*', '• *B*: y', '• *C*: z'])
  })
  it('uses the singular for one chat', () => {
    expect(delivery([result('B', 'y')], { hideRest: true }).slice(-2)).toEqual([
      '',
      '*⚪ El resto:* 1 chat sin nada para vos',
    ])
  })
  it('writes nothing when the rest is empty', () => {
    const lines = delivery([needsReply('A', 'x')], { hideRest: true })
    expect(lines.join('\n')).not.toContain('El resto')
    expect(lines).toEqual(full([needsReply('A', 'x')]))
  })
  it('keeps the errors line after the count', () => {
    expect(delivery([result('B', 'y')], { hideRest: true, errors: 2 }).slice(-4)).toEqual([
      '',
      '*⚪ El resto:* 1 chat sin nada para vos',
      '',
      '⚠️ 2 chats no se pudieron resumir',
    ])
  })
  it('delivers the full version when the option is off', () => {
    const rendered = es.render(input(results, { hideRest: false }))
    expect(rendered.deliveryLines).toEqual(rendered.fullLines)
  })
})

describe('golden outputs', () => {
  it('10-window-and-pointer run-1: a complete digest', () => {
    const lines = es.render({
      sections: composeDigest(
        [
          withTodos('Bea Cortés', 'Bea dejó las llaves en la portería.', ['Retirar las llaves de la portería'], {
            messageCount: 1,
          }),
          needsReply('Xavier Roldán', 'Xavier quiere confirmar la visita de las 10.'),
        ],
        false,
      ),
      errors: 0,
      since: ba(5, 4, 6, 0),
      until: ba(5, 4, 12, 0),
      unreadOnly: false,
      hideRest: false,
      platformName: 'WhatsApp',
    }).fullLines
    expect(lines.join('\n')).toBe(golden('10-window-and-pointer/run-1/digest.md'))
  })

  it('02-unsaved-flag-on: unsaved section, names with an address, a group with no name', () => {
    const r = createRenderers('es', BA)
    const lines = r.digest.render({
      sections: composeDigest(
        [
          result('Mati ( +9928263724153 )', 'Mati avisa que la inmobiliaria ya depositó.', {
            unsaved: true,
            messageCount: 4,
          }),
          result('Nico ( +9926775125784 )', 'Nico pide el contacto de un electricista, con urgencia.', {
            unsaved: true,
            messageCount: 3,
          }),
          result('+9928136413513', 'Alguien del consorcio pide la foto del DNI antes del viernes.', {
            unsaved: true,
            messageCount: 2,
            todos: ['Mandar la foto del DNI al consorcio'],
          }),
          result(
            'Tienda Luz ( +9926862581772 )',
            'Tienda Luz avisa que el pedido de lámparas está listo para retirar.',
            {
              unsaved: true,
              messageCount: 1,
            },
          ),
          needsReply('Ana Gómez', 'Ana pregunta si Sofía va al cumpleaños de Tomás el sábado.'),
          withTodos(
            r.transcript.unnamedGroup,
            'Mañana pasa el fumigador, el jueves arreglan la bomba y preguntan por el corte de luz.',
            ['Dejar la llave en portería si no estás'],
          ),
        ],
        true,
      ),
      errors: 0,
      since: ba(4, 14, 8, 0),
      until: ba(4, 14, 20, 0),
      unreadOnly: false,
      hideRest: false,
      platformName: 'WhatsApp',
    }).fullLines
    expect(lines.join('\n')).toBe(golden('02-unsaved-flag-on/run-1/digest.md'))
  })

  it('11-llm-error: the warning line after the sections', () => {
    const lines = es.render({
      sections: composeDigest(
        [
          needsReply('Pedro Aguirre', 'Pedro propone jugar al pádel el sábado.'),
          withTodos('Rubén Mansilla', 'Rubén pasa el presupuesto de la reparación en tres cuotas.', [
            'Revisar el presupuesto de Rubén',
          ]),
        ],
        false,
      ),
      errors: 1,
      since: ba(4, 8, 8, 0),
      until: ba(4, 8, 10, 0),
      unreadOnly: false,
      hideRest: false,
      platformName: 'WhatsApp',
    }).fullLines
    expect(lines.join('\n')).toBe(golden('11-llm-error/run-1/digest.md'))
  })

  it('05-unread-only: a complete digest with "con mensajes sin leer"', () => {
    const lines = es.render({
      sections: composeDigest(
        [
          needsReply('Irene Navarro', 'Irene necesita el contacto de un plomero.', { messageCount: 2 }),
          needsReply(
            'Equipo de Fútbol 5',
            'Nacho confirma el partido de hoy y Tomi pregunta si hay lugar para uno más.',
            { messageCount: 1 },
          ),
          withTodos(
            'Elena Juárez',
            'Elena pide ayuda con la mudanza del sábado a las 9, con guantes y cinta.',
            ['Llevar guantes y cinta el sábado'],
            { messageCount: 2 },
          ),
          withTodos(
            'Ágata Fuentes',
            'Ágata pregunta si Sofía vio los pasajes del viaje.',
            ['Mirar los pasajes y avisarle a Ágata'],
            { messageCount: 1 },
          ),
          result('Diego Iglesias', 'Diego pasa a buscar a Sofía a las 20:30 y lleva las pelotas.', { messageCount: 2 }),
          result('Fabián Kramer', 'Fabián, del curso de fotografía, pasa el programa que empieza el 15.', {
            messageCount: 1,
          }),
        ],
        false,
      ),
      errors: 0,
      since: ba(6, 2, 8, 0),
      until: ba(6, 2, 20, 0),
      unreadOnly: true,
      hideRest: false,
      platformName: 'WhatsApp',
    }).fullLines
    expect(lines.join('\n')).toBe(golden('05-unread-only/run-1/digest.md'))
  })

  describe('09-hide-rest-on run-1', () => {
    const points = (n: number, topic: string) =>
      Array.from({ length: n }, (_, i) => ` Punto ${i + 1} sobre ${topic}: detalle inventado de la charla.`).join('')
    const rendered = es.render({
      sections: composeDigest(
        [
          needsReply('Gabriela Núñez', `Gabriela pide revisar el contrato hoy.${points(21, 'el contrato')}`, {
            messageCount: 9,
          }),
          needsReply('Hernán Vidal', `Hernán pregunta por la reunión de padres.${points(22, 'la reunión')}`, {
            messageCount: 8,
          }),
          needsReply('Irene Sosa', `Irene pide prestado el taladro.${points(22, 'el taladro')}`, { messageCount: 7 }),
          withTodos(
            'Joaquín Bravo',
            'Joaquín manda la lista de materiales de la obra.',
            ['Comprar pintura', 'Comprar masilla', 'Confirmar fecha de la obra'],
            { messageCount: 6 },
          ),
          withTodos(
            'Karina Lugo',
            'Karina recuerda llevar los formularios firmados y la copia del DNI.',
            ['Llevar formularios firmados', 'Llevar copia del DNI'],
            { messageCount: 5 },
          ),
          result('Leandro Paz', 'Leandro compartió una foto del atardecer.', { messageCount: 2 }),
          result('Club de Jardinería', 'El club de jardinería riega mañana los canteros.', { messageCount: 1 }),
        ],
        false,
      ),
      errors: 0,
      since: ba(4, 9, 8, 0),
      until: ba(4, 9, 12, 0),
      unreadOnly: false,
      hideRest: true,
      platformName: 'WhatsApp',
    })

    it('delivers the two parts of the golden message, with the rest as one line', () => {
      expect(splitIntoParts(rendered.deliveryLines)).toEqual(goldenJson('09-hide-rest-on/run-1/whatsapp-parts.json'))
    })
    it('keeps the full digest with the detail of the rest', () => {
      expect(rendered.fullLines.join('\n')).toBe(golden('09-hide-rest-on/run-1/digest.md'))
    })
  })
})

describe('english (RF-39)', () => {
  const at = { since: Date.UTC(2026, 3, 20, 11, 0), until: Date.UTC(2026, 3, 20, 23, 0) }
  const enInput = (
    results: readonly ChatResult[],
    overrides: Partial<DigestInput> & { flagUnsaved?: boolean } = {},
  ) => {
    const { flagUnsaved = false, ...rest } = overrides
    return { ...input(results, { flagUnsaved }), ...at, ...rest }
  }

  it('writes the same structure with English texts, a 24-hour clock and day before month', () => {
    const rendered = en.render(
      enInput(
        [
          result('Nuevo', 'n', { unsaved: true }),
          needsReply('Resp', 'a'),
          withTodos('Pend', 'p', ['t']),
          result('Resto', 'r'),
          result('Resto 2', 'r2'),
        ],
        { flagUnsaved: true, errors: 2, hideRest: true },
      ),
    )
    expect(rendered.fullLines).toEqual([
      '*WhatsApp summary — Mon 20/04, 20:00*',
      '5 chats with updates since Mon 20/04, 08:00 · 1 needs a reply · 1 unsaved',
      '',
      '*🔴 Unsaved: 1 chat from numbers you have not saved*',
      '• *Nuevo*: n',
      '',
      '*🔴 Need a reply*',
      '• *Resp*: a',
      '',
      '*🟡 With to-dos*',
      '• *Pend*: p',
      '   ☐ t',
      '',
      '*⚪ The rest*',
      '• *Resto*: r',
      '• *Resto 2*: r2',
      '',
      '⚠️ 2 chats could not be summarized',
    ])
    expect(rendered.deliveryLines.slice(-4)).toEqual([
      '',
      '*⚪ The rest:* 2 chats with nothing for you',
      '',
      '⚠️ 2 chats could not be summarized',
    ])
  })
  it('uses the plural for zero: an all-failed digest', () => {
    const lines = en.render(enInput([], { errors: 2 })).fullLines
    expect(lines).toEqual([
      '*WhatsApp summary — Mon 20/04, 20:00*',
      '0 chats with updates since Mon 20/04, 08:00 · 0 need a reply',
      '',
      '⚠️ 2 chats could not be summarized',
    ])
  })
  it('uses singular and plural correctly', () => {
    const one = en.render(enInput([needsReply('A', 'x')], { errors: 1 })).fullLines
    expect(one[1]).toBe('1 chat with updates since Mon 20/04, 08:00 · 1 needs a reply')
    expect(one.at(-1)).toBe('⚠️ 1 chat could not be summarized')
    const two = en.render(enInput([needsReply('A', 'x'), needsReply('B', 'y')], { unreadOnly: true })).fullLines
    expect(two[1]).toBe('2 chats with unread messages since Mon 20/04, 08:00 · 2 need a reply')
    const unsaved = en.render(
      enInput([result('A', 'x', { unsaved: true }), result('B', 'y', { unsaved: true })], { flagUnsaved: true }),
    ).fullLines
    expect(unsaved[3]).toBe('*🔴 Unsaved: 2 chats from numbers you have not saved*')
    expect(en.render(enInput([result('A', 'x')], { hideRest: true })).deliveryLines.at(-1)).toBe(
      '*⚪ The rest:* 1 chat with nothing for you',
    )
  })
  it('shows dates in the given time zone', () => {
    const tokyo = createRenderers('en', 'Asia/Tokyo').digest.render(enInput([])).fullLines
    expect(tokyo[0]).toBe('*WhatsApp summary — Tue 21/04, 08:00*')
  })
})
