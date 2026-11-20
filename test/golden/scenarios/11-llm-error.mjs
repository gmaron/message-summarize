// Rule covered: chats whose summary fails (the LLM throws).
//   - A failing chat is not in the results; the others are still summarized. stdout shows "error" for it.
//   - If there are errors, the WhatsApp text ends with "⚠️ N chats no se pudieron resumir". The legacy text says
//     "chats" for any N, including 1 ("1 chats"). The error messages themselves are never shown anywhere
//     in the digest, only the count.
//   - If ALL chats fail, results are empty but errors are not, so a digest is still produced and sent: the
//     headline says "0 chats con novedades...", there are no sections, and the warning line follows. The
//     messages of the failed chats are not retried: the pointer advances anyway.
//
// Runs (same DB; only run 1 has --desde, the others start at the pointer left by the previous run):
//   1. One chat fails (N=1) and two succeed. The failing chat is the first one in time, so the legacy loop
//      must keep going after the failure: Pedro and Rubén come after Ofelia.
//   2. Two chats fail (N=2) and two succeed (one is a group), again with the failures first in time.
//   3. Everything fails with a single chat (N=1, all chats): digest with "0 chats" and "1 chats no se pudieron resumir".
//   4. Everything fails with two chats (N=2), one of them a group.
//   Runs 2-4 have no --desde: each starts where the previous run ended, so the failed chats of run 3 are NOT
//   summarized again in run 4 (their messages are lost: the pointer advanced anyway). If the pointer did not
//   move after an all-failed run, Wanda would be sent to the LLM again in run 4.
//
// Why order does not make this pass by accident: the failing chats come first in time in every mixed run, and
// the successful ones have different priorities, so a loop that stops at the first error, or a count taken
// from the wrong list, changes the output. The all-fail runs come after the mixed ones, with a different
// window each, so the pointer and the outbox show them as separate digests. All message times are unique.
// All names, numbers and texts are invented.

const ofelia = '9984632219649@s.whatsapp.net'
const pedro = '9985217196177@s.whatsapp.net'
const ruben = '9985615286396@s.whatsapp.net'
const tomas = '9986645199636@s.whatsapp.net'
const ursula = '9987473348736@s.whatsapp.net'
const victor = '9988386782256@s.whatsapp.net'
const pena = '120363868135483324@g.us'
const wanda = '9988987229756@s.whatsapp.net'
const ximena = '9989595392334@s.whatsapp.net'
const vecinos = '120363986389438451@g.us'

export default {
  description: 'LLM errors: mixed with successes (N=1 and N>1), and runs where every chat fails (N=1 and N>1).',
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
    { jid: ofelia, name: 'Ofelia', unread_count: 0 },
    { jid: pedro, name: 'Pedro', unread_count: 0 },
    { jid: ruben, name: 'Rubén', unread_count: 0 },
    { jid: tomas, name: 'Tomás', unread_count: 0 },
    { jid: ursula, name: 'Úrsula', unread_count: 0 },
    { jid: victor, name: 'Víctor', unread_count: 0 },
    { jid: pena, name: 'Peña de Amigos', unread_count: 0 },
    { jid: wanda, name: 'Wanda', unread_count: 0 },
    { jid: ximena, name: 'Ximena', unread_count: 0 },
    { jid: vecinos, name: 'Vecinos del 2do', unread_count: 0 },
  ],
  contacts: [
    { jid: ofelia, name: 'Ofelia Quiroga' },
    { jid: pedro, name: 'Pedro Aguirre' },
    { jid: ruben, name: 'Rubén Mansilla' },
    { jid: tomas, name: 'Tomás Herrera' },
    { jid: ursula, name: 'Úrsula Vega' },
    { jid: victor, name: 'Víctor Lamas' },
    { jid: wanda, name: 'Wanda Pinto' },
    { jid: ximena, name: 'Ximena Ocampo' },
  ],
  messages: [
    // Run 1 (2026-04-08 08:00 to 10:00): Ofelia fails; Pedro and Rubén succeed
    { chat: ofelia, at: '2026-04-08 08:00', text: 'Sofi, ¿viste el mail del banco?' },
    { chat: ofelia, at: '2026-04-08 08:02', text: 'Dice que hay que actualizar los datos' },
    { chat: pedro, at: '2026-04-08 08:10', text: '¿Jugamos al pádel el sábado?' },
    { chat: ruben, at: '2026-04-08 08:20', text: 'Te paso el presupuesto de la reparación' },
    { chat: ruben, at: '2026-04-08 08:21', text: 'Son tres cuotas' },
    // Run 2 (10:00 to 12:00): Tomás and Úrsula fail; Víctor and Peña de Amigos succeed
    { chat: tomas, at: '2026-04-08 10:00', text: 'Sofi, ¿tenés el número del electricista?' },
    { chat: ursula, at: '2026-04-08 10:05', text: 'Mañana paso por los papeles' },
    { chat: victor, at: '2026-04-08 10:20', text: 'Gracias por lo de ayer' },
    { chat: pena, at: '2026-04-08 10:30', sender: victor, text: 'El asado es el domingo a las 13' },
    { chat: pena, at: '2026-04-08 10:32', sender: pedro, text: 'Yo llevo el pan' },
    // Run 3 (12:00 to 14:00): only Wanda, who fails
    { chat: wanda, at: '2026-04-08 12:00', text: 'Sofi, te escribo por la inscripción' },
    { chat: wanda, at: '2026-04-08 12:01', text: '¿Llegaste a completar el formulario?' },
    // Run 4 (14:00 to 16:00): Ximena and Vecinos del 2do, both fail
    { chat: ximena, at: '2026-04-08 14:00', text: 'Sofi, ¿me mandás la dirección?' },
    { chat: vecinos, at: '2026-04-08 14:10', sender: victor, text: 'Mañana limpian el tanque de agua' },
    { chat: vecinos, at: '2026-04-08 14:12', sender: tomas, text: 'Avisen si necesitan algo' },
  ],
  state: {},
  llm: {
    [ofelia]: { error: 'timeout: el modelo no respondió en 120 segundos' },
    [pedro]: { resumen: 'Pedro propone jugar al pádel el sábado.', pendientes: [], necesita_respuesta: true, prioridad: 'media' },
    [ruben]: {
      resumen: 'Rubén pasa el presupuesto de la reparación en tres cuotas.',
      pendientes: ['Revisar el presupuesto de Rubén'],
      necesita_respuesta: false,
      prioridad: 'alta',
    },
    [tomas]: { error: 'JSON inválido en la respuesta del modelo' },
    [ursula]: { error: 'proveedor no disponible' },
    [victor]: { resumen: 'Víctor agradece por lo de ayer.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [pena]: {
      resumen: 'Asado el domingo a las 13; Pedro lleva el pan.',
      pendientes: ['Confirmar asistencia al asado'],
      necesita_respuesta: false,
      prioridad: 'media',
    },
    [wanda]: { error: 'timeout: el modelo no respondió en 120 segundos' },
    [ximena]: { error: 'JSON inválido en la respuesta del modelo' },
    [vecinos]: { error: 'proveedor no disponible' },
  },
  runs: [
    { args: ['--desde', '2026-04-08 08:00', '--hasta', '2026-04-08 10:00'] },
    { args: ['--hasta', '2026-04-08 12:00'] },
    { args: ['--hasta', '2026-04-08 14:00'] },
    { args: ['--hasta', '2026-04-08 16:00'] },
  ],
}
