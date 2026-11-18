// Rule covered: config.ocultarResto off. Same data and runs as 09-hide-rest-on (imported, not copied), with
// ocultarResto false: the WhatsApp text keeps the full "El resto" section, and the digest splits into
// outbox parts the same way. Comparing both folders shows exactly what the option changes: only the
// "El resto" section of the WhatsApp text. With this data the cut points are the same in both modes (the
// rest section is always last, so it never changes where earlier parts end); the .md file is identical.
import on from './09-hide-rest-on.mjs'

export default {
  ...on,
  description: 'ocultarResto off: same data as 09-hide-rest-on, full "El resto" section in the WhatsApp text.',
  config: { ...on.config, ocultarResto: false },
}
