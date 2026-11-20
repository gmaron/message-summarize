// Rule covered: soloNoLeidos, summarizing only from the first unread message of each chat (unreadTail).
//   - chats.unread_count = -1 (marked unread by hand): every message of the window, no context.
//   - 0 or null: the chat is skipped.
//   - N > 0: the unread messages are the last N INCOMING messages of the chat (whole chat, not only the window)
//     that have read = 0. The transcript starts at the first of them that is inside the window and goes on to
//     the end of the window, including my own messages and incoming ones already read.
//   - The context is the 5 messages right before that point (ts <), mine included, even from before the window.
//   - If none of the unread messages is inside the window, the chat is skipped.
//   - The headline says "con mensajes sin leer".
// Window: 2026-06-02 08:00 to 20:00.
//
// Cases:
//   - Ágata, -1: all her window messages, no context, although there is an older message the day before.
//   - Bruno, 0, with messages still read = 0 (stale counter): skipped. Camila, null: skipped. (With 0,
//     unreadIds would return nothing anyway because of LIMIT 0, so the guard cannot be told apart for 0.)
//   - Diego, N = 3, many earlier messages: the transcript starts at his third-to-last incoming message, even
//     though an older incoming message INSIDE the window (09:10) still has read = 0: it is not among the last 3,
//     so it is not unread; it goes to the context, not to the tail. There are 7 earlier messages, the context
//     is cut at 5 (the 06-01 messages at 18:00 and 18:05 are left out) and it crosses the start of the window,
//     with my own messages in it.
//   - Elena, N = 4, with the 1st and 3rd of the last 4 marked read = 1: the tail starts at the 2nd (first with
//     read = 0), keeps the read message that follows it and my reply, and the context has only 2 messages
//     (fewer than 5; one of them from the day before). Her older incoming message is read = 1, so it does
//     not prove the limit N; Diego does.
//   - Fabián, N = 10 (more than his incoming messages): the first unread message is the first message of the
//     chat, so there is no context block at all.
//   - Gaby, N = 2 but her last 2 incoming messages are read = 1: skipped.
//   - Hernán, N = 2 but the last 2 incoming messages arrive after the window ends: skipped.
//   - Irene, N = 3: the first unread message is before the window and the last one is after it, so only the one
//     in the window is summarized; the older one is in the context.
//   - Equipo de Fútbol 5 (group), N = 2: context and tail with sender names.
//
// Why arrival order cannot make this pass by accident: the tail starts in the middle of each chat, not at its
// first message, so ignoring unread_count or read produces longer transcripts and different contexts; the
// context depends on messages from before the window that arrive earlier than everything else.
// All message times are unique. All names, numbers and texts are invented.

const agata = '9946511262991@s.whatsapp.net'
const bruno = '9946691124419@s.whatsapp.net'
const camila = '9946941896958@s.whatsapp.net'
const diego = '9947787877411@s.whatsapp.net'
const elena = '9949788747783@s.whatsapp.net'
const fabian = '9951184868459@s.whatsapp.net'
const gaby = '9951198694539@s.whatsapp.net'
const hernan = '9952429388925@s.whatsapp.net'
const irene = '9952723596281@s.whatsapp.net'
const nacho = '9953164972271@s.whatsapp.net'
const tomi = '9953474965423@s.whatsapp.net'
const futbol = '120363563362171186@g.us'

export default {
  description: 'soloNoLeidos: unread_count -1 / 0 / null / N, read flags, context of 5 messages, window edges.',
  config: {
    miNombre: 'Sofía',
    horasPorDefecto: 24,
    soloNoLeidos: true,
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
    { jid: agata, name: null, unread_count: -1 },
    { jid: bruno, name: null, unread_count: 0 },
    { jid: camila, name: null }, // unread_count stays null
    { jid: diego, name: null, unread_count: 3 },
    { jid: elena, name: null, unread_count: 4 },
    { jid: fabian, name: null, unread_count: 10 },
    { jid: gaby, name: null, unread_count: 2 },
    { jid: hernan, name: null, unread_count: 2 },
    { jid: irene, name: null, unread_count: 3 },
    { jid: futbol, name: 'Equipo de Fútbol 5', unread_count: 2 },
  ],
  contacts: [
    { jid: agata, name: 'Ágata Fuentes' },
    { jid: bruno, name: 'Bruno Gil' },
    { jid: camila, name: 'Camila Herrera' },
    { jid: diego, name: 'Diego Iglesias' },
    { jid: elena, name: 'Elena Juárez' },
    { jid: fabian, name: 'Fabián Kramer' },
    { jid: gaby, name: 'Gaby Lombardi' },
    { jid: hernan, name: 'Hernán Medina' },
    { jid: irene, name: 'Irene Navarro' },
    { jid: nacho, name: 'Nacho Olivera' },
    { jid: tomi, name: 'Tomi Paz' },
  ],
  messages: [
    // Ágata (-1): one message from the day before, then three in the window
    { chat: agata, at: '2026-06-01 21:00', text: 'Hola Sofi, te escribo mañana por lo del viaje' },
    { chat: agata, at: '2026-06-02 08:10', text: 'Buen día, ¿ya viste los pasajes?' },
    { chat: agata, at: '2026-06-02 08:15', from_me: 1, text: 'Todavía no, los miro hoy' },
    { chat: agata, at: '2026-06-02 08:20', text: 'Dale, avisame' },
    // Bruno (0): skipped
    { chat: bruno, at: '2026-06-02 08:30', text: '¿Te sirve el martes?' },
    { chat: bruno, at: '2026-06-02 08:35', text: 'Dime cuando puedas' },
    // Camila (null): skipped
    { chat: camila, at: '2026-06-02 08:40', text: 'Te mando el archivo más tarde' },
    { chat: camila, at: '2026-06-02 08:45', text: 'Avisame si llegó' },
    // Diego (3): 4 messages the day before, 3 earlier in the window, then the unread tail
    { chat: diego, at: '2026-06-01 18:00', read: 1, text: 'Sofi, ¿viste el partido?' },
    { chat: diego, at: '2026-06-01 18:05', from_me: 1, text: 'No pude, ¿cómo salió?' },
    { chat: diego, at: '2026-06-01 18:10', read: 1, text: 'Empate, jugamos mal' },
    { chat: diego, at: '2026-06-01 18:15', from_me: 1, text: 'Qué lástima' },
    { chat: diego, at: '2026-06-02 09:00', read: 1, text: 'Che, ¿mañana jugás?' },
    { chat: diego, at: '2026-06-02 09:05', from_me: 1, text: 'Sí, si no llueve' },
    { chat: diego, at: '2026-06-02 09:10', text: 'Genial' },
    { chat: diego, at: '2026-06-02 09:20', text: 'Sofi, ¿puedo pasar a buscarte a las 20?' },
    { chat: diego, at: '2026-06-02 09:25', from_me: 1, text: 'Mejor a las 20:30' },
    { chat: diego, at: '2026-06-02 09:30', text: 'Perfecto, 20:30 entonces' },
    { chat: diego, at: '2026-06-02 09:35', text: 'Llevo yo las pelotas' },
    // Elena (4): an older incoming message, then e1 (read), e2 (unread), my reply, e3 (read), e4 (unread)
    { chat: elena, at: '2026-06-01 22:00', read: 1, text: 'Sofi, buen día de mañana' },
    { chat: elena, at: '2026-06-02 10:00', read: 1, text: 'Te cuento lo de la mudanza' },
    { chat: elena, at: '2026-06-02 10:05', text: 'Ya tengo el camión para el sábado' },
    { chat: elena, at: '2026-06-02 10:10', from_me: 1, text: 'Qué bueno, ¿a qué hora?' },
    { chat: elena, at: '2026-06-02 10:15', read: 1, text: 'A las 9, si podés ayudar' },
    { chat: elena, at: '2026-06-02 10:20', text: 'Traé guantes y cinta' },
    // Fabián (10): first message of the chat is unread, no context
    { chat: fabian, at: '2026-06-02 10:30', text: 'Hola Sofi, soy Fabián, el del curso de fotografía' },
    { chat: fabian, at: '2026-06-02 10:35', from_me: 1, text: 'Hola Fabián, ¿cómo estás?' },
    { chat: fabian, at: '2026-06-02 10:40', text: 'Bien, quería pasarte el programa' },
    { chat: fabian, at: '2026-06-02 10:45', text: 'Empieza el 15' },
    // Gaby (2): the last two incoming messages are read, stale counter: skipped
    { chat: gaby, at: '2026-06-02 11:00', read: 1, text: 'Ya te mandé el link' },
    { chat: gaby, at: '2026-06-02 11:05', read: 1, text: 'Avisame si abre' },
    { chat: gaby, at: '2026-06-02 11:10', from_me: 1, text: 'Abrió perfecto' },
    // Hernán (2): the unread messages arrive after the window ends: skipped
    { chat: hernan, at: '2026-06-02 11:30', read: 1, text: 'Sofi, ¿cómo va el trabajo?' },
    { chat: hernan, at: '2026-06-02 11:35', from_me: 1, text: 'Bien, entregando mañana' },
    { chat: hernan, at: '2026-06-02 21:00', text: 'Cuando termines avisame' },
    { chat: hernan, at: '2026-06-02 21:10', text: 'Estoy esperando tu mail' },
    // Irene (3): unread before the window, one in the window, one after it
    { chat: irene, at: '2026-06-02 07:00', text: 'Sofi, ¿tenés el contacto del gasista?' },
    { chat: irene, at: '2026-06-02 19:30', text: 'Perdón, también necesito el del plomero' },
    { chat: irene, at: '2026-06-02 20:30', text: 'Si no lo tenés, no pasa nada' },
    // Group (2): context and tail with sender labels
    { chat: futbol, at: '2026-06-02 12:00', sender: nacho, read: 1, text: 'Hoy juego a las 21 en la cancha de siempre' },
    { chat: futbol, at: '2026-06-02 12:05', from_me: 1, text: 'Yo llevo las pecheras' },
    { chat: futbol, at: '2026-06-02 12:10', sender: nacho, text: 'Perfecto, gracias Sofi' },
    { chat: futbol, at: '2026-06-02 12:15', sender: tomi, text: '¿Hay lugar para uno más?' },
  ],
  state: {},
  llm: {
    [agata]: { resumen: 'Ágata pregunta si Sofía vio los pasajes del viaje.', pendientes: ['Mirar los pasajes y avisarle a Ágata'], necesita_respuesta: false, prioridad: 'media' },
    [diego]: { resumen: 'Diego pasa a buscar a Sofía a las 20:30 y lleva las pelotas.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [elena]: { resumen: 'Elena pide ayuda con la mudanza del sábado a las 9, con guantes y cinta.', pendientes: ['Llevar guantes y cinta el sábado'], necesita_respuesta: false, prioridad: 'media' },
    [fabian]: { resumen: 'Fabián, del curso de fotografía, pasa el programa que empieza el 15.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [irene]: { resumen: 'Irene necesita el contacto de un plomero.', pendientes: [], necesita_respuesta: true, prioridad: 'alta' },
    [futbol]: { resumen: 'Nacho confirma el partido de hoy y Tomi pregunta si hay lugar para uno más.', pendientes: [], necesita_respuesta: true, prioridad: 'media' },
  },
  runs: [{ args: ['--desde', '2026-06-02 08:00', '--hasta', '2026-06-02 20:00'] }],
}
