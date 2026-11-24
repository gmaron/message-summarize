import type { Database } from './database.js'
import { inTransaction } from './transaction.js'

/**
 * A schema change. `version` starts at 1 and goes up by one. A migration is never edited after a release: a change
 * is a new migration (RNF-16).
 */
export interface Migration {
  readonly version: number
  readonly description: string
  readonly sql: string
  /**
   * Set to false for a migration that rebuilds tables (it needs foreign keys off). The runner turns them off before
   * the transaction, runs `PRAGMA foreign_key_check` before the commit (any violation fails and rolls back) and turns
   * them on again after. Default: true.
   */
  readonly foreignKeys?: boolean
}

/** Migration 1: everything the digest needs and what capture writes. See the notes on each table. */
const SCHEMA_V1 = `
-- Chats. A message cannot exist without its row (foreign key on messages), so "messages with no metadata" cannot
-- happen: the capture-side writer creates a stub row (no name, individual chat, address = id) when it needs one.
-- unread_kind/unread_count are the UnreadState of the domain: unknown | markedUnread | count(n).
CREATE TABLE conversations (
  id             TEXT PRIMARY KEY,
  is_group       INTEGER NOT NULL DEFAULT 0 CHECK (is_group IN (0, 1)),
  name           TEXT,
  participant_id TEXT,
  address        TEXT NOT NULL,
  unread_kind    TEXT NOT NULL DEFAULT 'unknown' CHECK (unread_kind IN ('unknown', 'markedUnread', 'count')),
  unread_count   INTEGER CHECK (unread_count IS NULL OR unread_count >= 0),
  -- When the unread state was last set (epoch ms). A live update stamps its own time, a snapshot stamps the time
  -- the snapshot started, so a snapshot never overwrites something newer (RF-12).
  unread_updated_at INTEGER,
  CHECK ((unread_kind = 'count') = (unread_count IS NOT NULL))
);

-- People. No foreign key points here: a sender or an individual chat may refer to someone the platform never
-- described, and the digest copes with that (the id is absent from the participants map).
CREATE TABLE participants (
  id           TEXT PRIMARY KEY,
  saved_name   TEXT,
  public_name  TEXT
);

-- Messages. seq is insertion order and breaks ties between equal timestamps: it never changes for a message (an
-- upsert keeps it). The kind is validated by the writer against the domain list, so a new kind needs no migration.
CREATE TABLE messages (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  id              TEXT NOT NULL,
  sender_id       TEXT,
  sender_name     TEXT,
  sender_address  TEXT,
  from_me         INTEGER NOT NULL CHECK (from_me IN (0, 1)),
  timestamp       INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  text            TEXT,
  transcript      TEXT,
  read            INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
  edited_at       INTEGER,
  UNIQUE (conversation_id, id)
);
-- Which chats have messages in a window: a covering scan of the window, no table access (RNF-11).
CREATE INDEX messages_by_time ON messages (timestamp, conversation_id);
-- Messages of one chat in a window, and the context before a timestamp.
CREATE INDEX messages_by_conversation_time ON messages (conversation_id, timestamp);
-- The last incoming messages of a chat (unread tail).
CREATE INDEX messages_incoming ON messages (conversation_id, timestamp) WHERE from_me = 0;
-- Own messages of the whole history (mass-message detection).
CREATE INDEX messages_own ON messages (conversation_id) WHERE from_me = 1;

-- End of the previous digest. One row at most.
CREATE TABLE digest_pointer (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  pointer INTEGER NOT NULL
);

-- Every digest generated, complete (RF-36).
CREATE TABLE digests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  since      INTEGER NOT NULL,
  until      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  text       TEXT NOT NULL,
  summarized INTEGER NOT NULL,
  failed     INTEGER NOT NULL
);

-- Parts waiting for delivery (RF-52). sent_at is null until delivered. Order of delivery is id order.
-- digest_id: the digest the part belongs to (null for a part with no digest).
CREATE TABLE outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  digest_id  INTEGER REFERENCES digests (id),
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX outbox_pending ON outbox (id) WHERE sent_at IS NULL;
`

/**
 * Migration 2: the account this database belongs to (RF-51). One row at most: the phone-number identifier of the
 * account that was linked first. The digest is only ever delivered to it, even if another phone is linked later.
 */
const SCHEMA_V2 = `
CREATE TABLE account (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  jid       TEXT NOT NULL CHECK (jid <> ''),
  linked_at INTEGER NOT NULL
);
`

/**
 * Migration 3: one row per digest run (RF-74), including the ones that failed or had nothing to summarize.
 * The row is opened when the run starts (finished_at and outcome null) and closed when it ends, so a crash leaves an
 * open row that the daemon marks as failed with error 'interrupted' on its next start. `providers` is JSON
 * ({"claude-cli": 12, "ollama": 2}); `failed_conversations` is JSON ([{id, name, reason}]) and holds chat names:
 * private data that lives in the account's database only. `digest_id` is set in the same transaction that saves the
 * digest, so a committed digest always has its run.
 * (This number was released with the digest history: the audio transcription that came after it is migration 4.)
 */
const SCHEMA_V3 = `
CREATE TABLE digest_runs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_kind         TEXT NOT NULL CHECK (trigger_kind IN ('schedule', 'missed', 'manual', 'cli')),
  started_at           INTEGER NOT NULL,
  finished_at          INTEGER,
  outcome              TEXT CHECK (outcome IS NULL OR outcome IN ('committed', 'empty', 'failed')),
  error                TEXT,
  summarized           INTEGER NOT NULL DEFAULT 0,
  failed               INTEGER NOT NULL DEFAULT 0,
  providers            TEXT NOT NULL DEFAULT '{}',
  failed_conversations TEXT NOT NULL DEFAULT '[]',
  digest_id            INTEGER REFERENCES digests (id) ON DELETE SET NULL,
  since                INTEGER,
  until                INTEGER,
  CHECK ((finished_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX digest_runs_by_start ON digest_runs (started_at);
`

/**
 * Migration 4: audio download and transcription (RF-15, RF-20), as TWO durable queues on the messages table (so nothing
 * received is lost to a restart, RNF-08). All null for a message that has no audio to handle:
 * - transcribe_status: 'download_pending' (capture stored how to download the file; the download worker takes it),
 *   'pending' (file stored, waiting for its transcript), 'done' (transcript stored) or 'failed' (the download or the
 *   transcription failed for good: see transcribe_error). Null: nothing was asked.
 * - media_ref: the file of the audio, relative to the account's media directory (never an absolute path, so the data
 *   directory can move).
 * - transcribe_error: a short internal reason for a failure. Never shown in a digest.
 * - dl_*: the DOWNLOAD DESCRIPTOR, only while the status is 'download_pending'. `dl_media_key` is the decryption key of
 *   that one file: a secret, kept only in this database (0600) and never logged or printed. All of dl_* is cleared (NULL)
 *   as soon as the file is stored or the download failed for good. `dl_attempts` counts the transient failures and
 *   `dl_next_attempt_at` says when the next try is due (backoff).
 * The transcript itself is the `transcript` column of migration 1.
 */
const SCHEMA_V4 = `
ALTER TABLE messages ADD COLUMN media_ref TEXT;
ALTER TABLE messages ADD COLUMN transcribe_status TEXT
  CHECK (transcribe_status IN ('download_pending', 'pending', 'done', 'failed'));
ALTER TABLE messages ADD COLUMN transcribe_error TEXT;
ALTER TABLE messages ADD COLUMN dl_direct_path TEXT;
ALTER TABLE messages ADD COLUMN dl_media_key BLOB;
ALTER TABLE messages ADD COLUMN dl_mimetype TEXT;
ALTER TABLE messages ADD COLUMN dl_file_length INTEGER;
ALTER TABLE messages ADD COLUMN dl_attempts INTEGER NOT NULL DEFAULT 0;
-- When a download that failed for a moment may be tried again (epoch ms, exponential backoff). Null: due now.
ALTER TABLE messages ADD COLUMN dl_next_attempt_at INTEGER;
-- The transcription queue, oldest first: only the audios that wait.
CREATE INDEX messages_pending_audio ON messages (timestamp, seq) WHERE transcribe_status = 'pending';
-- The download queue, oldest first.
CREATE INDEX messages_download_queue ON messages (timestamp, seq) WHERE transcribe_status = 'download_pending';
`

/**
 * Migration 5: everything a message carries beyond its text, kept for rules built later ("parametría") over every type
 * of message. NON-DESTRUCTIVE and fast: only ADD COLUMN (constant defaults, so no table rewrite) and new tables; rows
 * already stored keep NULL / 0 (they have no raw content to read these from).
 * - `raw`: the decoded content of the message as JSON text (media descriptors kept, binary noise and keys dropped). It is
 *   the safety net: whatever the typed columns miss can be read from it later.
 * - `quoted_*`: what the message replies to (`quoted_from_status` 1: a reply to a status). `forwarded`, `is_view_once`: 0/1.
 * - Side tables, one per kind of content, tied to the message by `seq` (they go with it when it is deleted).
 * - `reactions` and `poll_votes` are not messages: they point at the target message by its platform id and are tied to
 *   the conversation (deleted with it, see `SqliteConversationPurge`).
 */
const SCHEMA_V5 = `
ALTER TABLE messages ADD COLUMN raw TEXT;
ALTER TABLE messages ADD COLUMN quoted_id TEXT;
ALTER TABLE messages ADD COLUMN quoted_kind TEXT;
ALTER TABLE messages ADD COLUMN quoted_text TEXT;
ALTER TABLE messages ADD COLUMN quoted_from_status INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN is_view_once INTEGER NOT NULL DEFAULT 0;

CREATE TABLE media (
  message_seq INTEGER PRIMARY KEY REFERENCES messages (seq) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document', 'sticker')),
  mimetype    TEXT,
  seconds     INTEGER,
  file_length INTEGER,
  file_name   TEXT,
  page_count  INTEGER,
  width       INTEGER,
  height      INTEGER,
  caption     TEXT
);
CREATE INDEX media_by_kind ON media (kind);

CREATE TABLE locations (
  message_seq INTEGER PRIMARY KEY REFERENCES messages (seq) ON DELETE CASCADE,
  lat         REAL,
  lng         REAL,
  name        TEXT,
  address     TEXT,
  live        INTEGER NOT NULL DEFAULT 0 CHECK (live IN (0, 1))
);

-- One row per shared contact (a contactsArrayMessage has several). phones: JSON array of the numbers of the vCard.
CREATE TABLE shared_contacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_seq  INTEGER NOT NULL REFERENCES messages (seq) ON DELETE CASCADE,
  display_name TEXT,
  phone        TEXT,
  phones       TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX shared_contacts_by_message ON shared_contacts (message_seq);

CREATE TABLE polls (
  message_seq      INTEGER PRIMARY KEY REFERENCES messages (seq) ON DELETE CASCADE,
  question         TEXT,
  options          TEXT NOT NULL DEFAULT '[]',
  selectable_count INTEGER
);

-- Votes arrive encrypted (the key is the poll's own secret): stored as received. TODO: decrypt them with the poll's
-- messageSecret when a rule needs the results; the raw payload is kept so nothing is lost until then.
CREATE TABLE poll_votes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  poll_id         TEXT NOT NULL,
  sender_id       TEXT NOT NULL DEFAULT '',
  from_me         INTEGER NOT NULL CHECK (from_me IN (0, 1)),
  timestamp       INTEGER NOT NULL,
  raw             TEXT NOT NULL,
  UNIQUE (conversation_id, poll_id, from_me, sender_id, timestamp)
);

-- WhatsApp Business: an order (orderMessage) and a product (productMessage). Amounts in currency units.
CREATE TABLE orders (
  message_seq  INTEGER PRIMARY KEY REFERENCES messages (seq) ON DELETE CASCADE,
  order_id     TEXT,
  item_count   INTEGER,
  total_amount REAL,
  currency     TEXT,
  title        TEXT,
  message      TEXT
);
CREATE TABLE products (
  message_seq INTEGER PRIMARY KEY REFERENCES messages (seq) ON DELETE CASCADE,
  product_id  TEXT,
  title       TEXT,
  price       REAL,
  currency    TEXT,
  retailer_id TEXT
);

-- One reaction per sender and target message (a newer one replaces it; removing it deletes the row).
-- sender_id is '' for the owner's own reactions (from_me = 1).
CREATE TABLE reactions (
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  target_id       TEXT NOT NULL,
  from_me         INTEGER NOT NULL CHECK (from_me IN (0, 1)),
  sender_id       TEXT NOT NULL DEFAULT '',
  emoji           TEXT NOT NULL,
  timestamp       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, target_id, from_me, sender_id)
);
`

/**
 * Migration 6 (audio queue for a full history): claims for a pool of transcribers, and what it takes to ask the phone
 * - transcribe_claimed_at: set (epoch ms) while a worker transcribes the audio. Reset to NULL at every start, so an audio
 *   that was in progress when the process died is pending again. Only meaningful while transcribe_status is 'pending'.
 * - dl_remote_jid, dl_from_me, dl_participant: the key of the message as the platform wrote it, kept with the download
 *   descriptor (cleared with it). Asking the phone to upload a media again needs the whole key. Not secrets.
 * - dl_reupload_attempts: how many times the phone was asked to upload this media again (bounded).
 * - dl_needs_reupload: 1 while the row waits for the phone to answer that request (it is not downloadable until then).
 */
const SCHEMA_V6 = `
ALTER TABLE messages ADD COLUMN transcribe_claimed_at INTEGER;
ALTER TABLE messages ADD COLUMN dl_remote_jid TEXT;
ALTER TABLE messages ADD COLUMN dl_from_me INTEGER;
ALTER TABLE messages ADD COLUMN dl_participant TEXT;
ALTER TABLE messages ADD COLUMN dl_reupload_attempts INTEGER NOT NULL DEFAULT 0;
-- 1 while the server no longer has the media and the phone was asked to upload it again (the row waits for that).
ALTER TABLE messages ADD COLUMN dl_needs_reupload INTEGER NOT NULL DEFAULT 0;
-- Counts of the audio queues (the progress log) without reading the table.
CREATE INDEX messages_by_transcribe_status ON messages (transcribe_status) WHERE transcribe_status IS NOT NULL;
`

/**
 * Migration 7 (the "Ask" history): the requests of the owner and their answers, so they survive a restart. The text of the
 * question and of the answer is private chat-derived data: it lives only in this table (never in a log or an event), and
 * the program keeps the latest 50 (`SqliteAskHistory`).
 * - state: running while the answer is being written; a request found running after a restart ended with the process.
 * - selection / period: what was asked of which messages and over which period (the window is `since`..`until`).
 * - chats: the filter of the request, a JSON list of patterns.
 * - deliver / outbox_id: whether the answer was queued for the owner's own chat, and the id of the LAST part queued (the
 *   request is delivered when that part is marked sent in the outbox).
 * - result: the report as JSON (answer, provider, counts). error: a fixed code, never a message.
 */
const SCHEMA_V7 = `
CREATE TABLE asks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER,
  state       TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed')),
  question    TEXT NOT NULL,
  selection   TEXT NOT NULL,
  period      TEXT NOT NULL,
  since       INTEGER NOT NULL,
  until       INTEGER NOT NULL,
  chats       TEXT NOT NULL,
  deliver     INTEGER NOT NULL,
  outbox_id   INTEGER,
  result      TEXT,
  error       TEXT
);
`

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, description: 'Initial schema', sql: SCHEMA_V1 },
  { version: 2, description: 'Account identity', sql: SCHEMA_V2 },
  { version: 3, description: 'Digest runs', sql: SCHEMA_V3 },
  { version: 4, description: 'Audio transcription', sql: SCHEMA_V4 },
  { version: 5, description: 'Raw content and typed message details', sql: SCHEMA_V5 },
  { version: 6, description: 'Audio queue claims and media re-upload', sql: SCHEMA_V6 },
  { version: 7, description: 'Ask history', sql: SCHEMA_V7 },
]

/** The highest migration version applied to this database, 0 for a database with none. */
export function currentVersion(db: Database): number {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get()
  if (table === undefined) return 0
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null }
  return row.version ?? 0
}

export interface MigrateHooks {
  /** For tests: runs after a migration was found pending and before its transaction starts. */
  readonly beforeApply?: (migration: Migration) => void
}

/**
 * Applies, in order, every migration newer than the database's version. Each one runs in its own transaction
 * together with the row that records it, so a failed migration leaves the database as it was. The version is read
 * again inside the transaction, so two processes opening the same file cannot apply a migration twice.
 * A database from a newer release is refused: the data may not be understood.
 * A migration with `foreignKeys: false` runs with foreign keys off and is checked with foreign_key_check.
 */
export function migrate(db: Database, migrations: readonly Migration[], hooks: MigrateHooks = {}): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migrations must be numbered 1, 2, 3...: found ${m.version} at position ${i}`)
    }
  })
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const found = currentVersion(db)
  if (found > migrations.length) {
    throw new Error(`The database is at schema version ${found}, newer than this program knows (${migrations.length})`)
  }
  for (const migration of migrations) {
    if (migration.version <= found) continue
    hooks.beforeApply?.(migration)
    const apply = (): void =>
      inTransaction(db, () => {
        if (migration.version <= currentVersion(db)) return
        db.exec(migration.sql)
        if (migration.foreignKeys === false) {
          const violations = db.prepare('PRAGMA foreign_key_check').all()
          if (violations.length > 0) {
            throw new Error(`Migration ${migration.version} left ${violations.length} foreign key violation(s)`)
          }
        }
        db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(migration.version, Date.now())
      })
    if (migration.foreignKeys === false) {
      // The pragma does nothing inside a transaction, so it is switched around it.
      db.exec('PRAGMA foreign_keys = OFF')
      try {
        apply()
      } finally {
        db.exec('PRAGMA foreign_keys = ON')
      }
    } else {
      apply()
    }
  }
}
