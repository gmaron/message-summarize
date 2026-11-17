/**
 * WhatsApp identifiers ("JIDs"), as pure functions. Everything WhatsApp-specific about ids stops here: the core only
 * sees the normalized phone-number JID ("5491100000001@s.whatsapp.net") or, when no number is known, the LID.
 */

const PHONE_SERVER = 's.whatsapp.net'

interface DecodedJid {
  readonly user: string
  readonly server: string
}

/** "user[_agent][:device]@server" into its user and server. Null when it has no "@". */
function decode(jid: string): DecodedJid | null {
  const at = jid.indexOf('@')
  if (at < 0) return null
  const user = (jid.slice(0, at).split(':')[0] ?? '').split('_')[0] ?? ''
  return { user, server: jid.slice(at + 1) }
}

/** Drops the device and agent suffixes and maps the legacy "c.us" server to "s.whatsapp.net". */
export function normalizeJid(jid: string): string {
  const decoded = decode(jid)
  if (decoded === null) return jid
  return `${decoded.user}@${decoded.server === 'c.us' ? PHONE_SERVER : decoded.server}`
}

const serverOf = (jid: string): string | null => decode(jid)?.server ?? null

/** LID: the internal id WhatsApp uses in place of a phone number. */
export const isLid = (jid: string): boolean => serverOf(jid) === 'lid'
export const isGroupJid = (jid: string): boolean => serverOf(jid) === 'g.us'
/** Status updates ("status@broadcast") and broadcast lists. */
export const isBroadcastJid = (jid: string): boolean => serverOf(jid) === 'broadcast'
export const isNewsletterJid = (jid: string): boolean => serverOf(jid) === 'newsletter'

/** What the digest shows for an individual chat with no name: "+5491100000001", or the raw id when it is no number. */
export function addressOf(jid: string): string {
  const decoded = decode(jid)
  return decoded !== null && decoded.server === PHONE_SERVER ? `+${decoded.user}` : jid
}
