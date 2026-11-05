// Rule covered: the time window of a run and the "last summary" pointer (state last_summary_ts).
//   - Window: messages with  since <= ts < hasta  (inclusive start, exclusive end).
//   - since is --desde if given; otherwise the pointer; otherwise hasta minus horasPorDefecto (6 hours here).
//   - After a normal run the pointer becomes max(hasta, previous pointer): it never moves back, even when a
//     run summarizes an older range with --desde/--hasta in the past.
//   - --dry-run: prints the text, writes nothing to the outbox and does not move the pointer. The .md file
//     IS still written (summarize.js writes it before checking --dry-run).
//   - A run without messages prints "No hubo mensajes nuevos para resumir.", writes no digest and no outbox
//     entry, but still advances the pointer (unless it is a dry run).
//
// Runs (all on 2026-05-04, same DB; the pointer after each run is in state.json):
//   1. No pointer, no --desde, hasta 12:00: window = 06:00 to 12:00 (horasPorDefecto 6). Xavier's message at
//      exactly 06:00 is IN (inclusive start); Ana's at 05:30 is out; Yago's at exactly 12:00 is OUT (exclusive end).
//      Pointer becomes 12:00.
//   2. Normal run, hasta 15:00, no --desde: starts at the pointer 12:00. Yago (12:00 sharp) is IN now, and
//      Bea (09:00) is not repeated. Pointer becomes 15:00.
//   3. Past range with --desde 05:00 --hasta 06:00: summarizes Ana (05:30) and not Xavier (06:00, exclusive
//      end). A digest is produced, but the pointer stays at 15:00 (Math.max).
//   4. --dry-run, hasta 18:00, no --desde: starts at the pointer (15:00) and shows Dina's chat in stdout.
//      Pointer stays 15:00, the outbox gets nothing, the .md file is written.
//   5. The same run without --dry-run (same hasta 18:00): Dina is summarized again, the dry run consumed
//      nothing. Pointer 18:00.
//   6. hasta 20:00 with nothing new: "No hubo mensajes nuevos...", no digest, pointer moves to 20:00.
//   7. --dry-run with nothing new, hasta 22:00: same message, pointer stays at 20:00.
//
// Why order does not make this pass by accident: each chat has its messages in a different part of the
// timeline, so a wrong start (pointer ignored, default hours used, inclusive/exclusive swapped) pulls in or
// leaves out a different chat. Run 3 goes BACKWARDS in time after run 2, which is the only way to see the
// pointer rule. All message times are unique. All names, numbers and texts are invented.

const ana = '5491155550241@s.whatsapp.net'
const xavier = '5491155550242@s.whatsapp.net'
const bea = '5491155550243@s.whatsapp.net'
const yago = '5491155550244@s.whatsapp.net'
const carlos = '5491155550245@s.whatsapp.net'
const dina = '5491155550246@s.whatsapp.net'

export default {
  description: 'Window (inclusive start, exclusive end), pointer rules, --dry-run and an empty window, over several runs.',
  config: {
    miNombre: 'Sofía',
    horasPorDefecto: 6,
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
    { jid: xavier, name: 'Xavier', unread_count: 0 },
    { jid: bea, name: 'Bea', unread_count: 0 },
    { jid: yago, name: 'Yago', unread_count: 0 },
    { jid: carlos, name: 'Carlos', unread_count: 0 },
    { jid: dina, name: 'Dina', unread_count: 0 },
  ],
  contacts: [
    { jid: ana, name: 'Ana Gómez' },
    { jid: xavier, name: 'Xavier Roldán' },
    { jid: bea, name: 'Bea Cortés' },
    { jid: yago, name: 'Yago Sanz' },
    { jid: carlos, name: 'Carlos Díaz' },
    { jid: dina, name: 'Dina Funes' },
  ],
  messages: [
    { chat: ana, at: '2026-05-04 05:30', text: 'Buen día, ¿te llegó el paquete?' },
    { chat: xavier, at: '2026-05-04 06:00', text: 'Sofi, ¿confirmamos la visita de las 10?' },
    { chat: bea, at: '2026-05-04 09:00', text: 'Te dejo las llaves en la portería' },
    { chat: bea, at: '2026-05-04 09:10', text: 'Cualquier cosa me llamás' },
    { chat: yago, at: '2026-05-04 12:00', text: 'Sofi, ¿almorzamos hoy?' },
    { chat: carlos, at: '2026-05-04 13:30', text: 'Te mando el informe a la tarde' },
    { chat: dina, at: '2026-05-04 16:00', text: 'Sofi, ¿me pasás la factura del mes?' },
  ],
  state: {},
  llm: {
    [ana]: { resumen: 'Ana pregunta si llegó el paquete.', pendientes: [], necesita_respuesta: true, prioridad: 'media' },
    [xavier]: { resumen: 'Xavier quiere confirmar la visita de las 10.', pendientes: [], necesita_respuesta: true, prioridad: 'alta' },
    [bea]: { resumen: 'Bea dejó las llaves en la portería.', pendientes: ['Retirar las llaves de la portería'], necesita_respuesta: false, prioridad: 'media' },
    [yago]: { resumen: 'Yago invita a almorzar hoy.', pendientes: [], necesita_respuesta: true, prioridad: 'media' },
    [carlos]: { resumen: 'Carlos manda el informe a la tarde.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' },
    [dina]: { resumen: 'Dina pide la factura del mes.', pendientes: ['Enviar la factura del mes a Dina'], necesita_respuesta: true, prioridad: 'alta' },
  },
  runs: [
    { args: ['--hasta', '2026-05-04 12:00'] },
    { args: ['--hasta', '2026-05-04 15:00'] },
    { args: ['--desde', '2026-05-04 05:00', '--hasta', '2026-05-04 06:00'] },
    { args: ['--hasta', '2026-05-04 18:00', '--dry-run'] },
    { args: ['--hasta', '2026-05-04 18:00'] },
    { args: ['--hasta', '2026-05-04 20:00'] },
    { args: ['--hasta', '2026-05-04 22:00', '--dry-run'] },
  ],
}
