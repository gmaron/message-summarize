// Rule covered: my own mass messages are removed from the chats before summarizing.
//   - massTexts() looks at the WHOLE database, not only the window: a text of mine with at least 40 characters
//     (SQLite length(), which counts code points, not UTF-16 units) sent in at least 3 DISTINCT chats is mass.
//   - Mass lines are dropped from the transcript; a chat left with nothing, or with only my lines, is skipped.
//
// Cases (window 2026-04-20 08:00 to 20:00):
//   - M40, exactly 40 characters, in 4 chats: mass, removed (Beto and Cora keep only the rest).
//   - S39, 39 characters, in 3 chats: NOT mass, it stays in the transcripts.
//   - E39, 39 code points but 40 UTF-16 units (it has an emoji), in 3 chats: NOT mass. A port that measured
//     length in JavaScript string units would wrongly call it mass.
//   - N1, 45 characters, in 2 chats, and a near copy (one "!" instead of "." at the end) in a third: only 2
//     identical texts, NOT mass.
//   - P2, 47 characters, sent twice in Eli and once in Fede: 3 messages but only 2 distinct chats, NOT mass.
//   - OUTW, 53 characters: one copy in the window (Eli), one the day before (Juan) and one after the window
//     ends (Kari). It is mass because of the copies OUTSIDE the window, so it is removed from Eli.
//   - Dani wrote only (a mass text plus other lines of mine): all lines are mine, skipped (no LLM call).
//     Gabi wrote only short texts: skipped. (The filter only removes lines of mine, so a chat cannot go from
//     "has incoming" to "all mine" because of it.)
//   - Hugo has only a mass message: it is empty after the filter and skipped. This does not tell the redundant
//     skips apart (empty check at summarize.js:120, all-mine check at :124, final filter at :106): removing any
//     one of them leaves the output unchanged; only removing :124 and :106 together shows.
//   - Juan and Kari have no messages in the window: they never show up.
//
// Why arrival order cannot make this pass by accident: every verdict depends on counting chats across the whole
// database, including messages that arrive before and after the window; no test depends on which chat comes first.
// All message times are unique. All names, numbers and texts are invented.

const chars = (s, n) => {
  if ([...s].length !== n) throw new Error(`Expected ${n} characters in ${JSON.stringify(s)}`)
  return s
}
const units = (s, n) => {
  if (s.length !== n) throw new Error(`Expected ${n} UTF-16 units in ${JSON.stringify(s)}`)
  return s
}

const M40 = chars('Aviso: hoy no atiendo, escribime mañana.', 40)
const S39 = chars('Hoy el local cierra a las seis y media.', 39)
const E39 = units(chars('Nos vemos en la plaza hoy a las cinco 😀', 39), 40)
const N1 = chars('Consorcio: reunión el jueves 18 hs en el SUM.', 45)
const N1_NEAR = chars('Consorcio: reunión el jueves 18 hs en el SUM!', 45)
const P2 = chars('Se suspende la clase de hoy por lluvia, perdón!', 47)
const OUTW = chars('El taller de cerámica cambió de día: ahora el martes.', 53)

const beto = '9929945427978@s.whatsapp.net'
const cora = '9931292158168@s.whatsapp.net'
const dani = '9931695121572@s.whatsapp.net'
const eli = '9932128849692@s.whatsapp.net'
const fede = '9932339695991@s.whatsapp.net'
const gabi = '9932684563789@s.whatsapp.net'
const hugo = '9932768343897@s.whatsapp.net'
const juan = '9933568831267@s.whatsapp.net'
const kari = '9934185296885@s.whatsapp.net'

export default {
  description: 'Own mass messages: whole-database counting, length and distinct-chat thresholds, skipped chats.',
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
  chats: [beto, cora, dani, eli, fede, gabi, hugo, juan, kari].map((jid) => ({ jid, name: null, unread_count: 0 })),
  contacts: [
    { jid: beto, name: 'Beto Sosa' },
    { jid: cora, name: 'Cora Beltrán' },
    { jid: dani, name: 'Dani Rojas' },
    { jid: eli, name: 'Eli Paz' },
    { jid: fede, name: 'Fede Luna' },
    { jid: gabi, name: 'Gabi Núñez' },
    { jid: hugo, name: 'Hugo Vera' },
    { jid: juan, name: 'Juan Ortiz' },
    { jid: kari, name: 'Kari Ledesma' },
  ],
  messages: [
    // The day before the window: second copy of OUTW
    { chat: juan, at: '2026-04-19 18:00', from_me: 1, text: OUTW },
    // Beto: incoming, plus M40 (mass), S39, N1 and E39 (these stay)
    { chat: beto, at: '2026-04-20 08:00', text: 'Hola Sofi, ¿cómo va todo?' },
    { chat: beto, at: '2026-04-20 08:05', from_me: 1, text: M40 },
    { chat: beto, at: '2026-04-20 08:06', from_me: 1, text: S39 },
    { chat: beto, at: '2026-04-20 08:07', from_me: 1, text: N1 },
    { chat: beto, at: '2026-04-20 08:08', from_me: 1, text: E39 },
    { chat: beto, at: '2026-04-20 08:10', text: 'Todo bien, gracias por avisar' },
    // Cora: same pattern
    { chat: cora, at: '2026-04-20 08:20', text: 'Sofi, ¿mañana hay clase?' },
    { chat: cora, at: '2026-04-20 08:22', from_me: 1, text: M40 },
    { chat: cora, at: '2026-04-20 08:23', from_me: 1, text: S39 },
    { chat: cora, at: '2026-04-20 08:24', from_me: 1, text: N1 },
    { chat: cora, at: '2026-04-20 08:25', from_me: 1, text: E39 },
    { chat: cora, at: '2026-04-20 08:30', text: 'Perfecto, ahí estaré' },
    // Dani: only I wrote (a mass text plus texts that stay): skipped
    { chat: dani, at: '2026-04-20 09:00', from_me: 1, text: M40 },
    { chat: dani, at: '2026-04-20 09:01', from_me: 1, text: S39 },
    { chat: dani, at: '2026-04-20 09:02', from_me: 1, text: N1_NEAR },
    { chat: dani, at: '2026-04-20 09:03', from_me: 1, text: E39 },
    // Eli: P2 twice (not mass), OUTW (mass because of copies outside the window)
    { chat: eli, at: '2026-04-20 09:30', text: 'Sofi, ¿seguro hoy hay clase?' },
    { chat: eli, at: '2026-04-20 09:32', from_me: 1, text: P2 },
    { chat: eli, at: '2026-04-20 09:35', from_me: 1, text: OUTW },
    { chat: eli, at: '2026-04-20 09:40', from_me: 1, text: P2 },
    { chat: eli, at: '2026-04-20 09:45', text: 'Entiendo, gracias' },
    // Fede: P2 once, so P2 is in 2 distinct chats only
    { chat: fede, at: '2026-04-20 10:00', text: '¿Qué pasó con la clase?' },
    { chat: fede, at: '2026-04-20 10:02', from_me: 1, text: P2 },
    { chat: fede, at: '2026-04-20 10:05', text: 'Ah, ok' },
    // Gabi: only short texts of mine: skipped
    { chat: gabi, at: '2026-04-20 10:30', from_me: 1, text: 'Te llamo mañana' },
    { chat: gabi, at: '2026-04-20 10:31', from_me: 1, text: 'Besos' },
    // Hugo: only a mass message: empty after the filter, skipped
    { chat: hugo, at: '2026-04-20 11:00', from_me: 1, text: M40 },
    // After the window: third copy of OUTW
    { chat: kari, at: '2026-04-20 20:30', from_me: 1, text: OUTW },
  ],
  state: {},
  llm: {
    [beto]: { resumen: 'Beto saluda y confirma que todo va bien.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [cora]: { resumen: 'Cora pregunta si mañana hay clase y confirma que va.', pendientes: [], necesita_respuesta: false, prioridad: 'media' },
    [eli]: { resumen: 'Eli consulta por la clase de hoy; Sofía avisa que se suspende por lluvia.', pendientes: [], necesita_respuesta: false, prioridad: 'media' },
    [fede]: { resumen: 'Fede pregunta por la clase; Sofía avisa que se suspende.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
  },
  runs: [{ args: ['--desde', '2026-04-20 08:00', '--hasta', '2026-04-20 20:00'] }],
}
