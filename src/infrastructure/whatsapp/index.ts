import './console-guard.js'
import { baileysSocketFactory } from './baileys-socket.js'
import { WhatsAppConnection, type WhatsAppConnectionOptions } from './connection.js'

export { type AccountCheck, reconcileAccount } from './account-binding.js'
export { AUTH_DIR_MODE, AUTH_FILE_MODE } from './auth-state.js'
export {
  type BackoffPolicy,
  backoffDelay,
  DEFAULT_BACKOFF,
  type SocketFactory,
  type SocketSession,
  WhatsAppConnection,
  type WhatsAppConnectionOptions,
  type WhatsAppSocket,
  type WhatsAppStatus,
  type WhatsAppStatusListener,
} from './connection.js'
export { OwnConversationIds } from './own-ids.js'
export {
  DEFAULT_SEND_TIMEOUT_MS,
  type SelfChatDeliveryOptions,
  type SelfChatSource,
  WhatsAppSelfChatDelivery,
} from './self-chat-delivery.js'

/**
 * The WhatsApp adapter of one account, on Baileys. Everything else (the capture use case, the clock, the own-chat ids)
 * comes from the composition root; the socket factory defaults to the real one.
 */
export function createWhatsAppConnection(
  options: Omit<WhatsAppConnectionOptions, 'socketFactory'> & Partial<Pick<WhatsAppConnectionOptions, 'socketFactory'>>,
): WhatsAppConnection {
  return new WhatsAppConnection({ socketFactory: baileysSocketFactory, ...options })
}
