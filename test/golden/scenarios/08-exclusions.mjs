// Rule covered: chat exclusion (config.excluir).
//   - A chat is excluded when ANY pattern is a case-insensitive substring of "<jid> <resolved name>".
//   - The resolved name is what the digest would show: the agenda name for saved contacts (push name and the
//     chats table name are ignored), "<alias> ( +<number> )" for unsaved contacts, "+<number>" when there is
//     no alias at all, the chat name for groups, and "Grupo sin nombre" for a group without a name.
//   - Excluded chats never reach the LLM, so they have no entry in `llm` and nothing in the digest.
//
// Patterns and the chats they exclude:
//   - 'Gimnasio'                  by name (group "Gimnasio Fuerza").
//   - 'LAVADERO'                  case-different: matches the contact "Lavadero Express".
//   - 'CERÁMICA'                  case-different with an accent: matches the group "Taller de Cerámica".
//   - '55550203'                  jid fragment of an individual chat ("Proveedor Lima", whose name does not match).
//   - '000000000104@g.us'         jid fragment of a group ("Consorcio Norte").
//   - '+5491155550205'            unsaved contact through the number shown in its resolved name: the jid has no
//                                 "+", so this only matches the name "Nico ( +5491155550205 )".
//   - '( +5491155550207 )'        the exact format of the number inside the resolved name ("Roberto ( +... )").
//   - '+5491155550206'            unsaved contact without alias, whose whole resolved name is the number.
//   - 'ana'                       ACCIDENTAL PARTIAL MATCH, frozen legacy behavior: it excludes "Ana Ruiz", as
//                                 intended, and also "Mariana Paz" because "ana" is inside "mariana".
//   - 'sin nombre'                matches the fallback name of a group that has no row in the chats table.
//   - 'ofertas'                   does NOT exclude Camila: her push name is "Ofertas Express" but she is saved
//                                 as "Camila Ortiz", and only the resolved name counts.
//   - 'promo'                     does NOT exclude Diego: his chats.name is "Promo Diego" but he is saved as
//                                 "Diego Molina", and for a saved contact the chats table name is ignored.
// Kept chats (control): Bruno Acosta, Camila Ortiz, Diego Molina, Marcos (unsaved, other number), Familia Rey,
// Club de Lectura.
//
// Why order does not make this pass by accident: the exclusion is decided per chat from its jid and name, with
// no sorting involved. Kept and excluded chats are interleaved in time. Every pattern except the two traps
// ('ofertas', 'promo') excludes at least one chat; the controls that must be left alone are Bruno, Marcos
// (same unsaved format, other number), Familia Rey, Club de Lectura, and the traps Camila (push name) and
// Diego (chats.name). All message times are unique. All names, numbers and texts are invented.

const gimnasio = '120363000000000101@g.us'
const ceramica = '120363000000000102@g.us'
const consorcio = '120363000000000104@g.us'
const sinNombre = '120363000000000105@g.us' // no row in the chats table
const familia = '120363000000000111@g.us'
const lectura = '120363000000000112@g.us'
const lavadero = '5491155550201@s.whatsapp.net'
const proveedor = '5491155550203@s.whatsapp.net'
const nico = '5491155550205@s.whatsapp.net'
const sinAlias = '5491155550206@s.whatsapp.net'
const roberto = '5491155550207@s.whatsapp.net'
const anaRuiz = '5491155550208@s.whatsapp.net'
const mariana = '5491155550209@s.whatsapp.net'
const bruno = '5491155550211@s.whatsapp.net'
const camila = '5491155550212@s.whatsapp.net'
const marcos = '5491155550213@s.whatsapp.net'
const diego = '5491155550214@s.whatsapp.net'

export default {
  description: 'Exclusion by name, jid fragment, case, number in the resolved name, and an accidental partial match.',
  config: {
    miNombre: 'Sofía',
    horasPorDefecto: 24,
    soloNoLeidos: false,
    maxCaracteresPorChat: 6000,
    excluir: ['Gimnasio', 'LAVADERO', 'CERÁMICA', '55550203', '000000000104@g.us', '+5491155550205', '( +5491155550207 )', '+5491155550206', 'ana', 'sin nombre', 'ofertas', 'promo'],
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
    { jid: gimnasio, name: 'Gimnasio Fuerza', unread_count: 0 },
    { jid: ceramica, name: 'Taller de Cerámica', unread_count: 0 },
    { jid: consorcio, name: 'Consorcio Norte', unread_count: 0 },
    { jid: familia, name: 'Familia Rey', unread_count: 0 },
    { jid: lectura, name: 'Club de Lectura', unread_count: 0 },
    { jid: lavadero, name: 'Lavadero', unread_count: 0 },
    { jid: proveedor, name: 'Proveedor', unread_count: 0 },
    { jid: nico, name: null, unread_count: 0 },
    { jid: roberto, name: null, unread_count: 0 },
    { jid: anaRuiz, name: 'Ana', unread_count: 0 },
    { jid: mariana, name: 'Mariana', unread_count: 0 },
    { jid: bruno, name: 'Bruno', unread_count: 0 },
    { jid: camila, name: 'Camila', unread_count: 0 },
    { jid: marcos, name: null, unread_count: 0 },
    { jid: diego, name: 'Promo Diego', unread_count: 0 },
  ],
  contacts: [
    { jid: lavadero, name: 'Lavadero Express' },
    { jid: proveedor, name: 'Proveedor Lima' },
    { jid: nico, push_name: 'Nico' },
    { jid: roberto, push_name: 'Roberto' },
    { jid: anaRuiz, name: 'Ana Ruiz' },
    { jid: mariana, name: 'Mariana Paz' },
    { jid: bruno, name: 'Bruno Acosta' },
    { jid: camila, name: 'Camila Ortiz', push_name: 'Ofertas Express' },
    { jid: marcos, push_name: 'Marcos' },
    { jid: diego, name: 'Diego Molina' },
  ],
  messages: [
    { chat: bruno, at: '2026-04-07 08:00', text: 'Sofi, ¿viste el partido de anoche?' },
    { chat: lavadero, at: '2026-04-07 08:05', text: 'Tu auto está listo para retirar' },
    { chat: gimnasio, at: '2026-04-07 08:10', sender: bruno, text: 'Mañana la clase de spinning es a las 7' },
    { chat: familia, at: '2026-04-07 08:15', sender: camila, text: 'Domingo almuerzo en lo de los abuelos' },
    { chat: anaRuiz, at: '2026-04-07 08:20', text: '¿Me pasás el teléfono del plomero?' },
    { chat: mariana, at: '2026-04-07 08:25', text: 'Sofi, ¿cenamos el viernes?' },
    { chat: ceramica, at: '2026-04-07 08:30', sender: camila, text: 'El horno está disponible desde el martes' },
    { chat: camila, at: '2026-04-07 08:35', text: 'Te mando las fotos del viaje más tarde' },
    { chat: proveedor, at: '2026-04-07 08:40', text: 'El pedido llega el jueves por la mañana' },
    { chat: lectura, at: '2026-04-07 08:45', sender: bruno, text: 'Este mes leemos una novela corta' },
    { chat: nico, at: '2026-04-07 08:50', text: 'Hola, soy el que arregla la heladera' },
    { chat: consorcio, at: '2026-04-07 08:55', sender: bruno, text: 'Reunión de consorcio el miércoles' },
    { chat: marcos, at: '2026-04-07 09:00', text: 'Hola, me pasaron tu número por la mudanza' },
    { chat: roberto, at: '2026-04-07 09:05', text: 'Buenas, te escribo por la consulta del seguro' },
    { chat: sinAlias, at: '2026-04-07 09:10', text: '¿Hablo con Sofía?' },
    { chat: sinNombre, at: '2026-04-07 09:15', sender: bruno, text: 'Bienvenidos al grupo nuevo' },
    { chat: bruno, at: '2026-04-07 09:20', text: 'Dale, mañana te cuento' },
    { chat: familia, at: '2026-04-07 09:25', sender: bruno, text: 'Yo llevo el postre' },
    { chat: diego, at: '2026-04-07 09:30', text: 'Sofi, ¿tenés el cargador que te presté?' },
  ],
  state: {},
  llm: {
    [bruno]: {
      resumen: 'Bruno pregunta por el partido de anoche y quedaron en hablar mañana.',
      pendientes: [],
      necesita_respuesta: true,
      prioridad: 'media',
    },
    [camila]: {
      resumen: 'Camila va a mandar las fotos del viaje más tarde.',
      pendientes: [],
      necesita_respuesta: false,
      prioridad: 'baja',
    },
    [diego]: {
      resumen: 'Diego pregunta por el cargador que le prestó a Sofía.',
      pendientes: [],
      necesita_respuesta: true,
      prioridad: 'media',
    },
    [marcos]: {
      resumen: 'Un contacto nuevo, Marcos, escribe por la mudanza.',
      pendientes: ['Responderle a Marcos sobre la mudanza'],
      necesita_respuesta: false,
      prioridad: 'media',
    },
    [familia]: {
      resumen: 'Almuerzo el domingo en lo de los abuelos; Bruno lleva el postre.',
      pendientes: ['Confirmar asistencia al almuerzo'],
      necesita_respuesta: false,
      prioridad: 'alta',
    },
    [lectura]: {
      resumen: 'Este mes el club lee una novela corta.',
      pendientes: [],
      necesita_respuesta: false,
      prioridad: 'baja',
    },
  },
  runs: [{ args: ['--desde', '2026-04-07 07:00', '--hasta', '2026-04-07 20:00'] }],
}
