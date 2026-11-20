// Rule covered: sections and ordering of the digest.
//   - Results are sorted by prioridad (alta, media, baja), then by message count, descending.
//   - They are split into: "Necesitan respuesta" (necesita_respuesta), "Con pendientes" (pendientes
//     not empty and no reply needed) and "El resto" (everything else).
//   - With sinAgendarEnRojo, ocultarResto and soloNoLeidos all off, nothing is hidden or promoted.
//
// Ordering cases. The legacy tool reads messages ordered by time, so chats start out in the order of
// their first message. Each pair below has its first messages in the OPPOSITE order to the expected
// result, so removing the sort or its count tie-break changes the output:
//   - Same priority, different counts: Edificio Torre Sur (alta, 6) before Luis Ferreyra (alta, 4).
//   - Priority beats count in "Necesitan respuesta": Rosa (alta, 5) and Ana (alta, 3) before Marta (media, 6);
//     Rosa before Ana is also a same-priority count case.
//   - Priority beats count in "El resto": Club de Ajedrez (media, 5) before Carlos (baja, 7).
//   - Rosa needs a reply and also has to-dos: she appears only in "Necesitan respuesta", with her items.
// First-message order: Marta 08:10, Ana 08:30, Rosa 08:50, Luis 09:00, Torre 09:30, Carlos 10:00, Ajedrez 10:30.
// All message times are unique. All names, numbers and texts are invented.

const ana = '9923967495227@s.whatsapp.net'
const luis = '9924915839685@s.whatsapp.net'
const marta = '9925826569519@s.whatsapp.net'
const carlos = '9926162235251@s.whatsapp.net'
const rosa = '9926335321926@s.whatsapp.net'
const torre = '120363146125332922@g.us'
const ajedrez = '120363278292219878@g.us'
const vecina = '9926289778392@s.whatsapp.net' // group member who is not in the agenda, only a push name

export default {
  description: 'Sections (needs reply / to-dos / rest) and sorting by priority then message count.',
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
    { jid: ana, name: 'Ana', unread_count: 0 },
    { jid: luis, name: 'Luis', unread_count: 0 },
    { jid: marta, name: 'Marta', unread_count: 0 },
    { jid: carlos, name: 'Carlos', unread_count: 0 },
    { jid: rosa, name: 'Rosa', unread_count: 0 },
    { jid: torre, name: 'Edificio Torre Sur', unread_count: 0 },
    { jid: ajedrez, name: 'Club de Ajedrez', unread_count: 0 },
  ],
  contacts: [
    { jid: ana, name: 'Ana Gómez' },
    { jid: luis, name: 'Luis Ferreyra' },
    { jid: marta, name: 'Marta Ibáñez' },
    { jid: carlos, name: 'Carlos Díaz' },
    { jid: rosa, name: 'Rosa Molina' },
    { jid: vecina, push_name: 'Vecina del 3B' },
  ],
  messages: [
    // Marta: media, needs reply, 6 messages (more than Ana and Rosa, who are alta)
    { chat: marta, at: '2026-03-10 08:10', text: '¿Cenamos el jueves?' },
    { chat: marta, at: '2026-03-10 08:12', text: 'Yo propongo ese lugar de pastas de siempre' },
    { chat: marta, at: '2026-03-10 08:15', text: 'Reservo para las 21' },
    { chat: marta, at: '2026-03-10 08:16', text: 'Puede venir también mi hermano' },
    { chat: marta, at: '2026-03-10 08:20', text: '¿Te queda bien?' },
    { chat: marta, at: '2026-03-10 08:25', text: 'Avisame cuando puedas' },
    // Ana: alta, needs reply, 3 messages
    { chat: ana, at: '2026-03-10 08:30', text: 'Hola Sofi, ¿pudiste ver el presupuesto del catering?' },
    { chat: ana, at: '2026-03-10 08:31', text: 'Lo necesito hoy para confirmar con el salón' },
    { chat: ana, at: '2026-03-10 08:45', text: '¿Me avisás cuando puedas?' },
    // Rosa: alta, needs reply AND has to-dos, 5 messages
    { chat: rosa, at: '2026-03-10 08:50', text: 'Sofi, ¿confirmás la reunión del lunes?' },
    { chat: rosa, at: '2026-03-10 08:51', text: 'Necesito saber hoy cuántos van a ser' },
    { chat: rosa, at: '2026-03-10 08:55', from_me: 1, text: 'Creo que sí, te confirmo más tarde' },
    { chat: rosa, at: '2026-03-10 08:58', text: 'Dale. Mandame también la agenda' },
    { chat: rosa, at: '2026-03-10 09:20', text: 'Y avisame si traés el proyector' },
    // Luis: alta, to-dos, 4 messages
    { chat: luis, at: '2026-03-10 09:00', text: 'Sofi, te paso el contrato revisado' },
    { chat: luis, at: '2026-03-10 09:01', text: 'Falta tu firma en la página 3' },
    { chat: luis, at: '2026-03-10 09:10', from_me: 1, text: 'Genial, lo firmo y te lo devuelvo' },
    { chat: luis, at: '2026-03-10 09:15', text: 'Perfecto, quedo atento' },
    // Edificio Torre Sur: alta, to-dos, 6 messages (group)
    { chat: torre, at: '2026-03-10 09:30', sender: vecina, text: 'Buen día, mañana cortan el agua de 9 a 12' },
    { chat: torre, at: '2026-03-10 09:35', sender: luis, text: 'Gracias por avisar' },
    { chat: torre, at: '2026-03-10 09:40', sender: vecina, text: 'Recuerden pagar las expensas antes del viernes' },
    { chat: torre, at: '2026-03-10 09:45', from_me: 1, text: 'Ok, las pago el jueves' },
    { chat: torre, at: '2026-03-10 09:50', sender: vecina, text: 'La asamblea es el sábado a las 18 en el SUM' },
    { chat: torre, at: '2026-03-10 09:52', sender: vecina, text: 'Hay que confirmar asistencia' },
    // Carlos: baja, rest, 7 messages (more than Club de Ajedrez, which is media)
    { chat: carlos, at: '2026-03-10 10:00', text: 'Mirá este meme' },
    { chat: carlos, at: '2026-03-10 10:01', text: 'Jajaja' },
    { chat: carlos, at: '2026-03-10 10:05', text: 'Y este otro' },
    { chat: carlos, at: '2026-03-10 10:06', text: 'El gato del vecino otra vez' },
    { chat: carlos, at: '2026-03-10 10:10', text: 'Mañana te cuento algo' },
    { chat: carlos, at: '2026-03-10 10:20', text: 'Nada importante' },
    { chat: carlos, at: '2026-03-10 10:25', text: 'Buen finde si no hablamos' },
    // Club de Ajedrez: media, rest, 5 messages (group)
    { chat: ajedrez, at: '2026-03-10 10:30', sender: carlos, text: 'Resultados del torneo: ganó Pedro' },
    { chat: ajedrez, at: '2026-03-10 10:31', sender: carlos, text: 'Fue una final muy reñida' },
    { chat: ajedrez, at: '2026-03-10 10:35', sender: luis, text: 'Felicitaciones Pedro' },
    { chat: ajedrez, at: '2026-03-10 10:36', sender: ana, text: 'Bien ahí' },
    { chat: ajedrez, at: '2026-03-10 10:40', sender: carlos, text: 'Las fotos las subimos mañana' },
  ],
  state: {},
  llm: {
    [ana]: {
      resumen: 'Ana pide el presupuesto del catering hoy para confirmar el salón.',
      pendientes: [],
      necesita_respuesta: true,
      prioridad: 'alta',
    },
    [rosa]: {
      resumen: 'Rosa pide confirmar la reunión del lunes, la agenda y si Sofía lleva el proyector.',
      pendientes: ['Confirmar la reunión del lunes y cuántos van', 'Mandar la agenda a Rosa'],
      necesita_respuesta: true,
      prioridad: 'alta',
    },
    [torre]: {
      resumen: 'Corte de agua mañana de 9 a 12 y asamblea el sábado a las 18.',
      pendientes: ['Pagar las expensas antes del viernes', 'Confirmar asistencia a la asamblea'],
      necesita_respuesta: false,
      prioridad: 'alta',
    },
    [luis]: {
      resumen: 'Luis envió el contrato revisado; falta la firma de Sofía en la página 3.',
      pendientes: ['Firmar el contrato y devolverlo a Luis'],
      necesita_respuesta: false,
      prioridad: 'alta',
    },
    [marta]: {
      resumen: 'Marta propone cenar el jueves en el lugar de pastas.',
      pendientes: [],
      necesita_respuesta: true,
      prioridad: 'media',
    },
    [ajedrez]: {
      resumen: 'Pedro ganó el torneo; las fotos se suben mañana.',
      pendientes: [],
      necesita_respuesta: false,
      prioridad: 'media',
    },
    [carlos]: {
      resumen: 'Carlos mandó memes y se despidió hasta el fin de semana.',
      pendientes: [],
      necesita_respuesta: false,
      prioridad: 'baja',
    },
  },
  runs: [{ args: ['--desde', '2026-03-10 08:00', '--hasta', '2026-03-10 20:00'] }],
}
