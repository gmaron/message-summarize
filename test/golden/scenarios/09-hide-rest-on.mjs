// Rule covered: config.ocultarResto and the splitting of the WhatsApp text into outbox parts.
//   - With ocultarResto on, the WhatsApp text replaces the "El resto" section with the line
//     "*⚪ El resto:* N chat(s) sin nada para vos" ("chat" for 1, "chats" otherwise). The .md file keeps the full detail.
//   - If "El resto" is empty, nothing is added at all, even with ocultarResto on.
//   - chunk() groups lines into parts of at most 3500 characters (JS string .length, i.e. UTF-16 code units,
//     so each emoji counts as 2). It only splits between lines: a single line longer than 3500 stays whole
//     as one oversized part. Blank lines behave in two ways:
//       a. Normal case: the blank line before a section still fits in the part, but the section title after
//          it does not, so the previous part ENDS with a trailing "\n" and the next one starts with the title.
//       b. After a full or oversized part the blank line itself does not fit; it is dropped, so no part
//          ever starts with a blank line (the blank before a section vanishes after an oversized line).
//   - This scenario shares its data with 09-hide-rest-off, which only changes ocultarResto to false.
//
// Runs (each has its own window, on the same DB):
//   1. Two chats in "El resto" (plural line) and three long summaries in "Necesitan respuesta" that do not
//      fit in one part, so the text splits between lines into several outbox parts.
//   2. One chat only, in "El resto" (singular line).
//   3. An oversized single line (4000+ characters) as the last chat of "Necesitan respuesta", followed by
//      "Con pendientes" and one chat in "El resto": the oversized line is its own part and the blank line
//      after it is swallowed.
//   4. Only chats with pendientes: no "El resto", so no hidden-rest line.
//   5. The whole text is exactly 3500 characters: a part may be exactly as long as the limit, so it stays one part.
//   6. The whole text is 3501 characters: one more character and the summary line goes to a second part.
//   7. A normal-size part (3490 chars of text) fills up right before the blank line and the "Con pendientes"
//      title: the first part ends with a trailing "\n" (case a above), so its stored length is 3491.
//
// Why order does not make this pass by accident: the hidden line comes from counting the rest section, not
// from the position of any chat, and the plural/singular/empty cases come from different windows. The long
// summaries sit in sections that stay visible in both modes, so the splitting does not depend on the rest.
// All message times are unique. All names, numbers and texts are invented.

const gabriela = '9969196545112@s.whatsapp.net'
const hernan = '9971782373273@s.whatsapp.net'
const irene = '9972545211856@s.whatsapp.net'
const joaquin = '9973251469848@s.whatsapp.net'
const karina = '9974422756947@s.whatsapp.net'
const leandro = '9974452313725@s.whatsapp.net'
const marina = '120363853183932519@g.us'
const mara = '9974855254851@s.whatsapp.net'
const nora = '9976182811728@s.whatsapp.net'
const omar = '9976632496298@s.whatsapp.net'
const pablo = '9978497698123@s.whatsapp.net'
const quique = '9978543456325@s.whatsapp.net'
const rita = '9981336538977@s.whatsapp.net'
const sergio = '9981442279162@s.whatsapp.net'
const tina = '9982217557934@s.whatsapp.net'
const ugo = '9982344849758@s.whatsapp.net'

// Invented filler text of a given minimum length, made of numbered sentences
const long = (topic, minLength) => {
  let text = ''
  for (let i = 1; text.length < minLength; i++) text += `${text ? ' ' : ''}Punto ${i} sobre ${topic}: detalle inventado de la charla.`
  return text
}

// Text of exactly `length` characters, for the boundary runs below
const LEN_RITA = 3352
const LEN_SERGIO = 3351
const LEN_TINA = 3342
const exact = (topic, length) => `${long(topic, length)}`.slice(0, length - 1) + '.'

export default {
  description: 'ocultarResto on: hidden "El resto" line (plural, singular, none) and chunk() splitting of a long digest.',
  config: {
    miNombre: 'Sofía',
    horasPorDefecto: 24,
    soloNoLeidos: false,
    maxCaracteresPorChat: 6000,
    excluir: [],
    sinAgendarEnRojo: false,
    ocultarResto: true,
    proveedor: 'ollama',
    soloLocal: [],
    whisper: { modelo: 'models/none.bin', idioma: 'es' },
  },
  prompt: `<!-- Invented test prompt: this comment must not reach the model. -->
Sos el asistente de {{nombre}}. Resumí cada conversación en español rioplatense.
Marcá si {{nombre}} tiene que responder y listá sus pendientes.
`,
  chats: [
    { jid: gabriela, name: 'Gabriela', unread_count: 0 },
    { jid: hernan, name: 'Hernán', unread_count: 0 },
    { jid: irene, name: 'Irene', unread_count: 0 },
    { jid: joaquin, name: 'Joaquín', unread_count: 0 },
    { jid: karina, name: 'Karina', unread_count: 0 },
    { jid: leandro, name: 'Leandro', unread_count: 0 },
    { jid: marina, name: 'Club de Jardinería', unread_count: 0 },
    { jid: mara, name: 'Mara', unread_count: 0 },
    { jid: nora, name: 'Nora', unread_count: 0 },
    { jid: omar, name: 'Omar', unread_count: 0 },
    { jid: pablo, name: 'Pablo', unread_count: 0 },
    { jid: quique, name: 'Quique', unread_count: 0 },
    { jid: rita, name: 'Rita', unread_count: 0 },
    { jid: sergio, name: 'Sergio', unread_count: 0 },
    { jid: tina, name: 'Tina', unread_count: 0 },
    { jid: ugo, name: 'Ugo', unread_count: 0 },
  ],
  contacts: [
    { jid: gabriela, name: 'Gabriela Núñez' },
    { jid: hernan, name: 'Hernán Vidal' },
    { jid: irene, name: 'Irene Sosa' },
    { jid: joaquin, name: 'Joaquín Bravo' },
    { jid: karina, name: 'Karina Lugo' },
    { jid: leandro, name: 'Leandro Paz' },
    { jid: mara, name: 'Mara Ledesma' },
    { jid: nora, name: 'Nora Giménez' },
    { jid: omar, name: 'Omar Ríos' },
    { jid: pablo, name: 'Pablo Duarte' },
    { jid: quique, name: 'Quique Salas' },
    { jid: rita, name: 'Rita Cano' },
    { jid: sergio, name: 'Sergio Cano' },
    { jid: tina, name: 'Tina Cano' },
    { jid: ugo, name: 'Ugo Cano' },
  ],
  messages: [
    // Run 1 (2026-04-09 08:00 to 12:00)
    { chat: gabriela, at: '2026-04-09 08:10', text: 'Sofi, necesito tu opinión sobre el contrato' },
    { chat: gabriela, at: '2026-04-09 08:12', text: '¿Podés revisarlo hoy?' },
    { chat: hernan, at: '2026-04-09 08:30', text: 'Che, ¿vas a ir a la reunión de padres?' },
    { chat: hernan, at: '2026-04-09 08:31', text: 'Avisame así reservo lugar' },
    { chat: irene, at: '2026-04-09 08:50', text: 'Sofi, ¿me prestás el taladro este finde?' },
    { chat: irene, at: '2026-04-09 08:51', text: 'Lo necesito para colgar unos estantes' },
    { chat: joaquin, at: '2026-04-09 09:10', text: 'Te paso la lista de materiales para la obra' },
    { chat: joaquin, at: '2026-04-09 09:12', text: 'Falta pintura y masilla' },
    { chat: karina, at: '2026-04-09 09:30', text: 'Acordate de traer los formularios firmados' },
    { chat: karina, at: '2026-04-09 09:31', text: 'Y la copia del DNI' },
    { chat: leandro, at: '2026-04-09 09:50', text: 'Mirá esta foto del atardecer' },
    { chat: leandro, at: '2026-04-09 09:52', text: 'Qué lindo cielo' },
    { chat: marina, at: '2026-04-09 10:10', sender: leandro, text: 'Mañana regamos los canteros' },
    { chat: marina, at: '2026-04-09 10:12', sender: leandro, text: 'Traigan guantes' },
    // Run 2 (12:00 to 14:00)
    { chat: mara, at: '2026-04-09 12:10', text: 'Feliz cumple atrasado' },
    { chat: mara, at: '2026-04-09 12:11', text: 'Que la hayas pasado genial' },
    // Run 3 (14:00 to 16:00)
    { chat: nora, at: '2026-04-09 14:10', text: 'Sofi, te mando el resumen de todo lo hablado' },
    { chat: nora, at: '2026-04-09 14:15', text: '¿Me confirmás que está bien?' },
    { chat: omar, at: '2026-04-09 14:30', text: 'Recordá renovar el seguro del auto' },
    { chat: omar, at: '2026-04-09 14:31', text: 'Vence a fin de mes' },
    { chat: pablo, at: '2026-04-09 14:50', text: 'Saludos desde la costa' },
    { chat: pablo, at: '2026-04-09 14:52', text: 'Hace mucho viento' },
    // Run 4 (16:00 to 18:00)
    { chat: quique, at: '2026-04-09 16:10', text: 'No te olvides de pasar por el correo' },
    { chat: quique, at: '2026-04-09 16:11', text: 'Hay un paquete a tu nombre' },
    // Run 5 (18:00 to 20:00) and run 6 (20:00 to 22:00): the whole text is exactly 3500 and 3501 characters
    { chat: rita, at: '2026-04-09 18:10', text: 'Sofi, ¿me llamás cuando puedas?' },
    { chat: sergio, at: '2026-04-09 20:10', text: 'Sofi, ¿me llamás cuando puedas?' },
    // Run 7 (22:00 to 00:00): a part that ends right before the blank line and the next section title
    { chat: tina, at: '2026-04-09 22:10', text: 'Sofi, ¿me llamás cuando puedas?' },
    { chat: ugo, at: '2026-04-09 22:20', text: 'Acordate de pagar la patente' },
  ],
  state: {},
  llm: {
    [gabriela]: { resumen: `Gabriela pide revisar el contrato hoy. ${long('el contrato', 1250)}`, pendientes: [], necesita_respuesta: true, prioridad: 'alta' },
    [hernan]: { resumen: `Hernán pregunta por la reunión de padres. ${long('la reunión', 1250)}`, pendientes: [], necesita_respuesta: true, prioridad: 'alta' },
    [irene]: { resumen: `Irene pide prestado el taladro. ${long('el taladro', 1250)}`, pendientes: [], necesita_respuesta: true, prioridad: 'media' },
    [joaquin]: { resumen: 'Joaquín manda la lista de materiales de la obra.', pendientes: ['Comprar pintura', 'Comprar masilla', 'Confirmar fecha de la obra'], necesita_respuesta: false, prioridad: 'media' },
    [karina]: { resumen: 'Karina recuerda llevar los formularios firmados y la copia del DNI.', pendientes: ['Llevar formularios firmados', 'Llevar copia del DNI'], necesita_respuesta: false, prioridad: 'baja' },
    [leandro]: { resumen: 'Leandro compartió una foto del atardecer.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [marina]: { resumen: 'El club de jardinería riega mañana los canteros.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [mara]: { resumen: 'Mara saluda por el cumpleaños atrasado.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [nora]: { resumen: `Nora manda un resumen y pide confirmación. ${long('el resumen', 4000)}`, pendientes: [], necesita_respuesta: true, prioridad: 'alta' },
    [omar]: { resumen: 'Omar recuerda renovar el seguro del auto antes de fin de mes.', pendientes: ['Renovar el seguro del auto'], necesita_respuesta: false, prioridad: 'media' },
    [pablo]: { resumen: 'Pablo saluda desde la costa.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [rita]: { resumen: exact('la llamada de Rita', LEN_RITA), pendientes: [], necesita_respuesta: true, prioridad: 'alta' },
    [sergio]: { resumen: exact('la llamada de Sergio', LEN_SERGIO), pendientes: [], necesita_respuesta: true, prioridad: 'alta' },
    [tina]: { resumen: exact('la llamada de Tina', LEN_TINA), pendientes: [], necesita_respuesta: true, prioridad: 'alta' },
    [ugo]: { resumen: 'Ugo recuerda pagar la patente.', pendientes: ['Pagar la patente'], necesita_respuesta: false, prioridad: 'media' },
    [quique]: { resumen: 'Quique avisa que hay un paquete en el correo.', pendientes: ['Retirar el paquete del correo'], necesita_respuesta: false, prioridad: 'media' },
  },
  runs: [
    { args: ['--desde', '2026-04-09 08:00', '--hasta', '2026-04-09 12:00'] },
    { args: ['--desde', '2026-04-09 12:00', '--hasta', '2026-04-09 14:00'] },
    { args: ['--desde', '2026-04-09 14:00', '--hasta', '2026-04-09 16:00'] },
    { args: ['--desde', '2026-04-09 16:00', '--hasta', '2026-04-09 18:00'] },
    { args: ['--desde', '2026-04-09 18:00', '--hasta', '2026-04-09 20:00'] },
    { args: ['--desde', '2026-04-09 20:00', '--hasta', '2026-04-09 22:00'] },
    { args: ['--desde', '2026-04-09 22:00', '--hasta', '2026-04-10 00:00'] },
  ],
}
