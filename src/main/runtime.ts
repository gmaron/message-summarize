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
import type { DataLayout } from './paths.js'
import { buildSummarizer } from './providers.js'

export const systemClock: Clock = { now: () => Date.now() }

export interface RuntimeOptions {
  readonly layout: DataLayout
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
  readonly layout: DataLayout
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
  close(): void
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const { layout, config, env } = options
  const clock = options.clock ?? systemClock
  const now = (): number => clock.now()

  const db = openDatabase(layout.dbFile)
  try {
    const store = new SqliteDigestStore(db, now)
    const identity = new SqliteAccountIdentity(db, now)
    const repository = new SqliteCaptureRepository(new SqliteCaptureWriter(db, now))
    const renderers = createRenderers(config.language, config.timezone)

    const ownIds = new OwnConversationIds()
    const bound = identity.get()
    if (bound !== null) ownIds.set([bound])

    const capture = createCaptureMessages({
      repository,
      clock,
      excludePatterns: () => config.digest.excludePatterns,
      ownConversationIds: () => ownIds.get(),
    })

    const summarizer = options.summarizer === undefined ? buildSummarizer(config, env) : options.summarizer
    const generateDigest =
      summarizer === null
        ? null
        : createGenerateDigest({
            source: new SqliteDigestSource(db),
            summarizer,
            store,
            clock,
            renderers,
            ownConversationIds: () => ownIds.get(),
          })

    return {
      layout,
      config,
      clock,
      renderers,
      db,
      store,
      outbox: new SqliteOutboxRepository(store),
      identity,
      repository,
      capture,
      ownIds,
      generateDigest,
      close: () => db.close(),
    }
  } catch (error) {
    db.close()
    throw error
  }
}
