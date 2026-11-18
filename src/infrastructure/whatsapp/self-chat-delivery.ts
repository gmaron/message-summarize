import type { AccountIdentity } from '../../application/ports/account-identity.js'
import type { DeliveryChannel, DeliveryFailure } from '../../application/ports/delivery-channel.js'
import { err, ok, type Result } from '../../domain/result.js'
import type { WhatsAppSocket } from './connection.js'
import { selfChatJid } from './jid.js'

/** What the adapter needs of the connection: the live socket's account and its one send method, or null. */
export interface SelfChatSource {
  selfChat(): Pick<WhatsAppSocket, 'user' | 'sendTextToSelf'> | null
}

export const DEFAULT_SEND_TIMEOUT_MS = 60_000

export interface SelfChatDeliveryOptions {
  /** A send that takes longer than this fails with `error`, so a hung send cannot freeze delivery. Default 60 s. */
  readonly sendTimeoutMs?: number
}

/**
 * RF-50, RF-51, RF-52: delivers the digest to the "message yourself" chat of the account that was LINKED to this
 * installation, and to nothing else. The port has no recipient, and neither does the socket method it calls: that
 * method derives the destination from the authenticated user of the live socket.
 *
 * Because the live socket can belong to a different phone than the one the installation was linked with (the session
 * was cleared and another QR was scanned), this adapter compares the live account against the BOUND account, which
 * is persisted (`AccountIdentity`) and does not change with the connection. Anything else is `rejected` and nothing
 * is sent. The check happens just before the send; the socket method derives the destination again from the same
 * user, and the socket's user does not change while the connection is open.
 *
 * - Not connected: `notConnected`, nothing sent; the part stays in the outbox (RF-52).
 * - No bound account, or the live account is not the bound one: `rejected`, nothing sent.
 * - Text goes as it is (the parts already have WhatsApp formatting and fit the limit). No presence, no receipts
 *   (RNF-17): the socket method does neither.
 * - A send that does not finish in `sendTimeoutMs` is `error`. The send may still complete afterwards; the part then
 *   stays queued and is sent again, so a timeout can duplicate a part but never lose one.
 *
 * "Delivered" means the message was written to the socket. It is not an acknowledgement from WhatsApp's servers: if
 * the connection drops right after the write, the part can be lost (as in the previous tool). Acknowledgements are
 * not implemented yet.
 */
export class WhatsAppSelfChatDelivery implements DeliveryChannel {
  private readonly sendTimeoutMs: number

  constructor(
    private readonly connection: SelfChatSource,
    /** The account this installation was linked with. */
    private readonly account: AccountIdentity,
    options: SelfChatDeliveryOptions = {},
  ) {
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
  }

  async deliver(text: string): Promise<Result<void, DeliveryFailure>> {
    const chat = this.connection.selfChat()
    if (chat === null) return err('notConnected')
    const bound = this.account.get()
    if (bound === null || selfChatJid(chat.user) !== bound) return err('rejected')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        chat.sendTextToSelf(text),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('send timed out')), this.sendTimeoutMs)
        }),
      ])
    } catch {
      return err('error')
    } finally {
      clearTimeout(timer)
    }
    return ok(undefined)
  }
}
