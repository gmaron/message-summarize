import { normalizeJid } from './jid.js'

/**
 * The ids under which the owner's own chat ("message yourself") shows up: the phone-number JID and the LID. The
 * adapter fills it when it knows the account (at connect, from the stored session, and when the connection opens).
 * The composition root hands the same instance to the adapter and, through `get`, to the capture use case and to
 * GenerateDigest, so the owner's own chat is dropped at every layer (and breaks the construction cycle between the
 * adapter and the use case).
 */
export class OwnConversationIds {
  private ids: readonly string[] = []

  /** Every variant known so far, normalized. */
  get(): readonly string[] {
    return this.ids
  }

  /** Replaces the known ids (the account is the same one, so the sets only ever grow in practice). */
  set(ids: readonly (string | null | undefined)[]): void {
    this.ids = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== '').map(normalizeJid))]
  }

  has(jid: string): boolean {
    return this.ids.includes(normalizeJid(jid))
  }
}
