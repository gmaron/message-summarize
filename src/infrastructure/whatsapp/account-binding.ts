import type { AccountIdentity } from '../../application/ports/account-identity.js'
import type { WhatsAppSocket } from './connection.js'
import { selfChatJid } from './jid.js'

/**
 * - bound: nothing was bound, so the account of the socket is now the bound one (first link).
 * - matches: the socket is the bound account.
 * - mismatch: a DIFFERENT account is bound (another phone was linked). Nothing is delivered; the user must be told.
 * - noAccount: the socket has no phone-number user, so there is nothing to bind or compare.
 */
export type AccountCheck = 'bound' | 'matches' | 'mismatch' | 'noAccount'

/**
 * What the composition root does when the connection reports `connected` (RF-51): bind the account of the socket if
 * the installation has none, or check it against the bound one. Pure apart from the identity it is given.
 */
export function reconcileAccount(identity: AccountIdentity, user: WhatsAppSocket['user']): AccountCheck {
  const jid = selfChatJid(user)
  if (jid === null) return 'noAccount'
  const bound = identity.get()
  if (bound === null) return identity.bind(jid) ? 'bound' : 'mismatch'
  return bound === jid ? 'matches' : 'mismatch'
}
