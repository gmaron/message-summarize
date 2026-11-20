// Rule covered: how a mass message of mine is shown when it appears as CONTEXT (soloNoLeidos).
//   - In the main transcript mass lines are removed, so the label "(mensaje masivo tuyo, no es una respuesta
//     personal) «…»" can only appear in the context block. The context is not filtered by isMass.
//   - The quoted text collapses runs of whitespace (and line breaks) into one space and is cut at 60 UTF-16 units,
//     then "…" is added (even when the text was shorter than 60).
//
// Cases (window 2026-04-21 10:00 to 20:00, Lola has unread_count 2):
//   - MASS_LONG: more than 60 characters, with double spaces and a line break: collapsed and cut at 60 UTF-16 units.
//   - MASS_SHORT: exactly 40 characters: shown whole, followed by "…".
//   - Both texts were also sent to Mario and Nora the day before, so they are mass (3 distinct chats).
//   - Lola has 5 earlier messages, all in the context block: 08:50 to 09:15.
// Why arrival order cannot make this pass by accident: the label depends on counting chats across the whole
// database, and the copies sent to Mario and Nora arrive BEFORE the context lines.
// All message times are unique. All names, numbers and texts are invented.

const MASS_LONG = 'Atención a todos:  el  consultorio\natiende de 9 a 17 hs.  Gracias por avisar con tiempo.'
const MASS_SHORT = 'Aviso: hoy no atiendo, escribime mañana.'
if ([...MASS_SHORT].length !== 40) throw new Error('MASS_SHORT must have 40 characters')

const lola = '9935141724411@s.whatsapp.net'
const mario = '9936448572259@s.whatsapp.net'
const nora = '9937467983239@s.whatsapp.net'

export default {
  description: 'Own mass messages rendered as context lines with soloNoLeidos.',
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
    { jid: lola, name: null, unread_count: 2 },
    { jid: mario, name: null, unread_count: 0 },
    { jid: nora, name: null, unread_count: 0 },
  ],
  contacts: [
    { jid: lola, name: 'Lola Vega' },
    { jid: mario, name: 'Mario Dávila' },
    { jid: nora, name: 'Nora Quiroga' },
  ],
  messages: [
    // The day before: the other two copies of each mass text
    { chat: mario, at: '2026-04-20 17:00', from_me: 1, text: MASS_LONG },
    { chat: mario, at: '2026-04-20 17:01', from_me: 1, text: MASS_SHORT },
    { chat: nora, at: '2026-04-20 17:05', from_me: 1, text: MASS_LONG },
    { chat: nora, at: '2026-04-20 17:06', from_me: 1, text: MASS_SHORT },
    // Lola: five lines of context, then two unread messages inside the window
    { chat: lola, at: '2026-04-21 08:50', read: 1, text: 'Buen día Sofi' },
    { chat: lola, at: '2026-04-21 09:00', read: 1, text: 'Hola Sofi, ¿viste mi mensaje?' },
    { chat: lola, at: '2026-04-21 09:05', from_me: 1, text: MASS_LONG },
    { chat: lola, at: '2026-04-21 09:10', from_me: 1, text: MASS_SHORT },
    { chat: lola, at: '2026-04-21 09:15', read: 1, text: 'Dale, quedo atenta' },
    { chat: lola, at: '2026-04-21 10:20', text: 'Sofi, ¿confirmás el turno de mañana?' },
    { chat: lola, at: '2026-04-21 10:25', text: 'Necesito saber antes de las 18' },
  ],
  state: {},
  llm: {
    [lola]: { resumen: 'Lola pide confirmar el turno de mañana antes de las 18.', pendientes: [], necesita_respuesta: true, prioridad: 'alta' },
  },
  runs: [{ args: ['--desde', '2026-04-21 10:00', '--hasta', '2026-04-21 20:00'] }],
}
