// Rule covered: how audio messages are rendered in the transcript sent to the LLM.
//   - kind 'audio' with a transcript renders as "🎤 (audio) <transcript>".
//   - kind 'audio' without a transcript renders as "🎤 (audio sin transcribir)".
//   - The rendering depends only on kind and transcript: the text column of an audio is ignored, and an
//     empty-string transcript counts as "no transcript" (frozen legacy behavior).
//   - The fake transcriber does nothing, so transcripts are set directly on the messages.
//
// Cases:
//   - Individual chat, audio in the middle of text messages (Lucía), with and without transcript (Mateo, Julia).
//   - Audio from me, with and without transcript (Lucía, Julia; also inside group 101).
//   - Audio of an unsaved contact (Nuevo Vecino).
//   - Empty-string transcript, multi-line transcript (newline kept as is) and an audio carrying a text
//     caption that is ignored (Valentín).
//   - Group chats: audios with and without transcript from different senders, from me, and a group made
//     only of audios (102).
//
// Why order does not make this pass by accident: every audio has a distinct transcript (or none), and the
// audios sit between text messages with different content, so a rendering that swapped, dropped or
// merged branches changes the exact line of at least one message. Rendering is per message, so there is
// no sort or grouping rule involved. All message times are unique. All names, numbers and texts are invented.

const lucia = '5491155550201@s.whatsapp.net'
const mateo = '5491155550202@s.whatsapp.net'
const julia = '5491155550203@s.whatsapp.net'
const valentin = '5491155550204@s.whatsapp.net'
const nuevo = '5491155550205@s.whatsapp.net' // not in the agenda, only a push name
const primo = '5491155550206@s.whatsapp.net' // group member, only a push name
const cumple = '120363000000000101@g.us'
const vecinos = '120363000000000102@g.us'

export default {
  description: 'Audio messages with and without transcript, in individual chats and groups, from me and from others.',
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
    { jid: lucia, name: 'Lucía', unread_count: 0 },
    { jid: mateo, name: 'Mateo', unread_count: 0 },
    { jid: julia, name: 'Julia', unread_count: 0 },
    { jid: valentin, name: 'Valentín', unread_count: 0 },
    { jid: nuevo, name: null, unread_count: 0 },
    { jid: cumple, name: 'Cumple de Tía Marta', unread_count: 0 },
    { jid: vecinos, name: 'Vecinos del 5to', unread_count: 0 },
  ],
  contacts: [
    { jid: lucia, name: 'Lucía Paredes' },
    { jid: mateo, name: 'Mateo Rinaldi' },
    { jid: julia, name: 'Julia Soto' },
    { jid: valentin, name: 'Valentín Cruz' },
    { jid: nuevo, push_name: 'Nuevo Vecino' },
    { jid: primo, push_name: 'Primo Tomás' },
  ],
  messages: [
    // Lucía: text, audio with transcript, text, my audio with transcript, text
    { chat: lucia, at: '2026-04-06 08:05', text: 'Hola Sofi, te dejo un audio porque es largo' },
    { chat: lucia, at: '2026-04-06 08:06', kind: 'audio', transcript: 'Che, te cuento que el sábado cambiamos el horario de la comida a las dos de la tarde, avisale a tu mamá.' },
    { chat: lucia, at: '2026-04-06 08:07', text: 'Después me decís si les sirve' },
    { chat: lucia, at: '2026-04-06 08:20', from_me: 1, kind: 'audio', transcript: 'Perfecto Lu, les aviso y confirmo esta noche.' },
    { chat: lucia, at: '2026-04-06 08:21', text: 'Genial, gracias!' },
    // Mateo: two audios without transcript and nothing else
    { chat: mateo, at: '2026-04-06 09:00', kind: 'audio' },
    { chat: mateo, at: '2026-04-06 09:02', kind: 'audio' },
    // Julia: text, then two audios from me (one with and one without transcript)
    { chat: julia, at: '2026-04-06 09:30', text: '¿Pudiste escuchar lo que te mandé ayer?' },
    { chat: julia, at: '2026-04-06 09:40', from_me: 1, kind: 'audio', transcript: 'Sí, lo escuché. Mañana te llamo para coordinar.' },
    { chat: julia, at: '2026-04-06 09:41', from_me: 1, kind: 'audio' },
    // Valentín: empty transcript, multi-line transcript, audio with an ignored text caption and no transcript
    { chat: valentin, at: '2026-04-06 10:00', kind: 'audio', transcript: '' },
    { chat: valentin, at: '2026-04-06 10:01', kind: 'audio', transcript: 'Primera línea del audio.\nSegunda línea después de una pausa.' },
    { chat: valentin, at: '2026-04-06 10:02', kind: 'audio', text: 'Nota de voz' },
    // Nuevo Vecino: unsaved contact with an audio
    { chat: nuevo, at: '2026-04-06 10:30', kind: 'audio', transcript: 'Hola, soy el nuevo del 4B, ¿tenés la llave del bicicletero?' },
    // Cumple de Tía Marta (group): mixed texts and audios, including mine
    { chat: cumple, at: '2026-04-06 11:00', sender: primo, text: '¿Quién se encarga de la torta?' },
    { chat: cumple, at: '2026-04-06 11:02', sender: lucia, kind: 'audio', transcript: 'Yo llevo la torta y las velitas.' },
    { chat: cumple, at: '2026-04-06 11:03', sender: mateo, kind: 'audio' },
    { chat: cumple, at: '2026-04-06 11:05', from_me: 1, text: 'Yo llevo las bebidas' },
    { chat: cumple, at: '2026-04-06 11:06', from_me: 1, kind: 'audio', transcript: 'Perdón, me olvidé de contar las sillas: necesitamos diez más.' },
    { chat: cumple, at: '2026-04-06 11:08', from_me: 1, kind: 'audio' },
    { chat: cumple, at: '2026-04-06 11:10', sender: primo, text: 'Gracias a todos' },
    // Vecinos del 5to (group): only audios from others
    { chat: vecinos, at: '2026-04-06 12:00', sender: primo, kind: 'audio', transcript: 'Mañana cortan el agua de nueve a doce, llenen los tanques.' },
    { chat: vecinos, at: '2026-04-06 12:01', sender: mateo, kind: 'audio' },
    { chat: vecinos, at: '2026-04-06 12:05', sender: lucia, kind: 'audio', transcript: 'Gracias por avisar.' },
  ],
  state: {},
  llm: {
    [lucia]: {
      resumen: 'Lucía avisa que el sábado la comida se cambia a las 14 y pide avisar a la mamá de Sofía.',
      pendientes: ['Avisar a mamá del cambio de horario', 'Confirmar a Lucía esta noche'],
      necesita_respuesta: false,
      prioridad: 'alta',
    },
    [mateo]: {
      resumen: 'Mateo mandó dos audios que no se pudieron transcribir.',
      pendientes: [],
      necesita_respuesta: true,
      prioridad: 'media',
    },
    [julia]: {
      resumen: 'Julia preguntó si Sofía escuchó su mensaje; Sofía respondió por audio que la llama mañana.',
      pendientes: ['Llamar a Julia mañana'],
      necesita_respuesta: false,
      prioridad: 'media',
    },
    [valentin]: {
      resumen: 'Valentín mandó tres audios; solo uno tiene texto.',
      pendientes: [],
      necesita_respuesta: false,
      prioridad: 'baja',
    },
    [nuevo]: {
      resumen: 'Un vecino nuevo del 4B pregunta por la llave del bicicletero.',
      pendientes: [],
      necesita_respuesta: true,
      prioridad: 'media',
    },
    [cumple]: {
      resumen: 'Lucía lleva la torta y las velitas, Sofía las bebidas y faltan diez sillas.',
      pendientes: ['Conseguir diez sillas más'],
      necesita_respuesta: false,
      prioridad: 'alta',
    },
    [vecinos]: {
      resumen: 'Corte de agua mañana de 9 a 12; hay un audio sin transcribir.',
      pendientes: [],
      necesita_respuesta: false,
      prioridad: 'baja',
    },
  },
  runs: [{ args: ['--desde', '2026-04-06 08:00', '--hasta', '2026-04-06 20:00'] }],
}
