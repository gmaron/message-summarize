import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaptureRepository } from '../../src/application/ports/capture-repository.js'
import type { DigestSource } from '../../src/application/ports/digest-source.js'
import type { DigestRecord, DigestStore } from '../../src/application/ports/digest-store.js'
import type { Conversation, Message, Participant, UnreadState } from '../../src/domain/model.js'
import {
  type Database,
  openDatabase,
  SqliteCaptureRepository,
  SqliteCaptureWriter,
  SqliteDigestSource,
  SqliteDigestStore,
} from '../../src/infrastructure/persistence/sqlite/index.js'
import { InMemorySource, InMemoryStore } from './application-fakes.js'
import { InMemoryCaptureRepository } from './capture-fakes.js'

/**
 * The ways to build the DigestSource and DigestStore ports in tests: in memory and on SQLite. The contract suites and
 * the golden harness run against every backend, so a fake cannot be more lenient than the real adapter.
 */

/** How a test puts data into a source. Every backend has its own way, behind this one interface. */
export interface SourceSeed {
  addConversation(conversation: Conversation): void
  /** Declares a conversation id as a group, for chats added without metadata. */
  markGroup(id: string): void
  addMessages(...messages: Message[]): void
  addParticipant(participant: Participant): void
  setUnread(conversationId: string, state: UnreadState): void
}

export interface SourceFixture {
  readonly seed: SourceSeed
  readonly source: DigestSource
  close(): void
}

export interface StoreFixture {
  readonly store: DigestStore
  /** What the store holds. */
  pointer(): Promise<number | null>
  history(): DigestRecord[]
  /** Text of every part enqueued, in order. */
  outbox(): string[]
  close(): void
}

/** A capture repository and the read port over the same data, with a controllable clock for unread stamps. */
export interface CaptureFixture {
  readonly repository: CaptureRepository
  readonly source: DigestSource
  readonly clock: { time: number }
  close(): void
}

export interface PersistenceBackend {
  readonly name: string
  capture(): CaptureFixture
  source(): SourceFixture
  /** A store whose pointer already is `pointer` (null: none). */
  store(pointer?: number | null): Promise<StoreFixture>
}

export const inMemoryBackend: PersistenceBackend = {
  name: 'in-memory',
  capture() {
    const clock = { time: 1_000 }
    const repository = new InMemoryCaptureRepository(() => clock.time)
    return { repository, source: repository.source, clock, close() {} }
  },
  source() {
    const source = new InMemorySource()
    return { seed: source, source, close() {} }
  },
  async store(pointer = null) {
    const store = new InMemoryStore(pointer)
    return {
      store,
      pointer: async () => store.pointer,
      history: () => store.history,
      outbox: () => store.outbox,
      close() {},
    }
  },
}

/** A database file in a fresh temporary directory, removed by `dispose`. */
export class TempDatabase {
  readonly dir = mkdtempSync(join(tmpdir(), 'message-summarize-test-'))
  readonly path = join(this.dir, 'account.db')
  private readonly opened: Database[] = []

  open(): Database {
    const db = openDatabase(this.path)
    this.opened.push(db)
    return db
  }

  dispose(): void {
    for (const db of this.opened) {
      try {
        db.close()
      } catch {
        // already closed by the test
      }
    }
    rmSync(this.dir, { recursive: true, force: true })
  }
}

class SqliteSeed implements SourceSeed {
  private readonly groups = new Set<string>()
  constructor(private readonly writer: SqliteCaptureWriter) {}
  addConversation(conversation: Conversation): void {
    this.writer.upsertConversation(conversation)
  }
  /** Like the in-memory source: only a chat with no row of its own is affected, through the stub path of the writer. */
  markGroup(id: string): void {
    this.groups.add(id)
  }
  addMessages(...messages: Message[]): void {
    for (const message of messages) {
      this.writer.insertMessage(message, { isGroup: this.groups.has(message.conversationId) })
    }
  }
  addParticipant(participant: Participant): void {
    this.writer.upsertParticipant(participant)
  }
  setUnread(conversationId: string, state: UnreadState): void {
    this.writer.setUnread(conversationId, state, { isGroup: this.groups.has(conversationId) })
  }
}

export const sqliteBackend: PersistenceBackend = {
  name: 'sqlite',
  capture() {
    const temp = new TempDatabase()
    const db = temp.open()
    const clock = { time: 1_000 }
    const repository = new SqliteCaptureRepository(new SqliteCaptureWriter(db, () => clock.time))
    return { repository, source: new SqliteDigestSource(db), clock, close: () => temp.dispose() }
  },
  source() {
    const temp = new TempDatabase()
    const db = temp.open()
    return {
      seed: new SqliteSeed(new SqliteCaptureWriter(db)),
      source: new SqliteDigestSource(db),
      close: () => temp.dispose(),
    }
  },
  async store(pointer = null) {
    const temp = new TempDatabase()
    const store = new SqliteDigestStore(temp.open())
    if (pointer !== null) {
      // Seed the pointer through the port itself.
      await store.commit({ previousPointer: null, pointer, digest: null, parts: [] })
    }
    return {
      store,
      pointer: () => store.getPointer(),
      history: () => store.history(),
      outbox: () => store.outbox().map((e) => e.text),
      close: () => temp.dispose(),
    }
  },
}

export const backends: readonly PersistenceBackend[] = [inMemoryBackend, sqliteBackend]
