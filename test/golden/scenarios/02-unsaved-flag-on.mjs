// Rule covered: how chats are named when the contact is not in the agenda, and the sinAgendarEnRojo flag.
// This file is the flag ON variant; 02-unsaved-flag-off.mjs reuses the same data with the flag OFF.
//
// Naming (resolveChat) for individual chats:
//   - contacts.name (the agenda name) wins, even if the contact also has a push_name.
//   - otherwise the alias is push_name, then chats.name, and the result is "<alias> ( +<number> )".
//   - with no alias at all the result is just "+<number>".
//   - a masked agenda name ("+54∙∙∙∙15") is cleared when the legacy db module opens the database, so that
//     contact counts as not saved (inherited behavior, frozen on purpose).
//   - a group whose chats.name is null is shown as "Grupo sin nombre".
// Sender labels inside a group (senderLabel): agenda name or push_name, then sender_name, then "+<number>".
//
// Flag cases (sinAgendarEnRojo true):
//   - the "Sin agendar" section goes first and the headline gets "· N sin agendar";
//   - unsaved chats leave "Necesitan respuesta" (so the headline counter of chats that need a reply drops),
//     "Con pendientes" and "El resto"; inside the section they keep the priority/count sort.
//   - Nico needs a reply and Tienda Luz has prioridad baja: with the flag off they sit in "Necesitan respuesta"
//     and "El resto", so the flag visibly moves them. Anon has to-dos and Mati is alta with nothing pending.
//
// Why arrival order cannot make this pass by accident: first messages arrive as Tienda 08:10, Grupo 08:20,
// Ana 08:30, Mati 08:40, Anon 08:50, Nico 09:00. The expected "Sin agendar" order is Mati (alta, 3), Nico
// (alta, 2), Anon (media), Tienda (baja): it differs from arrival order and from the flag-off order, and the
// flag-on output is compared to the flag-off one in the sibling scenario. All message times are unique.
// All names, numbers and texts are invented.

const ana = '5491155550111@s.whatsapp.net' // saved as "Ana Gómez" and also has a push name
const nico = '5491155550112@s.whatsapp.net' // push name only, and a different chats.name
const tienda = '5491155550113@s.whatsapp.net' // no contact row, only chats.name
const anon = '5491155550114@s.whatsapp.net' // nothing at all
const mati = '5491155550115@s.whatsapp.net' // masked agenda name plus a push name
const lucho = '5491155550116@s.whatsapp.net' // group sender with only sender_name
const otro = '5491155550117@s.whatsapp.net' // group sender with nothing: shown as a phone number
const grupo = '120363000000000011@g.us' // chats.name is null

export default {
  description: 'Unsaved contacts: naming rules, group sender labels and sinAgendarEnRojo ON.',
  config: {
    miNombre: 'Sofía',
    horasPorDefecto: 24,
    soloNoLeidos: false,
    maxCaracteresPorChat: 6000,
    excluir: [],
    sinAgendarEnRojo: true,
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
    { jid: ana, name: 'Ana', unread_count: 0 },
    { jid: nico, name: 'Nicolás P.', unread_count: 0 },
    { jid: tienda, name: 'Tienda Luz', unread_count: 0 },
    { jid: anon, name: null, unread_count: 0 },
    { jid: mati, name: null, unread_count: 0 },
    { jid: grupo, name: null, unread_count: 0 },
  ],
  contacts: [
    { jid: ana, name: 'Ana Gómez', push_name: 'Anita' },
    { jid: nico, push_name: 'Nico' },
    { jid: mati, name: '+54∙∙∙∙15', push_name: 'Mati' },
  ],
  messages: [
    // Tienda Luz: unsaved, baja, nothing pending, 4 messages
    { chat: tienda, at: '2026-04-14 08:10', text: 'Hola, te escribo de Tienda Luz por tu pedido de lámparas' },
    { chat: tienda, at: '2026-04-14 08:12', text: 'Ya está listo para retirar' },
    { chat: tienda, at: '2026-04-14 08:13', text: 'Abrimos hasta las 19' },
    { chat: tienda, at: '2026-04-14 08:15', text: '¡Gracias!' },
    // Group without a name; senders: agenda name, push name (and a sender_name that must lose), sender_name, phone
    { chat: grupo, at: '2026-04-14 08:20', sender: ana, text: 'Chicos, mañana pasa el fumigador' },
    { chat: grupo, at: '2026-04-14 08:21', sender: nico, sender_name: 'Nicolás del 2B', text: 'Yo no estoy, dejo la llave en portería' },
    { chat: grupo, at: '2026-04-14 08:22', sender: lucho, sender_name: 'Lucho (Plomero)', text: 'El jueves arreglo la bomba de agua' },
    { chat: grupo, at: '2026-04-14 08:23', sender: otro, text: '¿Alguien sabe a qué hora cortan la luz?' },
    // Ana: saved, media, needs a reply
    { chat: ana, at: '2026-04-14 08:30', text: 'Sofi, ¿venís al cumple de Tomás el sábado?' },
    { chat: ana, at: '2026-04-14 08:31', text: 'Necesito saber hoy para pedir la torta' },
    { chat: ana, at: '2026-04-14 08:32', text: '¿Me avisás?' },
    // Mati: masked agenda name, alta, nothing pending, 3 messages
    { chat: mati, at: '2026-04-14 08:40', text: 'Buenas, soy Mati, el que alquila el depto del 4°' },
    { chat: mati, at: '2026-04-14 08:41', text: 'Solo te aviso que ya depositó la inmobiliaria' },
    { chat: mati, at: '2026-04-14 08:42', text: 'Cualquier cosa me escribís' },
    // Anon: no alias at all, media, has to-dos, 2 messages
    { chat: anon, at: '2026-04-14 08:50', text: 'Hola, soy del consorcio, falta que mandes la foto del DNI' },
    { chat: anon, at: '2026-04-14 08:51', text: 'La podés pasar por acá hasta el viernes' },
    // Nico: push name, alta, needs a reply, 2 messages
    { chat: nico, at: '2026-04-14 09:00', text: 'Sofi, ¿me pasás el contacto del electricista?' },
    { chat: nico, at: '2026-04-14 09:01', text: 'Es urgente, se me fue la luz' },
  ],
  state: {},
  llm: {
    [ana]: { resumen: 'Ana pregunta si Sofía va al cumpleaños de Tomás el sábado.', pendientes: [], necesita_respuesta: true, prioridad: 'media' },
    [nico]: { resumen: 'Nico pide el contacto de un electricista, con urgencia.', pendientes: [], necesita_respuesta: true, prioridad: 'alta' },
    [tienda]: { resumen: 'Tienda Luz avisa que el pedido de lámparas está listo para retirar.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [anon]: { resumen: 'Alguien del consorcio pide la foto del DNI antes del viernes.', pendientes: ['Mandar la foto del DNI al consorcio'], necesita_respuesta: false, prioridad: 'media' },
    [mati]: { resumen: 'Mati avisa que la inmobiliaria ya depositó.', pendientes: [], necesita_respuesta: false, prioridad: 'alta' },
    [grupo]: {
      resumen: 'Mañana pasa el fumigador, el jueves arreglan la bomba y preguntan por el corte de luz.',
      pendientes: ['Dejar la llave en portería si no estás'],
      necesita_respuesta: false,
      prioridad: 'media',
    },
  },
  runs: [{ args: ['--desde', '2026-04-14 08:00', '--hasta', '2026-04-14 20:00'] }],
}
