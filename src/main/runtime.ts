import { type CaptureMessages, createCaptureMessages } from '../application/capture-messages.js'
import { createGenerateDigest, type GenerateDigest } from '../application/generate-digest.js'
import type { AccountIdentity } from '../application/ports/account-identity.js'
import type { CaptureRepository } from '../application/ports/capture-repository.js'
import type { Clock } from '../application/ports/clock.js'
import type { OutboxRepository } from '../application/ports/outbox.js'
import type { Renderers } from '../application/ports/rendering.js'
import type { Summarizer } from '../application/ports/summarizer.js'
import {
  type Database,
  openDatabase,
  SqliteAccountIdentity,
  SqliteCaptureRepository,
  SqliteCaptureWriter,
  SqliteDigestSource,
  SqliteDigestStore,
  SqliteOutboxRepository,
} from '../infrastructure/persistence/sqlite/index.js'
import { createRenderers } from '../infrastructure/rendering/index.js'
import { OwnConversationIds } from '../infrastructure/whatsapp/own-ids.js'
import type { AppConfig } from './config.js'
import type { AccountLayout } from './paths.js'
import { buildSummarizer } from './providers.js'

export const systemClock: Clock = { now: () => Date.now() }

export interface RuntimeOptions {
  /** The paths of the account this runtime works on. */
  readonly layout: AccountLayout
  readonly config: AppConfig
  readonly env: NodeJS.ProcessEnv
  /** The ONE clock of the process: the capture use case, the stores and the digest all read it. */
  readonly clock?: Clock
  /** Replaces the configured providers. For tests. */
  readonly summarizer?: Summarizer | null
}

/**
 * Everything that works on the account's database, wired once: the stores, the capture and digest use cases, the
 * renderers. It does NOT open a WhatsApp connection (the daemon and `link` add one on top of it), so `digest`, `status`
 * and `unlink` can use the database while the daemon owns the session.
 */
export interface Runtime {
  readonly layout: AccountLayout
  /** The configuration in force now: `reconfigure` swaps it. A digest in progress keeps the one it started with. */
  readonly config: AppConfig
  readonly clock: Clock
  readonly renderers: Renderers
  readonly db: Database
  readonly store: SqliteDigestStore
  readonly outbox: OutboxRepository
  readonly identity: AccountIdentity
  readonly repository: CaptureRepository
  readonly capture: CaptureMessages
  /** The ids of the owner's own chat: filled by the connection, and seeded from the bound account. */
  readonly ownIds: OwnConversationIds
  /** Null when no provider was chosen. */
  readonly generateDigest: GenerateDigest | null
  /**
   * Applies another configuration to the running account without touching the connection or the database: the
   * renderers (language, time zone), the summarizer and the digest use case are built again from it (the summarizer by
   * `buildSummarizer`, so the local-only router stays outermost), and capture reads the new exclusion patterns on its
   * next event. A digest already running keeps what it started with.
   */
  reconfigure(config: AppConfig): void
  close(): void
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const { layout, env } = options
  const clock = options.clock ?? systemClock
  const now = (): number => clock.now()
  let config = options.config

  const db = openDatabase(layout.dbFile)
  try {
    const store = new SqliteDigestStore(db, now)
    const identity = new SqliteAccountIdentity(db, now)
    const repository = new SqliteCaptureRepository(new SqliteCaptureWriter(db, now))
    const source = new SqliteDigestSource(db)

    const ownIds = new OwnConversationIds()
    const bound = identity.get()
    if (bound !== null) ownIds.set([bound])

    const capture = createCaptureMessages({
      repository,
      clock,
      // Read through `config` on every event: a reconfiguration applies to the next message.
      excludePatterns: () => config.digest.excludePatterns,
      ownConversationIds: () => ownIds.get(),
    })

    // A summarizer given in the options (tests) is fixed: a reconfiguration does not replace it.
    const makeParts = (settings: AppConfig): { renderers: Renderers; generateDigest: GenerateDigest | null } => {
      const renderers = createRenderers(settings.language, settings.timezone)
      const summarizer = options.summarizer === undefined ? buildSummarizer(settings, env) : options.summarizer
      return {
        renderers,
        generateDigest:
          summarizer === null
            ? null
            : createGenerateDigest({
                source,
                summarizer,
                store,
                clock,
                renderers,
                ownConversationIds: () => ownIds.get(),
              }),
      }
    }
    let parts = makeParts(config)

    return {
      layout,
      get config() {
        return config
      },
      clock,
      get renderers() {
        return parts.renderers
      },
      db,
      store,
      outbox: new SqliteOutboxRepository(store),
      identity,
      repository,
      capture,
      ownIds,
      get generateDigest() {
        return parts.generateDigest
      },
      reconfigure: (next) => {
        // Built before anything is swapped: if it throws, the runtime keeps the configuration it had.
        const rebuilt = makeParts(next)
        config = next
        parts = rebuilt
      },
      close: () => db.close(),
    }
  } catch (error) {
    db.close()
    throw error
  }
}
