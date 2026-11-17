import type { Result } from '../../domain/result.js'

/**
 * Why a delivery failed. Fixed words, never an error message (messages can carry chat text or secrets).
 * - notConnected: the account is not connected right now. The part stays queued and is retried later (RF-52).
 * - rejected: the channel refused the destination. A channel only ever delivers to the account's own chat (RF-51).
 * - error: anything else went wrong while sending.
 */
export type DeliveryFailure = 'notConnected' | 'rejected' | 'error'

/**
 * Where the digest goes: the account's OWN chat, and nowhere else. There is deliberately no recipient parameter: the
 * adapter derives the destination from the authenticated account (RF-51), so no caller can aim it at a third party.
 */
export interface DeliveryChannel {
  /** Sends one part of a digest as it is (it already has the platform formatting and its length limit). */
  deliver(text: string): Promise<Result<void, DeliveryFailure>>
}
