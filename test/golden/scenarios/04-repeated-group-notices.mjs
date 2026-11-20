// Rule covered: the same notice sent to several groups is summarized once (dropRepeatedAcrossGroups).
//   - Only GROUPS are processed. The key is the sender (or "yo" for my own messages) plus the TRIMMED text.
//   - Texts shorter than 40 characters after trimming are never deduplicated; audio is never deduplicated.
//   - The notice is kept in the first group in CHAT ORDER, which is the order of each chat's first message in
//     the window, not the order of the copies. The kept copy gets "(mismo mensaje en 1 grupo más)" or
//     "(mismo mensaje en N grupos más)".
//   - A group left empty, or with only my messages, is dropped (no LLM call). Individual chats are not touched.
//
// Chat order by first message: Marcos (individual) 07:30, Lucía (individual) 07:45, GA 08:00, GB 08:30,
// GC 09:05, GD 09:50, GE 10:30, GF 10:45.
//
// Cases:
//   - N1 (Marcos) in GA 10:15, GB 08:45, GC 09:10 and GE 10:30: kept in GA although GB has the EARLIEST copy,
//     because GA comes first in chat order; the line says "3 grupos más" (plural).
//   - N2 (Lucía) in GB and GD, the GD copy with trailing spaces: the trimmed key matches; kept in GB with
//     "1 grupo más" (singular).
//   - N5 (Pedro) in GD and GF: kept in GD, "1 grupo más". T40 (Pedro, exactly 40 characters) in GD and GF:
//     deduplicated too, so the threshold is "< 40".
//   - T39 (Rita, 39 characters plus a trailing space, so the RAW text has 40) in GB and GC: kept in both,
//     because the length is measured after trim.
//   - "¡Gracias!" (Marcos) in GA, GB, GC: short, never deduplicated.
//   - The text of N1 sent by Nora (a different sender) to GD: kept, not deduplicated against Marcos' copies.
//   - SELF (my own long notice) in GC and GE: key "yo", kept in GC with "1 grupo más".
//   - An anonymous copy of SELF (not mine, no sender_jid, no sender_name) in GD: its key is "?", not "yo", so it
//     is kept and is not mixed up with my copies (my own rows also have no sender_jid or sender_name).
//   - Audio is never deduplicated: Rita's identical audio (same transcript, plus a caption text so that the
//     audio guard is what decides, not a crash) in GB and GC stays in both.
//   - GE contains only Marcos' N1 and my SELF, both dropped: the group disappears (no LLM call).
//   - GF keeps only my short reply after N5 and T40 are dropped: the group disappears (no LLM call).
//   - Individual chats are not deduplicated: Marcos' chat has N1 twice and Lucía's chat has N2, and all of
//     them stay. They come BEFORE every group, so if they were processed they would take the "first" copy.
//   - Inherited behavior: Rita sends N4 twice in GC and nowhere else. The second copy is dropped and the first
//     says "1 grupo más" although it is the same group.
//
// Why arrival order cannot make this pass by accident: the earliest copy of N1 is in GB, the kept one is in GA;
// the individual chats arrive before all groups; the kept SELF copy is in the earlier chat, not the later one.
// All message times are unique. All names, numbers and texts are invented.

const chars = (s, n) => {
  if ([...s].length !== n) throw new Error(`Expected ${n} characters in ${JSON.stringify(s)}`)
  return s
}

const N1 = 'Recordatorio: la reunión de consorcio es el jueves a las 18 hs.'
const N2 = 'Se cortará el agua del edificio el sábado de 9 a 13 por obras.'
const N4 = 'Se vende bicicleta rodado 26, impecable, consultas por privado.'
const N5 = 'Mañana pasa el recolector de residuos voluminosos desde las 8.'
const AUDIO = 'Les cuento por audio que el jueves la reunión se pasa para las 19 en el SUM.'
const SELF = 'Gracias a todos por venir a la reunión, fue muy productiva.'
const T40 = chars('Pasen por secretaría a retirar el recibo', 40)
const T39 = `${chars('Pasen por secretaría a retirar el sello', 39)} ` // raw length 40, trimmed length 39
for (const t of [N1, N2, N4, N5, SELF]) if (t.length < 40) throw new Error(`Notice too short: ${t}`)

const marcos = '9941738467278@s.whatsapp.net'
const lucia = '9942937919782@s.whatsapp.net'
const nora = '9943988591875@s.whatsapp.net'
const pedro = '9944124255411@s.whatsapp.net'
const rita = '9945138449688@s.whatsapp.net'
const ga = '120363387184672398@g.us'
const gb = '120363448592332448@g.us'
const gc = '120363458646478911@g.us'
const gd = '120363472499538539@g.us'
const ge = '120363485428972779@g.us'
const gf = '120363537851146659@g.us'

export default {
  description: 'Repeated notices across groups: key, 40-character threshold, chat order, annotations, disappearing groups.',
  config: {
    miNombre: 'Sofía',
    horasPorDefecto: 24,
    soloNoLeidos: false,
    maxCaracteresPorChat: 6000,
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
    { jid: marcos, name: null, unread_count: 0 },
    { jid: lucia, name: null, unread_count: 0 },
    { jid: ga, name: 'Consorcio Los Aromos', unread_count: 0 },
    { jid: gb, name: 'Vecinos del 3°', unread_count: 0 },
    { jid: gc, name: 'Feria de Plaza Sur', unread_count: 0 },
    { jid: gd, name: 'Comisión de Obras', unread_count: 0 },
    { jid: ge, name: 'Club de Lectura', unread_count: 0 },
    { jid: gf, name: 'Taller de Cerámica', unread_count: 0 },
  ],
  contacts: [
    { jid: marcos, name: 'Marcos Acosta' },
    { jid: lucia, name: 'Lucía Benítez' },
    { jid: nora, name: 'Nora Cabrera' },
    { jid: pedro, name: 'Pedro Duarte' },
    { jid: rita, name: 'Rita Escobar' },
  ],
  messages: [
    // Individual chats, before every group: not deduplicated
    { chat: marcos, at: '2026-05-05 07:30', text: N1 },
    { chat: marcos, at: '2026-05-05 07:35', text: N1 },
    { chat: lucia, at: '2026-05-05 07:45', text: N2 },
    // GA: first message 08:00; the kept copy of N1 comes late, at 10:15
    { chat: ga, at: '2026-05-05 08:00', sender: nora, text: 'Buen día a todos' },
    { chat: ga, at: '2026-05-05 10:15', sender: marcos, text: N1 },
    { chat: ga, at: '2026-05-05 10:20', sender: marcos, text: '¡Gracias!' },
    // GB: first message 08:30; earliest copy of N1 (08:45, dropped), kept N2, short and T39 texts
    { chat: gb, at: '2026-05-05 08:30', sender: lucia, text: 'Buen día vecinos' },
    { chat: gb, at: '2026-05-05 08:45', sender: marcos, text: N1 },
    { chat: gb, at: '2026-05-05 08:50', sender: lucia, text: N2 },
    { chat: gb, at: '2026-05-05 08:55', sender: rita, text: T39 },
    { chat: gb, at: '2026-05-05 09:00', sender: marcos, text: '¡Gracias!' },
    { chat: gb, at: '2026-05-05 09:01', sender: rita, kind: 'audio', text: AUDIO, transcript: AUDIO },
    // GC: N1 copy (dropped), my notice (kept), Rita's N4 twice, T39 again, short text
    { chat: gc, at: '2026-05-05 09:05', sender: rita, text: 'Buenas, ¿alguien va a la feria?' },
    { chat: gc, at: '2026-05-05 09:10', sender: marcos, text: N1 },
    { chat: gc, at: '2026-05-05 09:20', from_me: 1, text: SELF },
    { chat: gc, at: '2026-05-05 09:25', sender: rita, text: N4 },
    { chat: gc, at: '2026-05-05 09:35', sender: rita, text: N4 },
    { chat: gc, at: '2026-05-05 09:36', sender: rita, text: T39 },
    { chat: gc, at: '2026-05-05 09:37', sender: rita, kind: 'audio', text: AUDIO, transcript: AUDIO },
    { chat: gc, at: '2026-05-05 09:40', sender: marcos, text: '¡Gracias!' },
    // GD: kept N5 and T40, Nora's copy of N1's text (different sender), Lucía's N2 with trailing spaces (dropped)
    { chat: gd, at: '2026-05-05 09:50', sender: pedro, text: N5 },
    { chat: gd, at: '2026-05-05 09:55', sender: nora, text: N1 },
    { chat: gd, at: '2026-05-05 10:00', sender: lucia, text: `${N2}  ` },
    { chat: gd, at: '2026-05-05 10:02', text: SELF },
    { chat: gd, at: '2026-05-05 10:05', sender: pedro, text: T40 },
    // GE: only dropped copies: the group disappears
    { chat: ge, at: '2026-05-05 10:30', sender: marcos, text: N1 },
    { chat: ge, at: '2026-05-05 10:35', from_me: 1, text: SELF },
    // GF: dropped copies and a short reply of mine: the group disappears
    { chat: gf, at: '2026-05-05 10:45', sender: pedro, text: N5 },
    { chat: gf, at: '2026-05-05 10:50', from_me: 1, text: 'Gracias, lo reviso' },
    { chat: gf, at: '2026-05-05 10:55', sender: pedro, text: T40 },
  ],
  state: {},
  llm: {
    [marcos]: { resumen: 'Marcos recuerda dos veces la reunión de consorcio del jueves.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [lucia]: { resumen: 'Lucía avisa del corte de agua del sábado.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [ga]: { resumen: 'Marcos recuerda la reunión de consorcio del jueves a las 18.', pendientes: ['Ir a la reunión del jueves'], necesita_respuesta: false, prioridad: 'alta' },
    [gb]: { resumen: 'Corte de agua el sábado y aviso sobre el sello en secretaría.', pendientes: [], necesita_respuesta: false, prioridad: 'media' },
    [gc]: { resumen: 'Sofía agradece a todos, Rita vende una bicicleta y pregunta por la feria.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [gd]: { resumen: 'Mañana pasa el recolector, Nora repite el aviso del consorcio y piden pasar por el recibo.', pendientes: ['Sacar los residuos voluminosos'], necesita_respuesta: false, prioridad: 'media' },
  },
  runs: [{ args: ['--desde', '2026-05-05 06:00', '--hasta', '2026-05-05 22:00'] }],
}
