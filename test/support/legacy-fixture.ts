import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BufferJSON, initAuthCreds } from 'baileys'

/**
 * A MADE-UP installation of the previous tool, built in a temporary directory in the formats that tool writes
 * (Baileys multi-file session, `config.json`, `prompt.md`, `data/whatsapp.db`, `instancias/<name>/`). Every name, number
 * and message here is invented. Nothing of a real installation is used or needed.
 */

export const NOW = Date.parse('2026-11-17T15:00:00Z')
const HOUR = 3_600_000

export const ANA = '9916915573293@s.whatsapp.net'
export const BETO = '9918786733911@s.whatsapp.net'
export const CAMI = '9918931164137@s.whatsapp.net'
export const GROUP = '120363146125332922@g.us'
/** The linked numbers (with the device suffix that `creds.me.id` has). */
export const MAIN_ME = '9915434879818:7@s.whatsapp.net'
export const MAIN_ME_CHAT = '9915434879818@s.whatsapp.net'
export const TALLER_ME = '9915544595846:3@s.whatsapp.net'
export const TALLER_ME_CHAT = '9915544595846@s.whatsapp.net'

/** The end of the last digest of the main installation: messages before it were summarized by the previous tool. */
export const MAIN_POINTER = NOW - 150 * 60_000

export const LEGACY_PROMPT = `Sos el asistente de {{nombre}}. Resumí cada chat.
<!-- nota para quien edita: no llega al modelo -->
Los mensajes de {{nombre}} están marcados con [VOS].`

/** The config.json of the previous tool, with Spanish option names (made up). */
export const LEGACY_CONFIG = {
  miNombre: 'Pat Prueba',
  excluir: ['chat-excluido'],
  horasPorDefecto: 12,
  soloNoLeidos: true,
  sinAgendarEnRojo: true,
  ocultarResto: true,
  maxCaracteresPorChat: 5000,
  soloLocal: ['banco'],
  proveedor: 'claude',
  claude: { comando: 'claude', modelo: 'opus' },
  ollama: { url: 'http://127.0.0.1:11434', modelo: 'modelo-de-prueba', contexto: 8192 },
  leerImagenes: true,
  diasDeAudiosDelHistorial: 14,
  whisper: { modelo: 'models/whisper-de-prueba.bin', idioma: 'es' },
  web: { permitidos: ['alguien@example.test'] },
  opcionInventada: 1,
}

export interface LegacyOptions {
  readonly me?: string
  readonly config?: Record<string, unknown> | null
  readonly prompt?: string | null
  /** Rows for the database. Default: `standardData()`. Null: no database at all. */
  readonly data?: LegacyData | null
  /** Leave the newest rows only in the write-ahead log (the database was never checkpointed). */
  readonly walOnly?: boolean
  /** Do not write a session. */
  readonly noSession?: boolean
  /** Files besides creds.json in auth/. */
  readonly extraAuthFiles?: Record<string, string>
}

export interface LegacyData {
  readonly contacts: { jid: string; name: string | null; push_name: string | null }[]
  readonly chats: { jid: string; name: string | null; is_group: number; unread_count: number | null }[]
  readonly messages: {
    chat_jid: string
    id: string
    sender_jid: string | null
    sender_name: string | null
    from_me: number
    ts: number
    kind: string
    text: string | null
    media_path?: string | null
    transcript?: string | null
    transcribe_error?: string | null
    read?: number
    image_text?: string | null
    image_error?: string | null
  }[]
  readonly state: Record<string, string>
  readonly outbox: { text: string; created_at: number; sent_at: number | null }[]
}

/** Made-up conversations covering every kind of thing the importer maps, counts or skips. */
export function standardData(): LegacyData {
  const message = (
    chat: string,
    id: string,
    ts: number,
    text: string,
    extra: Partial<LegacyData['messages'][number]> = {},
  ): LegacyData['messages'][number] => ({
    chat_jid: chat,
    id,
    sender_jid: chat === GROUP ? ANA : chat,
    sender_name: 'Anita',
    from_me: 0,
    ts,
    kind: 'text',
    text,
    ...extra,
  })
  return {
    contacts: [
      { jid: ANA, name: 'Ana Prueba', push_name: 'Anita' },
      { jid: BETO, name: null, push_name: 'Beto Sin Agenda' },
      { jid: CAMI, name: 'Cami ∙∙∙∙89', push_name: null },
    ],
    chats: [
      { jid: ANA, name: 'Ana Prueba', is_group: 0, unread_count: 2 },
      { jid: BETO, name: null, is_group: 0, unread_count: -1 },
      { jid: GROUP, name: 'Grupo Vecinos', is_group: 1, unread_count: 0 },
      { jid: CAMI, name: '+54∙∙∙∙89', is_group: 0, unread_count: null },
    ],
    messages: [
      // before the pointer: the previous tool already summarized these
      message(ANA, 'a1', NOW - 3 * HOUR, 'ANTES-DEL-PUNTERO hola, ¿llegaste?', { read: 1 }),
      // after the pointer
      message(ANA, 'a2', NOW - 2 * HOUR, 'DESPUES-A2 ¿me mandás el presupuesto?'),
      message(ANA, 'a3', NOW - 1 * HOUR, 'DESPUES-A3 es para mañana'),
      {
        chat_jid: ANA,
        id: 'a4',
        sender_jid: null,
        sender_name: 'Yo',
        from_me: 1,
        ts: NOW - 50 * 60_000,
        kind: 'text',
        text: 'Te lo mando a la tarde',
      },
      message(BETO, 'b1', NOW - 100 * 60_000, '[audio]', {
        kind: 'audio',
        sender_name: 'Beto Sin Agenda',
        media_path: '/legacy/media/b1.ogg',
        transcript: 'DESPUES-AUDIO necesito cinco cajas',
      }),
      message(BETO, 'b2', NOW - 90 * 60_000, '[imagen] flyer de la feria', {
        kind: 'image',
        sender_name: 'Beto Sin Agenda',
        media_path: '/legacy/media/b2.jpg',
        image_text: 'Feria sábado 10hs',
      }),
      message(BETO, 'b3', NOW - 80 * 60_000, '[audio]', {
        kind: 'audio',
        sender_name: 'Beto Sin Agenda',
        media_path: '/legacy/media/b3.ogg',
        transcribe_error: 'whisper falló',
      }),
      message(GROUP, 'g1', NOW - 70 * 60_000, 'DESPUES-GRUPO reunión el jueves', {
        sender_jid: BETO,
        sender_name: 'Beto Sin Agenda',
      }),
      message(GROUP, 'g2', NOW - 60 * 60_000, '(editado) DESPUES-EDITADO reunión el viernes', { sender_jid: ANA }),
      message(GROUP, 'g3', NOW - 30 * 60_000, 'tipo desconocido', { kind: 'hologram' }),
    ],
    state: {
      last_summary_ts: String(MAIN_POINTER),
      agenda_resync_v1: String(NOW - 10 * 24 * HOUR),
      eventos_last_ts: String(NOW - 24 * HOUR),
    },
    outbox: [
      { text: 'resumen viejo enviado', created_at: NOW - 30 * HOUR, sent_at: NOW - 30 * HOUR },
      { text: 'resumen esperando', created_at: NOW - 3 * HOUR, sent_at: null },
    ],
  }
}

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE messages (
    chat_jid TEXT NOT NULL, id TEXT NOT NULL, sender_jid TEXT, sender_name TEXT, from_me INTEGER NOT NULL DEFAULT 0,
    ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT, media_path TEXT, transcript TEXT, transcribe_error TEXT,
    read INTEGER NOT NULL DEFAULT 0, image_text TEXT, image_error TEXT, PRIMARY KEY (chat_jid, id)
  );
  CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, is_group INTEGER NOT NULL DEFAULT 0, unread_count INTEGER);
  CREATE TABLE contacts (jid TEXT PRIMARY KEY, name TEXT, push_name TEXT);
  CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER);
  CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT);
`

function writeDatabase(file: string, data: LegacyData, walOnly: boolean): void {
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  const insert = (): void => {
    const contact = db.prepare('INSERT INTO contacts (jid, name, push_name) VALUES (?, ?, ?)')
    for (const c of data.contacts) contact.run(c.jid, c.name, c.push_name)
    const chat = db.prepare('INSERT INTO chats (jid, name, is_group, unread_count) VALUES (?, ?, ?, ?)')
    for (const c of data.chats) chat.run(c.jid, c.name, c.is_group, c.unread_count)
    const message = db.prepare(
      `INSERT INTO messages (chat_jid, id, sender_jid, sender_name, from_me, ts, kind, text, media_path, transcript,
         transcribe_error, read, image_text, image_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const m of data.messages) {
      message.run(
        m.chat_jid,
        m.id,
        m.sender_jid,
        m.sender_name,
        m.from_me,
        m.ts,
        m.kind,
        m.text,
        m.media_path ?? null,
        m.transcript ?? null,
        m.transcribe_error ?? null,
        m.read ?? 0,
        m.image_text ?? null,
        m.image_error ?? null,
      )
    }
    const state = db.prepare('INSERT INTO state (key, value) VALUES (?, ?)')
    for (const [key, value] of Object.entries(data.state)) state.run(key, value)
    const outbox = db.prepare('INSERT INTO outbox (text, created_at, sent_at) VALUES (?, ?, ?)')
    for (const o of data.outbox) outbox.run(o.text, o.created_at, o.sent_at)
  }
  insert()
  if (!walOnly) {
    db.close()
    return
  }
  // The rows live only in the -wal: copy the pair as it is while the writer is still open, as a running listener leaves it.
  copyFileSync(file, `${file}.snapshot`)
  copyFileSync(`${file}-wal`, `${file}.snapshot-wal`)
  db.close()
  rmSync(file, { force: true })
  rmSync(`${file}-wal`, { force: true })
  rmSync(`${file}-shm`, { force: true })
  copyFileSync(`${file}.snapshot`, file)
  copyFileSync(`${file}.snapshot-wal`, `${file}-wal`)
  rmSync(`${file}.snapshot`, { force: true })
  rmSync(`${file}.snapshot-wal`, { force: true })
}

/** A made-up Baileys session: real credential structure with random made-up keys, and the linked number in `me`. */
function writeSession(authDir: string, me: string, extra: Record<string, string>): void {
  mkdirSync(authDir, { recursive: true })
  const creds = { ...initAuthCreds(), me: { id: me, name: 'Dueño de Prueba' } }
  writeFileSync(join(authDir, 'creds.json'), JSON.stringify(creds, BufferJSON.replacer))
  writeFileSync(join(authDir, 'pre-key-1.json'), JSON.stringify({ made: 'up', key: 'AAAA-one' }))
  writeFileSync(join(authDir, 'session-9919357142173_1.0.json'), JSON.stringify({ made: 'up', key: 'BBBB-two' }))
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(authDir, name), content)
}

function writeInstallation(dir: string, options: LegacyOptions & { rootConfig?: boolean }): void {
  mkdirSync(join(dir, 'data'), { recursive: true })
  if (options.config !== null && options.config !== undefined) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(options.config, null, 2))
  }
  if (options.prompt !== null && options.prompt !== undefined) writeFileSync(join(dir, 'prompt.md'), options.prompt)
  if (options.noSession !== true) writeSession(join(dir, 'auth'), options.me ?? MAIN_ME, options.extraAuthFiles ?? {})
  if (options.data !== null) {
    writeDatabase(join(dir, 'data', 'whatsapp.db'), options.data ?? standardData(), options.walOnly === true)
  }
}

/** Marks every file of the tree as written long ago, so the previous tool does not look like it is running. */
export function makeOld(dir: string): void {
  const past = new Date('2026-01-01T00:00:00Z')
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else utimesSync(path, past, past)
    }
  }
  walk(dir)
}

export interface BuiltLegacy {
  readonly root: string
}

/** The main installation (and, optionally, instances) of the previous tool, under `root`. */
export function buildLegacy(
  root: string,
  main: LegacyOptions = { config: LEGACY_CONFIG, prompt: LEGACY_PROMPT },
  instances: Record<string, LegacyOptions> = {},
): BuiltLegacy {
  mkdirSync(root, { recursive: true })
  writeInstallation(root, main)
  for (const [name, options] of Object.entries(instances)) writeInstallation(join(root, 'instancias', name), options)
  makeOld(root)
  return { root }
}

/** The instance of the previous tool "taller": only what differs from the root's config, its own session and data. */
export function tallerOptions(): LegacyOptions {
  const data = standardData()
  return {
    me: TALLER_ME,
    config: {
      miNombre: 'Taller Prueba',
      horasPorDefecto: 6,
      excluir: ['otro-excluido'],
      ollama: { modelo: 'otro-modelo' },
    },
    prompt: 'Prompt propio de {{nombre}}.',
    data: {
      ...data,
      state: { last_summary_ts: String(NOW - 5 * HOUR) },
      messages: data.messages.filter((m) => m.chat_jid === ANA).slice(0, 2),
      chats: data.chats.filter((c) => c.jid === ANA),
      contacts: data.contacts.slice(0, 1),
      outbox: [],
    },
  }
}

/** The hash of every file under a directory, by relative path: to prove that a tree did not change by a byte. */
export function hashTree(dir: string): Record<string, string> {
  const hashes: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else hashes[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(dir)
  return hashes
}
