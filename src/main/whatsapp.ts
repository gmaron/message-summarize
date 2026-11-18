import type { CaptureMessages } from '../application/capture-messages.js'
import type { DaemonConnection } from './daemon.js'
import type { Runtime } from './runtime.js'

/** The connection as the commands use it: the daemon's view plus deleting the stored session. */
export interface ManagedConnection extends DaemonConnection {
  /** Stops and deletes the stored session, so the account can be linked again. */
  clearSession(): Promise<void>
}

export interface ConnectionHooks {
  /** A fixed code for something that went wrong inside the adapter. Never chat content (RNF-04). */
  onWarning(code: string): void
  /** Replaces the capture use case of the runtime (`link` counts events to know when the history is in). */
  readonly capture?: CaptureMessages
}

export type ConnectionFactory = (runtime: Runtime, hooks: ConnectionHooks) => Promise<ManagedConnection>

/**
 * The real WhatsApp connection of the runtime's account. The adapter (and Baileys with it) is loaded here and only
 * when a command needs a connection, so `digest`, `status` and `doctor` start fast and never touch the network.
 */
export const createWhatsAppConnectionFor: ConnectionFactory = async (runtime, hooks) => {
  const { createWhatsAppConnection } = await import('../infrastructure/whatsapp/index.js')
  return createWhatsAppConnection({
    authDir: runtime.layout.authDir,
    language: runtime.config.language,
    capture: hooks.capture ?? runtime.capture,
    clock: runtime.clock,
    ownIds: runtime.ownIds,
    storedConversationName: async (id) => (await runtime.repository.findConversation(id))?.name,
    onWarning: hooks.onWarning,
  })
}
