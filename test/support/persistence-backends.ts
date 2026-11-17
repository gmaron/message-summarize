import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaptureRepository } from '../../src/application/ports/capture-repository.js'
import type { DigestSource } from '../../src/application/ports/digest-source.js'
import type { DigestRecord, DigestStore } from '../../src/application/ports/digest-store.js'
import type { DownloadQueue } from '../../src/application/ports/download-queue.js'
import type { TranscriptionStore } from '../../src/application/ports/transcription-store.js'
import type { Conversation, Message, Participant, UnreadState } from '../../src/domain/model.js'
import {
  type Database,
  openDatabase,
  SqliteCaptureRepository,
  SqliteCaptureWriter,
  SqliteDigestSource,
  SqliteDigestStore,
  SqliteTranscriptionStore,
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

/** What a backend holds about the download and transcription of one audio. */
export interface RawAudioRow {
  readonly status: string | null
  readonly mediaRef: string | null
  readonly error: string | null
  /** True when any of the download descriptor (path, key, mimetype, length) is still stored. */
  readonly hasDescriptor: boolean
  readonly attempts: number
}

/** A capture repository and the read port over the same data, with a controllable clock for unread stamps. */
export interface CaptureFixture {
  readonly repository: CaptureRepository
  /** The transcription queue over the same data (RF-15). */
  readonly transcription: TranscriptionStore
  /** The durable download queue over the same data (RF-15, RNF-08). */
  readonly downloads: DownloadQueue
  /** Reads the raw row of an audio: what the database really holds (the descriptor columns, the attempts...). */
  rawAudio(conversationId: string, messageId: string): RawAudioRow | null
  /** Damages the stored descriptor of a queued download (no path, no key), as a bug or a bad write could. */
  corruptDescriptor(conversationId: string, messageId: string): void
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
    return {
      repository,
      transcription: repository,
      downloads: repository,
      rawAudio: (conversationId, messageId) => {
        const media = repository.media.get(JSON.stringify([conversationId, messageId]))
        if (media === undefined) return null
        return {
          status: media.status,
          mediaRef: media.ref,
          error: media.error,
          hasDescriptor: media.descriptor !== null,
          attempts: media.attempts,
        }
      },
      corruptDescriptor: (conversationId, messageId) => {
        const key = JSON.stringify([conversationId, messageId])
        const media = repository.media.get(key)
        if (media !== undefined) repository.media.set(key, { ...media, descriptor: null })
      },
      source: repository.source,
      clock,
      close() {},
    }
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
    return {
      repository,
      transcription: new SqliteTranscriptionStore(db),
      downloads: new SqliteTranscriptionStore(db),
      rawAudio: (conversationId, messageId) => {
        const row = db
          .prepare(
            `SELECT transcribe_status AS status, media_ref AS mediaRef, transcribe_error AS error, dl_attempts AS attempts,
                    (dl_direct_path IS NOT NULL OR dl_media_key IS NOT NULL OR dl_mimetype IS NOT NULL
                     OR dl_file_length IS NOT NULL) AS hasDescriptor
             FROM messages WHERE conversation_id = ? AND id = ?`,
          )
          .get(conversationId, messageId) as
          | {
              status: string | null
              mediaRef: string | null
              error: string | null
              attempts: number
              hasDescriptor: number
            }
          | undefined
        return row === undefined ? null : { ...row, hasDescriptor: row.hasDescriptor === 1 }
      },
      corruptDescriptor: (conversationId, messageId) => {
        db.prepare(
          'UPDATE messages SET dl_direct_path = NULL, dl_media_key = NULL WHERE conversation_id = ? AND id = ?',
        ).run(conversationId, messageId)
      },
      source: new SqliteDigestSource(db),
      clock,
      close: () => temp.dispose(),
    }
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
