// Rule covered: truncation of long transcripts (maxCaracteresPorChat = 300 here).
//   - If the rendered transcript (lines joined with "\n") is LONGER than the limit, it becomes
//     "(…mensajes anteriores recortados…)\n" + transcript.slice(-limit). The cut keeps the END and can fall in
//     the middle of a line: that is inherited behavior, frozen on purpose. Length is in UTF-16 units, so the
//     cut can even split an emoji in two.
//   - A transcript of exactly the limit is not cut.
//   - With soloNoLeidos, the context block is added AFTER the cut and does not count toward the limit.
//
// Cases (window 2026-07-07 08:00 to 20:00; the file asserts the exact lengths when it is loaded):
//   - Ana Torres, unread_count -1: transcript of exactly 300 characters: not cut, no marker.
//   - Omar Vega, -1: 301 characters, one over: the first character ("[") is dropped, marker added.
//   - Marina Cruz, -1: 551 characters in 6 lines: the cut falls in the middle of the third line.
//   - Emi Díaz, -1: 349 characters; the first 49 are dropped, which splits the emoji of the first line, so the
//     kept text starts with the second half of a surrogate pair.
//   - Gonzalo Peña, unread_count 2: the unread tail is 467 characters, so it is cut to 300 in the middle of its
//     first line; the context block (5 lines, 564 characters on its own, my own lines included) is added
//     afterwards, whole and uncut, and the total goes well beyond 300 plus the marker.
//   - Hilda Ríos, unread_count 1: the tail is short (80) and is not cut, but with the context block the whole
//     message is longer than the limit: there is no marker.
//
// Why arrival order cannot make this pass by accident: every verdict depends on lengths, not on order. The
// cut keeps the END of the transcript, so putting the long text in an early or a late line changes the output;
// the cut position is different in each chat.
// All message times are unique. All names, numbers and texts are invented.

const MAX = 300

// Invented filler of exactly n characters: "<tag>01 <tag>02 ..." so the cut point is easy to see
const fill = (n, tag) => {
  let s = ''
  for (let i = 1; s.length < n; i++) s += `${tag}${String(i).padStart(2, '0')} `
  s = s.slice(0, n)
  return s.endsWith(' ') ? `${s.slice(0, -1)}.` : s
}

const DAY = '2026-07-07'
// Mirrors how the legacy tool renders a line, only to assert the lengths below
const line = (hhmm, label, text) => `[${hhmm}] ${label}: ${text}`
const expect = (what, actual, wanted) => {
  if (actual !== wanted) throw new Error(`${what}: expected ${wanted}, got ${actual}`)
}

const ana = '9953773875532@s.whatsapp.net'
const omar = '9954749878772@s.whatsapp.net'
const marina = '9955328569774@s.whatsapp.net'
const emi = '9958486329435@s.whatsapp.net'
const gonzalo = '9958983683679@s.whatsapp.net'
const hilda = '9959921384218@s.whatsapp.net'

const anaTexts = [fill(80, 'a'), fill(80, 'b'), fill(78, 'c')]
const omarTexts = [fill(80, 'd'), fill(80, 'e'), fill(82, 'f')]
const marinaTexts = ['m', 'n', 'o', 'p', 'q', 'r'].map((tag) => fill(70, tag))
const emiTexts = [`${fill(30, 'g')}😀${fill(20, 'h')}`, fill(120, 'i'), fill(121, 'j')]
const gonzaloContext = [fill(90, 'k'), fill(90, 'l'), fill(90, 's'), fill(90, 't'), fill(90, 'u')]
const gonzaloTail = [fill(150, 'v'), fill(100, 'w'), fill(150, 'x')]
const hildaContext = ['y', 'z', 'A', 'B', 'C'].map((tag) => fill(80, tag))

const joined = (label, times, texts) => times.map((t, i) => line(t, label, texts[i])).join('\n')
expect('Ana Torres length', joined('Ana Torres', ['09:00', '09:01', '09:02'], anaTexts).length, MAX)
expect('Omar Vega length', joined('Omar Vega', ['09:10', '09:11', '09:12'], omarTexts).length, MAX + 1)
expect('Marina Cruz length', joined('Marina Cruz', ['09:20', '09:21', '09:22', '09:23', '09:24', '09:25'], marinaTexts).length, 551)
const emiTranscript = joined('Emi Díaz', ['09:30', '09:31', '09:32'], emiTexts)
expect('Emi Díaz length', emiTranscript.length, 349)
const emiKept = emiTranscript.slice(-MAX)
if (!(emiKept.charCodeAt(0) >= 0xdc00 && emiKept.charCodeAt(0) <= 0xdfff)) throw new Error('Emi Díaz: the cut must split the emoji')
expect('Gonzalo Peña tail length', [line('10:00', 'Gonzalo Peña', gonzaloTail[0]), line('10:05', 'Sofía [VOS]', gonzaloTail[1]), line('10:10', 'Gonzalo Peña', gonzaloTail[2])].join('\n').length, 467)
expect('Hilda Ríos tail length', line('11:00', 'Hilda Ríos', fill(60, 'D')).length, 80)

export default {
  description: 'Truncation: marker, slice from the end, exact limit, one over, mid-line and mid-emoji cuts, context outside the limit.',
  config: {
    miNombre: 'Sofía',
    horasPorDefecto: 24,
    soloNoLeidos: true,
    maxCaracteresPorChat: MAX,
    excluir: [],
    sinAgendarEnRojo: false,
    ocultarResto: false,
    proveedor: 'ollama',
    soloLocal: [],
    whisper: { modelo: 'models/none.bin', idioma: 'es' },
  },
  prompt: `<!-- Invented test prompt: this comment must not reach the model. -->
Sos el asistente de {{nombre}}. Resumí cada conversación en español rioplatense.
Marcá si {{nombre}} tiene que responder y listá sus pendientes.
`,
  chats: [
    { jid: ana, name: null, unread_count: -1 },
    { jid: omar, name: null, unread_count: -1 },
    { jid: marina, name: null, unread_count: -1 },
    { jid: emi, name: null, unread_count: -1 },
    { jid: gonzalo, name: null, unread_count: 2 },
    { jid: hilda, name: null, unread_count: 1 },
  ],
  contacts: [
    { jid: ana, name: 'Ana Torres' },
    { jid: omar, name: 'Omar Vega' },
    { jid: marina, name: 'Marina Cruz' },
    { jid: emi, name: 'Emi Díaz' },
    { jid: gonzalo, name: 'Gonzalo Peña' },
    { jid: hilda, name: 'Hilda Ríos' },
  ],
  messages: [
    ...anaTexts.map((text, i) => ({ chat: ana, at: `${DAY} 09:0${i}`, text })),
    ...omarTexts.map((text, i) => ({ chat: omar, at: `${DAY} 09:1${i}`, text })),
    ...marinaTexts.map((text, i) => ({ chat: marina, at: `${DAY} 09:2${i}`, text })),
    ...emiTexts.map((text, i) => ({ chat: emi, at: `${DAY} 09:3${i}`, text })),
    // Gonzalo: five earlier lines (read, mine included), then the unread tail
    { chat: gonzalo, at: `${DAY} 08:10`, read: 1, text: gonzaloContext[0] },
    { chat: gonzalo, at: `${DAY} 08:20`, from_me: 1, text: gonzaloContext[1] },
    { chat: gonzalo, at: `${DAY} 08:30`, read: 1, text: gonzaloContext[2] },
    { chat: gonzalo, at: `${DAY} 08:40`, from_me: 1, text: gonzaloContext[3] },
    { chat: gonzalo, at: `${DAY} 08:50`, read: 1, text: gonzaloContext[4] },
    { chat: gonzalo, at: `${DAY} 10:00`, text: gonzaloTail[0] },
    { chat: gonzalo, at: `${DAY} 10:05`, from_me: 1, text: gonzaloTail[1] },
    { chat: gonzalo, at: `${DAY} 10:10`, text: gonzaloTail[2] },
    // Hilda: five earlier lines, then one short unread message
    ...hildaContext.map((text, i) => ({ chat: hilda, at: `${DAY} 08:${15 + i * 10}`, read: 1, text })),
    { chat: hilda, at: `${DAY} 11:00`, text: fill(60, 'D') },
  ],
  state: {},
  llm: {
    [ana]: { resumen: 'Ana Torres manda tres mensajes largos, justo en el límite.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [omar]: { resumen: 'Omar Vega manda tres mensajes largos, uno más que el límite.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [marina]: { resumen: 'Marina Cruz manda seis mensajes largos.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [emi]: { resumen: 'Emi Díaz manda tres mensajes, el primero con un emoji.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [gonzalo]: { resumen: 'Gonzalo Peña manda dos mensajes largos sin leer.', pendientes: [], necesita_respuesta: true, prioridad: 'media' },
    [hilda]: { resumen: 'Hilda Ríos manda un mensaje corto sin leer.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
  },
  runs: [{ args: ['--desde', `${DAY} 08:00`, '--hasta', `${DAY} 20:00`] }],
}
