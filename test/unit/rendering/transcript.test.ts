import { describe, expect, it } from 'vitest'
import type { MessageKind } from '../../../src/domain/model.js'
import { createRenderers } from '../../../src/infrastructure/rendering/index.js'
import { BA, ba, fill, from, goldenJson, mine, transcript } from './support.js'

const es = createRenderers('es', BA).transcript
const en = createRenderers('en', BA).transcript

const render = (overrides: Parameters<typeof transcript>[0]) => es.render(transcript(overrides))
/** The rendering without the "Chat con: Ana Gómez" header and its blank line. */
const body = (overrides: Parameters<typeof transcript>[0]) => render(overrides).split('\n\n').slice(1).join('\n\n')
const T = ba(4, 21, 9, 5)
const MARK = 'Chat con: Ana Gómez\n\n'

describe('header', () => {
  it('uses "Chat con" for an individual chat and "Grupo" for a group', () => {
    expect(render({ name: 'Ana Gómez', isGroup: false })).toBe('Chat con: Ana Gómez\n\n')
    expect(render({ name: 'Los Aromos', isGroup: true })).toBe('Grupo: Los Aromos\n\n')
  })
  it('exposes the translated name of a group with no name', () => {
    expect(es.unnamedGroup).toBe('Grupo sin nombre')
    expect(en.unnamedGroup).toBe('Unnamed group')
  })
})

describe('lines', () => {
  it('writes [HH:MM] label: text, one line per message, joined with a newline', () => {
    const messages = [from('Ana Gómez', ba(4, 21, 8, 5), 'Hola'), mine(ba(4, 21, 19, 30), 'Chau')]
    expect(body({ messages })).toBe('[08:05] Ana Gómez: Hola\n[19:30] Sofía [VOS]: Chau')
  })
  it('labels the owner with the owner name and the tag, or with the translated default when there is no name', () => {
    expect(body({ messages: [mine(T, 'x')], ownerName: 'Sofía' })).toBe('[09:05] Sofía [VOS]: x')
    expect(body({ messages: [mine(T, 'x')], ownerName: null })).toBe('[09:05] Yo [VOS]: x')
    expect(body({ messages: [mine(T, 'x')], ownerName: '' })).toBe('[09:05] Yo [VOS]: x')
    expect(body({ messages: [mine(T, 'x')], ownerName: '   ' })).toBe('[09:05] Yo [VOS]: x')
    expect(en.render(transcript({ messages: [mine(T, 'x')], ownerName: null }))).toBe(
      'Chat with: Ana Gómez\n\n[09:05] Me [YOU]: x',
    )
  })
  it('labels others with the domain rule (saved name, public name, sender name, address, "?")', () => {
    const entry = (
      participant: { savedName: string | null; publicName: string | null } | null,
      overrides: { senderName?: string; senderAddress?: string } = {},
    ) => ({
      message: {
        timestamp: T,
        fromMe: false,
        kind: 'text' as const,
        text: 'x',
        transcript: null,
        copies: 0,
        senderName: null,
        senderAddress: null,
        ...overrides,
      },
      participant: participant && { id: 'p', ...participant },
      isMass: false,
    })
    expect(body({ messages: [entry({ savedName: 'Saved', publicName: 'Public' })] })).toBe('[09:05] Saved: x')
    expect(body({ messages: [entry({ savedName: null, publicName: 'Public' })] })).toBe('[09:05] Public: x')
    expect(body({ messages: [entry(null, { senderName: 'Push' })] })).toBe('[09:05] Push: x')
    expect(body({ messages: [entry(null, { senderAddress: '+5491100000009' })] })).toBe('[09:05] +5491100000009: x')
    expect(body({ messages: [entry(null)] })).toBe('[09:05] ?: x')
  })
  it('shows the time in the given time zone', () => {
    const messages = [from('Ana Gómez', Date.UTC(2026, 3, 21, 12, 5), 'x')] // 12:05 UTC
    expect(body({ messages })).toBe('[09:05] Ana Gómez: x')
    const tokyo = createRenderers('es', 'Asia/Tokyo').transcript.render(transcript({ messages }))
    expect(tokyo).toBe(`${MARK}[21:05] Ana Gómez: x`)
    const utc = createRenderers('es', 'UTC').transcript.render(transcript({ messages }))
    expect(utc).toBe(`${MARK}[12:05] Ana Gómez: x`)
  })
  it('shows midnight as 00:05, not 24:05', () => {
    expect(body({ messages: [from('Ana Gómez', ba(4, 22, 0, 5), 'x')] })).toBe('[00:05] Ana Gómez: x')
  })
})

describe('bodies', () => {
  const kinds: [MessageKind, string][] = [
    ['image', '[imagen]'],
    ['video', '[video]'],
    ['document', '[documento]'],
    ['sticker', '[sticker]'],
    ['location', '[ubicación]'],
    ['contact', '[contacto]'],
    ['poll', '[encuesta]'],
    ['event', '[evento]'],
    ['text', '[mensaje]'],
  ]
  it.each(kinds)('shows %s without text as %s, null or empty, from others and from the owner', (kind, label) => {
    expect(body({ messages: [from('Ana Gómez', T, null, { kind })] })).toBe(`[09:05] Ana Gómez: ${label}`)
    expect(body({ messages: [from('Ana Gómez', T, '', { kind })] })).toBe(`[09:05] Ana Gómez: ${label}`)
    expect(body({ messages: [mine(T, null, { kind })] })).toBe(`[09:05] Sofía [VOS]: ${label}`)
  })
  it('keeps the text of a message with a caption', () => {
    expect(body({ messages: [from('Ana Gómez', T, 'mirá', { kind: 'image' })] })).toBe('[09:05] Ana Gómez: mirá')
  })
  it('renders an audio with its transcript, ignoring the caption', () => {
    const m = from('Ana Gómez', T, 'caption', { kind: 'audio', transcript: 'Hola, te llamo mañana.' })
    expect(body({ messages: [m] })).toBe('[09:05] Ana Gómez: 🎤 (audio) Hola, te llamo mañana.')
  })
  it('renders an audio with no transcript, or an empty one, as not transcribed', () => {
    for (const transcript of [null, '']) {
      const m = from('Ana Gómez', T, 'caption', { kind: 'audio', transcript })
      expect(body({ messages: [m] })).toBe('[09:05] Ana Gómez: 🎤 (audio sin transcribir)')
    }
  })
  it('renders an own mass message as a label with an excerpt that collapses whitespace and cuts at 60 units', () => {
    const text = 'Atención a todos:  el  consultorio\natiende de 9 a 17 hs.  Gracias por avisar con tiempo.'
    const expected = 'Atención a todos: el consultorio atiende de 9 a 17 hs. Graci'
    expect(expected).toHaveLength(60)
    expect(body({ messages: [mine(T, text, { isMass: true })] })).toBe(
      `[09:05] Sofía [VOS]: (mensaje masivo tuyo, no es una respuesta personal) «${expected}…»`,
    )
  })
  it('collapses whitespace before cutting', () => {
    const text = `${'a'.repeat(59)}   b${'c'.repeat(30)}`
    expect(body({ messages: [mine(T, text, { isMass: true })] })).toBe(
      `[09:05] Sofía [VOS]: (mensaje masivo tuyo, no es una respuesta personal) «${'a'.repeat(59)} …»`,
    )
  })
  it('adds the ellipsis to a short mass message too, even though nothing was cut', () => {
    const text = 'Aviso: hoy no atiendo, escribime mañana.'
    expect(body({ messages: [mine(T, text, { isMass: true })] })).toBe(
      `[09:05] Sofía [VOS]: (mensaje masivo tuyo, no es una respuesta personal) «${text}…»`,
    )
  })
  it('lets an audio override the mass label', () => {
    const withTranscript = mine(T, 'x'.repeat(50), { kind: 'audio', transcript: 'hola', isMass: true })
    const without = mine(T, 'x'.repeat(50), { kind: 'audio', isMass: true })
    expect(body({ messages: [withTranscript] })).toBe('[09:05] Sofía [VOS]: 🎤 (audio) hola')
    expect(body({ messages: [without] })).toBe('[09:05] Sofía [VOS]: 🎤 (audio sin transcribir)')
  })
  it('shows the kind placeholder, not the mass label, for a mass entry with no text', () => {
    expect(body({ messages: [mine(T, null, { kind: 'image', isMass: true })] })).toBe('[09:05] Sofía [VOS]: [imagen]')
    expect(body({ messages: [mine(T, '', { isMass: true })] })).toBe('[09:05] Sofía [VOS]: [mensaje]')
  })
  it('does not apply the mass label to a message that is not mass', () => {
    expect(body({ messages: [mine(T, 'x'.repeat(50))] })).toBe(`[09:05] Sofía [VOS]: ${'x'.repeat(50)}`)
  })
})

describe('copies of the same message in other groups', () => {
  const line = (copies: number) => body({ messages: [from('Marcos', T, 'Aviso', { copies })], isGroup: true })
  it('adds nothing for zero copies', () => expect(line(0)).toBe('[09:05] Marcos: Aviso'))
  it('uses the singular for one', () => expect(line(1)).toBe('[09:05] Marcos: Aviso (mismo mensaje en 1 grupo más)'))
  it('uses the plural for more', () => {
    expect(line(2)).toBe('[09:05] Marcos: Aviso (mismo mensaje en 2 grupos más)')
    expect(line(3)).toBe('[09:05] Marcos: Aviso (mismo mensaje en 3 grupos más)')
  })
  it('goes after the audio body too', () => {
    const m = from('Marcos', T, null, { kind: 'audio', copies: 1 })
    expect(body({ messages: [m] })).toBe('[09:05] Marcos: 🎤 (audio sin transcribir) (mismo mensaje en 1 grupo más)')
  })
})

describe('truncation and context', () => {
  const line = (n: number) => from('A', T, 'x'.repeat(n)) // "[09:05] A: " is 11 units
  it('does not cut a transcript of exactly the limit and adds no marker', () => {
    expect(body({ messages: [line(19)], maxChars: 30 })).toBe(`[09:05] A: ${'x'.repeat(19)}`)
  })
  it('cuts one unit over the limit, keeps the end and adds the marker line', () => {
    expect(body({ messages: [line(20)], maxChars: 30 })).toBe(
      `(…mensajes anteriores recortados…)\n09:05] A: ${'x'.repeat(20)}`,
    )
  })
  it('does not count the context block in the cut', () => {
    const context = [from('A', ba(4, 21, 8, 0), 'y'.repeat(100))]
    expect(body({ messages: [line(19)], context, maxChars: 30 })).toBe(
      `Mensajes anteriores, ya leídos (solo como contexto, no los resumas):\n[08:00] A: ${'y'.repeat(100)}\n\n` +
        `Mensajes sin leer (resumí estos):\n[09:05] A: ${'x'.repeat(19)}`,
    )
  })
  it('puts the context first and the unread messages after, with the marker inside the unread block', () => {
    const context = [from('A', ba(4, 21, 8, 0), 'c')]
    expect(render({ messages: [line(40)], context, maxChars: 30 })).toBe(
      `${MARK}Mensajes anteriores, ya leídos (solo como contexto, no los resumas):\n[08:00] A: c\n\n` +
        'Mensajes sin leer (resumí estos):\n(…mensajes anteriores recortados…)\n' +
        `${`[09:05] A: ${'x'.repeat(40)}`.slice(-30)}`,
    )
  })
  it('adds no context block when there is no context', () => {
    expect(render({ messages: [line(1)] })).not.toContain('Mensajes')
  })
  it('counts UTF-16 units: an emoji is two', () => {
    const out = body({ messages: [from('A', T, `${'x'.repeat(18)}😀`)], maxChars: 20 })
    expect(out).toBe(`(…mensajes anteriores recortados…)\n${`[09:05] A: ${'x'.repeat(18)}😀`.slice(-20)}`)
    expect(out.split('\n')[1]).toHaveLength(20)
  })
})

describe('golden outputs', () => {
  const calls = (scenario: string) =>
    (goldenJson(`${scenario}/run-1/llm-input.json`) as { calls: { chatName: string; userMessage: string }[] }).calls
  const expected = (scenario: string, chatName: string) => {
    const call = calls(scenario).find((c) => c.chatName === chatName)
    if (!call) throw new Error(`no golden call for ${chatName}`)
    return call.userMessage
  }

  it('05-unread-only: Diego Iglesias, with a 5-message context block', () => {
    const d = (h: number, m: number, text: string) => from('Diego Iglesias', ba(4, 20, h, m), text)
    const s = (h: number, m: number, text: string) => mine(ba(4, 20, h, m), text)
    const out = es.render(
      transcript({
        name: 'Diego Iglesias',
        context: [
          d(18, 10, 'Empate, jugamos mal'),
          s(18, 15, 'Qué lástima'),
          d(9, 0, 'Che, ¿mañana jugás?'),
          s(9, 5, 'Sí, si no llueve'),
          d(9, 10, 'Genial'),
        ],
        messages: [
          d(9, 20, 'Sofi, ¿puedo pasar a buscarte a las 20?'),
          s(9, 25, 'Mejor a las 20:30'),
          d(9, 30, 'Perfecto, 20:30 entonces'),
          d(9, 35, 'Llevo yo las pelotas'),
        ],
      }),
    )
    expect(out).toBe(expected('05-unread-only', 'Diego Iglesias'))
  })

  it('05-unread-only: a group, with sender names in the context', () => {
    const out = es.render(
      transcript({
        name: 'Equipo de Fútbol 5',
        isGroup: true,
        context: [
          from('Nacho Olivera', ba(4, 20, 12, 0), 'Hoy juego a las 21 en la cancha de siempre'),
          mine(ba(4, 20, 12, 5), 'Yo llevo las pecheras'),
        ],
        messages: [
          from('Nacho Olivera', ba(4, 20, 12, 10), 'Perfecto, gracias Sofi'),
          from('Tomi Paz', ba(4, 20, 12, 15), '¿Hay lugar para uno más?'),
        ],
      }),
    )
    expect(out).toBe(expected('05-unread-only', 'Equipo de Fútbol 5'))
  })

  it('06-truncation: a cut inside the first line, with the context added after it', () => {
    const g = (h: number, m: number, text: string) => from('Gonzalo Peña', ba(7, 7, h, m), text)
    const o = (h: number, m: number, text: string) => mine(ba(7, 7, h, m), text)
    const out = es.render(
      transcript({
        name: 'Gonzalo Peña',
        maxChars: 300,
        context: [
          g(8, 10, fill(90, 'k')),
          o(8, 20, fill(90, 'l')),
          g(8, 30, fill(90, 's')),
          o(8, 40, fill(90, 't')),
          g(8, 50, fill(90, 'u')),
        ],
        messages: [g(10, 0, fill(150, 'v')), o(10, 5, fill(100, 'w')), g(10, 10, fill(150, 'x'))],
      }),
    )
    expect(out).toBe(expected('06-truncation', 'Gonzalo Peña'))
  })

  it('06-truncation: exactly the limit, one over, and a cut that splits an emoji', () => {
    const lines = (name: string, texts: string[], firstMinute: number) =>
      texts.map((text, i) => from(name, ba(7, 7, 9, firstMinute + i), text))
    const run = (name: string, texts: string[], firstMinute: number) =>
      es.render(transcript({ name, maxChars: 300, messages: lines(name, texts, firstMinute) }))
    const ana = run('Ana Torres', [fill(80, 'a'), fill(80, 'b'), fill(78, 'c')], 0)
    expect(ana).toBe(expected('06-truncation', 'Ana Torres'))
    const omar = run('Omar Vega', [fill(80, 'd'), fill(80, 'e'), fill(82, 'f')], 10)
    expect(omar).toBe(expected('06-truncation', 'Omar Vega'))
    const emi = run('Emi Díaz', [`${fill(30, 'g')}😀${fill(20, 'h')}`, fill(120, 'i'), fill(121, 'j')], 30)
    expect(emi).toBe(expected('06-truncation', 'Emi Díaz'))
  })

  it('03-own-mass-in-context: the mass label and the context block', () => {
    const massLong = 'Atención a todos:  el  consultorio\natiende de 9 a 17 hs.  Gracias por avisar con tiempo.'
    const massShort = 'Aviso: hoy no atiendo, escribime mañana.'
    const l = (h: number, m: number, text: string) => from('Lola Vega', ba(4, 21, h, m), text)
    const out = es.render(
      transcript({
        name: 'Lola Vega',
        context: [
          l(8, 50, 'Buen día Sofi'),
          l(9, 0, 'Hola Sofi, ¿viste mi mensaje?'),
          mine(ba(4, 21, 9, 5), massLong, { isMass: true }),
          mine(ba(4, 21, 9, 10), massShort, { isMass: true }),
          l(9, 15, 'Dale, quedo atenta'),
        ],
        messages: [l(10, 20, 'Sofi, ¿confirmás el turno de mañana?'), l(10, 25, 'Necesito saber antes de las 18')],
      }),
    )
    expect(out).toBe(expected('03-own-mass-in-context', 'Lola Vega'))
  })

  it('04-repeated-group-notices: the "(mismo mensaje en 3 grupos más)" suffix', () => {
    const notice = 'Recordatorio: la reunión de consorcio es el jueves a las 18 hs.'
    const out = es.render(
      transcript({
        name: 'Consorcio Los Aromos',
        isGroup: true,
        messages: [
          from('Nora Cabrera', ba(4, 17, 8, 0), 'Buen día a todos'),
          from('Marcos Acosta', ba(4, 17, 10, 15), notice, { copies: 3 }),
          from('Marcos Acosta', ba(4, 17, 10, 20), '¡Gracias!'),
        ],
      }),
    )
    expect(out).toBe(expected('04-repeated-group-notices', 'Consorcio Los Aromos'))
  })

  it('07-audios: with and without transcript, mine and theirs', () => {
    const out = es.render(
      transcript({
        name: 'Julia Soto',
        messages: [
          from('Julia Soto', ba(4, 22, 9, 30), '¿Pudiste escuchar lo que te mandé ayer?'),
          mine(ba(4, 22, 9, 40), null, {
            kind: 'audio',
            transcript: 'Sí, lo escuché. Mañana te llamo para coordinar.',
          }),
          mine(ba(4, 22, 9, 41), null, { kind: 'audio' }),
        ],
      }),
    )
    expect(out).toBe(expected('07-audios', 'Julia Soto'))
  })
})

describe('english', () => {
  it('writes the same structure with English texts', () => {
    const context = [from('Ana', ba(4, 21, 8, 0), 'Hi')]
    const messages = [
      from('Ana', ba(4, 21, 9, 5), null, { kind: 'image' }),
      mine(ba(4, 21, 9, 6), 'Long mass text '.repeat(4), { isMass: true }),
      from('Ana', ba(4, 21, 9, 7), null, { kind: 'audio', transcript: 'See you' }),
      from('Ana', ba(4, 21, 9, 8), null, { kind: 'audio' }),
      from('Ana', ba(4, 21, 9, 9), 'Notice', { copies: 1 }),
      from('Ana', ba(4, 21, 9, 10), 'Notice', { copies: 2 }),
    ]
    expect(en.render(transcript({ name: 'Lot 7', isGroup: true, ownerName: 'Sam', context, messages }))).toBe(
      [
        'Group: Lot 7',
        '',
        'Earlier messages, already read (context only, do not summarize them):',
        '[08:00] Ana: Hi',
        '',
        'Unread messages (summarize these):',
        '[09:05] Ana: [image]',
        '[09:06] Sam [YOU]: (your own mass message, not a personal reply) «Long mass text Long mass text Long mass text Long mass text …»',
        '[09:07] Ana: 🎤 (audio) See you',
        '[09:08] Ana: 🎤 (audio not transcribed)',
        '[09:09] Ana: Notice (same message in 1 more group)',
        '[09:10] Ana: Notice (same message in 2 more groups)',
      ].join('\n'),
    )
  })
  it('marks the cut in English and uses "Chat with" for individual chats', () => {
    const out = en.render(transcript({ messages: [from('A', T, 'x'.repeat(40))], maxChars: 10 }))
    expect(out).toBe('Chat with: Ana Gómez\n\n(…earlier messages cut…)\nxxxxxxxxxx')
  })
})
