import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { GenerateDigestRequest } from '../../src/application/generate-digest.js'
import type { Conversation, MessageKind, UnreadState } from '../../src/domain/model.js'
import { unmaskedName } from '../../src/domain/names.js'
import { err, ok, type Result } from '../../src/domain/result.js'
import { InMemorySource } from './application-fakes.js'

/**
 * Stand-in for the future WhatsApp adapter, for the golden harness. It reads the scenarios of the legacy tool
 * (Spanish config keys, WhatsApp jids, SQLite-shaped rows) and translates them into the platform-neutral model.
 * WhatsApp concepts live here, in test code, never in src/.
 */

export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden')
const TZ_OFFSET = '-03:00' // America/Argentina/Buenos_Aires has no daylight saving

interface LegacyChat {
  jid: string
  name?: string | null
  is_group?: number
  unread_count?: number | null
}
interface LegacyContact {
  jid: string
  name?: string | null
  push_name?: string | null
}
interface LegacyMessage {
  chat: string
  at: string
  id?: string
  sender?: string
  sender_name?: string
  from_me?: number
  kind?: string
  text?: string | null
  transcript?: string | null
  read?: number
}
interface LegacyRun {
  args: string[]
}
export interface LegacyScenario {
  description: string
  config: Record<string, unknown>
  prompt: string
  chats: LegacyChat[]
  contacts?: LegacyContact[]
  messages: LegacyMessage[]
  state?: Record<string, unknown>
  llm: Record<string, { error?: string } & Record<string, unknown>>
  runs: LegacyRun[]
}

/** "2026-06-02 08:00" in Buenos Aires to epoch ms. */
export const localToTs = (local: string): number => {
  const ts = new Date(`${local.replace(' ', 'T')}:00${TZ_OFFSET}`).getTime()
  if (Number.isNaN(ts)) throw new Error(`Invalid scenario time: ${local}`)
  return ts
}

export const scenarioSlugs = (): string[] =>
  readdirSync(join(GOLDEN_DIR, 'scenarios'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.slice(0, -'.mjs'.length))
    .sort()

export async function loadScenario(slug: string): Promise<LegacyScenario> {
  const url = pathToFileURL(join(GOLDEN_DIR, 'scenarios', `${slug}.mjs`)).href
  return ((await import(url)) as { default: LegacyScenario }).default
}

/** The legacy `phone()`: "+<number>" for a WhatsApp user id, the raw id otherwise. */
const phone = (jid: string): string => (jid.endsWith('@s.whatsapp.net') ? `+${jid.split('@')[0]}` : jid)

const MESSAGE_KINDS: readonly string[] = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contact',
  'poll',
  'event',
]

const unreadStateOf = (count: number | null | undefined): UnreadState =>
  count === null || count === undefined
    ? { kind: 'unknown' }
    : count === -1
      ? { kind: 'markedUnread' }
      : { kind: 'count', count }

/** Fills an InMemorySource the way the legacy database was seeded (see test/golden/generate.mjs, `normalize`). */
export function buildSource(scenario: LegacyScenario): InMemorySource {
  const source = new InMemorySource()
  // A chat that has messages but no row in `chats` still exists, with no name and no unread counter.
  const known = new Set(scenario.chats.map((c) => c.jid))
  const rows: LegacyChat[] = [...scenario.chats]
  for (const m of scenario.messages) {
    if (!known.has(m.chat)) {
      known.add(m.chat)
      rows.push({ jid: m.chat })
    }
  }
  for (const chat of rows) {
    const isGroup = chat.jid.endsWith('@g.us')
    const conversation: Conversation = {
      id: chat.jid,
      isGroup,
      name: unmaskedName(chat.name ?? null),
      participantId: isGroup ? null : chat.jid,
      address: phone(chat.jid),
    }
    source.addConversation(conversation).setUnread(chat.jid, unreadStateOf(chat.unread_count))
  }
  for (const contact of scenario.contacts ?? []) {
    source.addParticipant({
      id: contact.jid,
      savedName: unmaskedName(contact.name ?? null),
      // The stand-in follows the new model here (names arrive clean). The legacy tool only cleaned `name`, but no
      // scenario has a masked push name, so the output is the same.
      publicName: unmaskedName(contact.push_name ?? null),
    })
  }
  const seq = new Map<string, number>()
  const seen = new Map<number, string>()
  for (const m of scenario.messages) {
    const n = (seq.get(m.chat) ?? 0) + 1
    seq.set(m.chat, n)
    const fromMe = (m.from_me ?? 0) !== 0
    const senderId = m.sender ?? (fromMe || m.chat.endsWith('@g.us') ? null : m.chat)
    const kind = m.kind ?? 'text'
    if (!MESSAGE_KINDS.includes(kind)) throw new Error(`Unknown message kind in scenario: ${kind}`)
    const timestamp = localToTs(m.at)
    const previous = seen.get(timestamp)
    if (previous !== undefined) throw new Error(`Duplicate message timestamp ${m.at} (${previous})`)
    seen.set(timestamp, `${m.chat}/${n}`)
    source.addMessages({
      id: m.id ?? `m${String(n).padStart(3, '0')}`,
      conversationId: m.chat,
      senderId,
      senderName: m.sender_name ?? null,
      senderAddress: senderId === null ? null : phone(senderId),
      fromMe,
      timestamp,
      kind: kind as MessageKind,
      text: m.text ?? null,
      transcript: m.transcript ?? null,
      read: (m.read ?? 0) !== 0,
    })
  }
  return source
}

const MAPPED_CONFIG_KEYS = [
  'miNombre',
  'horasPorDefecto',
  'soloNoLeidos',
  'maxCaracteresPorChat',
  'excluir',
  'sinAgendarEnRojo',
  'ocultarResto',
]
/** Legacy keys with no counterpart in the digest settings (provider routing and transcription are other adapters). */
const IGNORED_CONFIG_KEYS = ['proveedor', 'soloLocal', 'whisper']

/** The pointer a scenario starts with. Only `last_summary_ts` exists, as epoch ms or as a local time string. */
export function initialPointer(scenario: LegacyScenario): number | null {
  const state = scenario.state ?? {}
  const unexpected = Object.keys(state).filter((k) => k !== 'last_summary_ts')
  if (unexpected.length > 0) throw new Error(`Unsupported legacy state keys: ${unexpected.join(', ')}`)
  const value = state.last_summary_ts
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? localToTs(value) : Number(value)
}

/** Slugs of the frozen directories (everything in test/golden/ that is not a scenario file or a script). */
export const frozenSlugs = (): string[] =>
  readdirSync(GOLDEN_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'scenarios')
    .map((d) => d.name)
    .sort()

/** Legacy config (Spanish keys) as the input of `parseDigestSettings`. Keys the legacy tool had and v1 drops are skipped. */
export function settingsInput(config: Record<string, unknown>): Record<string, unknown> {
  const known = new Set([...MAPPED_CONFIG_KEYS, ...IGNORED_CONFIG_KEYS])
  const unexpected = Object.keys(config).filter((k) => !known.has(k))
  if (unexpected.length > 0) throw new Error(`Unmapped legacy config keys: ${unexpected.join(', ')}`)
  return {
    ownerName: config.miNombre,
    defaultWindowHours: config.horasPorDefecto,
    unreadOnly: config.soloNoLeidos,
    maxCharsPerConversation: config.maxCaracteresPorChat,
    excludePatterns: config.excluir,
    flagUnsaved: config.sinAgendarEnRojo,
    hideRest: config.ocultarResto,
  }
}

/** The legacy placeholder {{nombre}} is {{name}} in the new prompt template. */
export const promptTemplateOf = (prompt: string): string => prompt.replaceAll('{{nombre}}', '{{name}}')

/** `--desde`, `--hasta` and `--dry-run` of a legacy run as a use case request (without settings and prompt). */
export function parseRunArgs(args: readonly string[]): Pick<GenerateDigestRequest, 'from' | 'until' | 'preview'> {
  const value = (flag: string): string | undefined => {
    const at = args.indexOf(flag)
    return at < 0 ? undefined : args[at + 1]
  }
  const desde = value('--desde')
  const hasta = value('--hasta')
  if (hasta === undefined) throw new Error('A golden run needs --hasta')
  const known = new Set(['--desde', '--hasta', '--dry-run', desde, hasta])
  const unknown = args.filter((a) => !known.has(a))
  if (unknown.length > 0) throw new Error(`Unsupported run arguments: ${unknown.join(' ')}`)
  return {
    from: desde === undefined ? undefined : localToTs(desde),
    until: localToTs(hasta),
    preview: args.includes('--dry-run'),
  }
}

/** A fixed legacy LLM response as the result of the Summarizer port: `{ error }` is a failure. */
export function llmResult(response: LegacyScenario['llm'][string] | undefined, id: string): Result<unknown, string> {
  if (response === undefined) return err(`no fixed response for ${id}`)
  if (response.error) return err(String(response.error))
  return ok(response)
}

export const readFrozen = (slug: string, run: number, file: string): string | null => {
  try {
    return readFileSync(join(GOLDEN_DIR, slug, `run-${run}`, file), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export const runCount = (slug: string): number =>
  readdirSync(join(GOLDEN_DIR, slug)).filter((d) => /^run-\d+$/.test(d)).length
