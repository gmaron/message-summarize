import { chmod, copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Reads an installation of the previous personal tool (summaryzing-whatsapp), for `msum import` (RF-06). Everything
 * here is READ-ONLY with respect to that installation: files are only read or copied, never moved, written or opened by
 * SQLite in place (a database is copied, with its -wal and -shm, and the COPY is opened). The formats are those that
 * tool's own code writes:
 *
 * - the installation root holds `config.json`, `prompt.md`, `auth/` (the session, Baileys multi-file store) and `data/`
 *   (`whatsapp.db`, media, digests). Each extra phone is an instance under `instancias/<name>/` with its own `auth/`,
 *   `data/`, and a `config.json` that only has what differs from the root's (`{...root, ...own}`, with `claude`,
 *   `ollama` and `whisper` merged key by key) and an optional `prompt.md` (else the root's);
 * - `whatsapp.db` has `messages`, `chats`, `contacts`, `outbox` and `state` tables (see `LegacyDatabase`).
 */

/** Names of instances are `[\w-]+` in the previous tool. */
export const LEGACY_INSTANCE_NAME = /^[\w-]+$/

export interface LegacyLayout {
  /** The root of the installation. */
  readonly root: string
  /** Null for the main installation, else the name of the instance. */
  readonly instance: string | null
  /** Where the session, data, config and prompt of this account live (the root, or the instance directory). */
  readonly dir: string
  readonly authDir: string
  readonly dataDir: string
  readonly dbFile: string
  /** The config files that apply, in order: the root's, then the instance's. */
  readonly configFiles: readonly string[]
  /** The prompt files to try, in order: the instance's, then the root's. */
  readonly promptFiles: readonly string[]
}

/**
 * The paths of an installation, or of one instance. `dataDir` overrides where the data lives: the previous tool let it
 * be moved with `WA_DATA_DIR`, which leaves no trace in the installation, so the user may have to say where it is.
 */
export function legacyLayoutOf(root: string, instance: string | null, dataDir?: string): LegacyLayout {
  if (instance !== null && !LEGACY_INSTANCE_NAME.test(instance)) throw new RangeError('invalid instance name')
  const dir = instance === null ? root : join(root, 'instancias', instance)
  const data = dataDir ?? join(dir, 'data')
  return {
    root,
    instance,
    dir,
    authDir: join(dir, 'auth'),
    dataDir: data,
    dbFile: join(data, 'whatsapp.db'),
    configFiles:
      instance === null ? [join(root, 'config.json')] : [join(root, 'config.json'), join(dir, 'config.json')],
    promptFiles: instance === null ? [join(root, 'prompt.md')] : [join(dir, 'prompt.md'), join(root, 'prompt.md')],
  }
}

const isDir = async (path: string): Promise<boolean> => (await stat(path).catch(() => null))?.isDirectory() === true
const isFile = async (path: string): Promise<boolean> => (await stat(path).catch(() => null))?.isFile() === true

/** The names of the instances of an installation (directories under `instancias/` with a valid name), sorted. */
export async function listLegacyInstances(root: string): Promise<string[]> {
  const entries = await readdir(join(root, 'instancias'), { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() && LEGACY_INSTANCE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

export async function legacyInstanceExists(root: string, instance: string): Promise<boolean> {
  return LEGACY_INSTANCE_NAME.test(instance) && (await isDir(join(root, 'instancias', instance)))
}

/** Whether this directory looks like an installation of the previous tool at all (its root has a `src` or `auth`). */
export async function looksLikeLegacyRoot(root: string): Promise<boolean> {
  return (
    (await isDir(root)) &&
    ((await isDir(join(root, 'auth'))) || (await isDir(join(root, 'instancias'))) || (await isDir(join(root, 'data'))))
  )
}

/** Why the previous tool looks as if it is running. */
export type LiveSignal =
  /** `whatsapp.db-wal` exists: SQLite removes it when the last connection closes cleanly. */
  | 'wal'
  /** `whatsapp.db-shm` exists, for the same reason. */
  | 'shm'
  /** The database or its write-ahead log was written within the last minute. */
  | 'recentWrite'
  /** A file of the session was written within the last ten minutes: Baileys rewrites them while it runs. */
  | 'recentSession'

/** The database counts as being written to when it changed within this long. */
export const LIVE_DATABASE_WINDOW_MS = 60_000
/** The session counts as being rewritten when a file of it changed within this long. */
export const LIVE_SESSION_WINDOW_MS = 10 * 60_000

/**
 * The previous tool keeps no lock or pid file, so whether it runs is inferred from signs it leaves, all of them read
 * with a `stat` and never by reading a file:
 * - a `-wal` or `-shm` file next to the database: SQLite removes them when the last connection closes cleanly, so they
 *   mean that the tool has the database open, or that it crashed;
 * - the database or its `-wal` written within a minute (the listener writes all the time);
 * - the newest file of `auth/` written within ten minutes (Baileys keeps rewriting its session while it runs).
 *
 * An empty list is not proof that it is stopped (a listener may be quiet for longer), which is why the command also
 * warns and asks. `--force` skips this check.
 */
export async function legacyLiveSignals(layout: LegacyLayout, now: number): Promise<LiveSignal[]> {
  const signals: LiveSignal[] = []
  if (await isFile(`${layout.dbFile}-wal`)) signals.push('wal')
  if (await isFile(`${layout.dbFile}-shm`)) signals.push('shm')
  for (const file of [layout.dbFile, `${layout.dbFile}-wal`]) {
    const info = await stat(file).catch(() => null)
    if (info !== null && now - info.mtimeMs < LIVE_DATABASE_WINDOW_MS) {
      signals.push('recentWrite')
      break
    }
  }
  let newest = 0
  for (const entry of await readdir(layout.authDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue
    const info = await stat(join(layout.authDir, entry.name)).catch(() => null)
    if (info !== null && info.mtimeMs > newest) newest = info.mtimeMs
  }
  if (newest > 0 && now - newest < LIVE_SESSION_WINDOW_MS) signals.push('recentSession')
  return signals
}

/** Whether the database the import would read exists (the data directory may have been moved with `WA_DATA_DIR`). */
export async function legacyDatabaseExists(layout: LegacyLayout): Promise<boolean> {
  return isFile(layout.dbFile)
}

type Obj = Record<string, unknown>
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

async function readJsonObject(file: string): Promise<Obj | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The configuration the previous tool runs with: the root's `config.json`, overridden by the instance's, with `claude`,
 * `ollama` and `whisper` merged key by key (as its `config.js` does). Null when no config file could be read.
 */
export async function readLegacyConfig(layout: LegacyLayout): Promise<Obj | null> {
  const [base, own] = await Promise.all(layout.configFiles.map(readJsonObject))
  if (base === null && (own === null || own === undefined)) return null
  const root = base ?? {}
  const merged: Obj = { ...root, ...(own ?? {}) }
  for (const key of ['claude', 'ollama', 'whisper']) {
    const a = root[key]
    const b = own?.[key]
    if (isObject(a) || isObject(b)) merged[key] = { ...(isObject(a) ? a : {}), ...(isObject(b) ? b : {}) }
  }
  return merged
}

/** The prompt file that applies (the instance's, else the root's), or null. */
export async function findLegacyPrompt(layout: LegacyLayout): Promise<string | null> {
  for (const file of layout.promptFiles) if (await isFile(file)) return file
  return null
}

export interface CopiedSession {
  readonly files: number
  /** Entries that were not copied (anything but a regular file: a link, a folder). */
  readonly skipped: number
  /** The `id` of the account the session belongs to (`creds.me.id`), or null when there is no registered session. */
  readonly me: string | null
}

/**
 * Copies the Baileys multi-file session (flat JSON files: `creds.json`, `session-*.json`, `pre-key-*.json`, ...) into
 * `target`, a directory created 0700, with every file 0600. The files are copied byte for byte: our own auth state
 * uses the same file names and format, so the session works unchanged. Only regular files are copied.
 */
export async function copyLegacySession(authDir: string, target: string): Promise<CopiedSession> {
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  let files = 0
  let skipped = 0
  for (const entry of await readdir(authDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      skipped++
      continue
    }
    const to = join(target, entry.name)
    await copyFile(join(authDir, entry.name), to)
    await chmod(to, 0o600)
    files++
  }
  return { files, skipped, me: await sessionAccount(target) }
}

/** `creds.me.id` of a session directory: the phone-number JID of the linked account, or null. Never anything else. */
export async function sessionAccount(authDir: string): Promise<string | null> {
  const creds = await readJsonObject(join(authDir, 'creds.json'))
  const me = creds?.me
  return isObject(me) && typeof me.id === 'string' && me.id !== '' ? me.id : null
}

// -------------------------------------------------------------------------------------------------------------------

export interface LegacyChat {
  readonly jid: string
  readonly name: string | null
  readonly isGroup: boolean
  /** The phone's unread counter: null unknown, -1 marked unread by hand, else a count. */
  readonly unreadCount: number | null
}

export interface LegacyContact {
  readonly jid: string
  /** The name in the address book. */
  readonly name: string | null
  /** The name the person chose for themselves. */
  readonly pushName: string | null
}

export interface LegacyMessage {
  readonly chatJid: string
  readonly id: string
  readonly senderJid: string | null
  readonly senderName: string | null
  readonly fromMe: boolean
  /** Epoch ms. */
  readonly ts: number
  readonly kind: string
  readonly text: string | null
  readonly mediaPath: string | null
  readonly transcript: string | null
  readonly transcribeError: string | null
  readonly imageText: string | null
  readonly imageError: string | null
  readonly read: boolean
}

/**
 * The previous tool's database, opened on a COPY made in `workDir` (the original and its -wal/-shm are only read),
 * because opening a SQLite file, even to read it, can recover or checkpoint it and so change it.
 *
 * Tables, as the previous tool's `db.js` creates them (older databases lack the columns it adds later, and read as null):
 * - `messages(chat_jid, id, sender_jid, sender_name, from_me, ts, kind, text, media_path, transcript, transcribe_error,
 *   [read], [image_text], [image_error])`, primary key (chat_jid, id); an edit rewrites `text` as "(editado) ...";
 * - `chats(jid, name, is_group, [unread_count])`;
 * - `contacts(jid, name, [push_name])`: `name` is the address book, `push_name` what the person calls themselves;
 * - `outbox(id, text, created_at, sent_at)`: digests waiting for the listener to send them;
 * - `state(key, value)`: among others `last_summary_ts`, the end of the last digest (epoch ms).
 */
export class LegacyDatabase {
  private constructor(private readonly db: DatabaseSync) {}

  /** Copies `layout.dbFile` (and its -wal and -shm when present) into `workDir` and opens the copy. Null: no database. */
  static async openCopy(layout: LegacyLayout, workDir: string): Promise<LegacyDatabase | null> {
    if (!(await isFile(layout.dbFile))) return null
    await mkdir(workDir, { recursive: true, mode: 0o700 })
    const copy = join(workDir, 'whatsapp.db')
    await copyFile(layout.dbFile, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (await isFile(`${layout.dbFile}${suffix}`)) await copyFile(`${layout.dbFile}${suffix}`, `${copy}${suffix}`)
    }
    return new LegacyDatabase(new DatabaseSync(copy))
  }

  private columns(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    return new Set(rows.map((row) => row.name))
  }

  private hasTable(table: string): boolean {
    return this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
  }

  /** A column that older databases may lack: its name, or `NULL`. */
  private optional(table: string, column: string): string {
    return this.columns(table).has(column) ? column : 'NULL'
  }

  chats(): LegacyChat[] {
    if (!this.hasTable('chats')) return []
    const rows = this.db
      .prepare(
        `SELECT jid, name, is_group, ${this.optional('chats', 'unread_count')} AS unread_count FROM chats ORDER BY jid`,
      )
      .all() as { jid: string; name: string | null; is_group: number; unread_count: number | null }[]
    return rows.map((row) => ({
      jid: row.jid,
      name: row.name,
      isGroup: Number(row.is_group) === 1,
      unreadCount: row.unread_count === null ? null : Number(row.unread_count),
    }))
  }

  contacts(): LegacyContact[] {
    if (!this.hasTable('contacts')) return []
    const rows = this.db
      .prepare(`SELECT jid, name, ${this.optional('contacts', 'push_name')} AS push_name FROM contacts ORDER BY jid`)
      .all() as { jid: string; name: string | null; push_name: string | null }[]
    return rows.map((row) => ({ jid: row.jid, name: row.name, pushName: row.push_name }))
  }

  /** Every message, oldest first (ties in insertion order). */
  messages(): LegacyMessage[] {
    if (!this.hasTable('messages')) return []
    const rows = this.db
      .prepare(
        `SELECT chat_jid, id, sender_jid, sender_name, from_me, ts, kind, text, media_path, transcript,
                transcribe_error, ${this.optional('messages', 'image_text')} AS image_text,
                ${this.optional('messages', 'image_error')} AS image_error,
                ${this.optional('messages', 'read')} AS read
         FROM messages ORDER BY ts, rowid`,
      )
      .all() as Record<string, unknown>[]
    return rows.map((row) => ({
      chatJid: String(row.chat_jid),
      id: String(row.id),
      senderJid: (row.sender_jid as string | null) ?? null,
      senderName: (row.sender_name as string | null) ?? null,
      fromMe: Number(row.from_me) === 1,
      ts: Number(row.ts),
      kind: String(row.kind),
      text: (row.text as string | null) ?? null,
      mediaPath: (row.media_path as string | null) ?? null,
      transcript: (row.transcript as string | null) ?? null,
      transcribeError: (row.transcribe_error as string | null) ?? null,
      imageText: (row.image_text as string | null) ?? null,
      imageError: (row.image_error as string | null) ?? null,
      read: Number(row.read ?? 0) === 1,
    }))
  }

  /** The `state` table as a map of key to value. */
  state(): Map<string, string> {
    if (!this.hasTable('state')) return new Map()
    const rows = this.db.prepare('SELECT key, value FROM state').all() as { key: string; value: string | null }[]
    return new Map(rows.map((row) => [row.key, row.value ?? '']))
  }

  /** How many digests are waiting in the outbox (never sent). */
  pendingOutbox(): number {
    if (!this.hasTable('outbox')) return 0
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL').get() as { n: number }).n)
  }

  close(): void {
    this.db.close()
  }
}

/** How many digest files the previous tool saved (`data/resumenes/*.md`): counted, not read. */
export async function countLegacyDigestFiles(layout: LegacyLayout): Promise<number> {
  const entries = await readdir(join(layout.dataDir, 'resumenes')).catch(() => [] as string[])
  return entries.filter((name) => name.endsWith('.md')).length
}
