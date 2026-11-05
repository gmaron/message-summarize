// Rule covered: same data as 02-unsaved-flag-on.mjs, with sinAgendarEnRojo OFF.
// Unsaved chats are then treated like any other: Nico (alta, needs a reply) goes to "Necesitan respuesta",
// Anon (to-dos) to "Con pendientes" and Mati / Tienda Luz to "El resto", with no "Sin agendar" section and no
// "· N sin agendar" in the headline. Names and sender labels do not depend on the flag, so they are the same
// as in the flag ON scenario. The data is imported, not copied, so both variants cannot drift apart.
import on from './02-unsaved-flag-on.mjs'

export default {
  ...on,
  description: 'Unsaved contacts with sinAgendarEnRojo OFF (same data as the ON variant).',
  config: { ...on.config, sinAgendarEnRojo: false },
}
