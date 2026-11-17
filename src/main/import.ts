import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCaptureMessages } from '../application/capture-messages.js'
import type { Clock } from '../application/ports/clock.js'
import { MESSAGE_KINDS, type Message, type UnreadState } from '../domain/model.js'
import { unmaskedName } from '../domain/names.js'
import {
  copyLegacySession,
  countLegacyDigestFiles,
  findLegacyPrompt,
  LegacyDatabase,
  type LegacyLayout,
  readLegacyConfig,
} from '../infrastructure/legacy/summaryzing-whatsapp.js'
import { addressOf, isGroupJid, selfChatJid } from '../infrastructure/whatsapp/jid.js'
import type { AppConfig } from './config.js'
import { type MappedConfig, mapLegacyConfig, type PrivacyBlock } from './import-config.js'
import { type AccountLayout, FILE_MODE } from './paths.js'
import { createRuntime } from './runtime.js'

/** The moments of an import, for tests that interrupt it (a hook may throw at one to simulate a crash). */
export type ImportStep = 'session' | 'database' | 'config' | 'built' | 'renamed'

/** What an import brought and what it left behind: counts and names, never a secret or a text. */
export interface ImportReport {
  readonly sessionFiles: number
  /** The phone-number JID of the linked account (`creds.me.id`): the caller masks it before printing. */
  readonly me: string
  readonly conversations: number
  readonly participants: number
  readonly messages: number
  readonly skippedKinds: number
  /** Messages of chats that the account excludes (RF-14): not stored. */
  readonly excludedMessages: number
  readonly edited: number
  readonly unreadCounted: number
  readonly unreadMarked: number
  readonly pointer: number | null
  readonly configWritten: readonly string[]
  readonly configUnmapped: readonly string[]
  readonly configInvalid: readonly string[]
  readonly promptCopied: boolean
  readonly mediaFiles: number
  readonly imageTexts: number
  readonly transcribeErrors: number
  readonly pendingOutbox: number
  readonly digestFiles: number
  readonly otherState: readonly string[]
}

export class NoSessionError extends Error {
  constructor() {
    super('no registered session')
    this.name = 'NoSessionError'
  }
}

export interface BuildImportOptions {
  readonly legacy: LegacyLayout
  /** The directory where the account is built (inside `accounts/`, a sibling of where it will end up). Created here. */
  readonly workDir: string
  /** What the account would be, from the installation: `raw` is its config.json as written, `baseline` the validated result. */
  readonly installation: { readonly raw: Record<string, unknown>; readonly baseline: AppConfig }
  /** The paths of the account, as they will be (the id is what counts; its directories are replaced by `workDir`'s). */
  readonly account: AccountLayout
  readonly env: NodeJS.ProcessEnv
  readonly clock: Clock
  readonly afterStep?: ((step: ImportStep) => void | Promise<void>) | undefined
  /** Import the session, the settings and the prompt, and none of the messages. */
  readonly sessionOnly?: boolean
}

/** A privacy list of the previous tool (`soloLocal`, `excluir`) could not be imported: the import must not go on without it. */
export class PrivacyListError extends Error {
  constructor(readonly blocked: readonly PrivacyBlock[]) {
    super('a privacy list cannot be imported')
    this.name = 'PrivacyListError'
  }
}

/** The settings of the previous installation, mapped. Pure reading: used to refuse early and by the build itself. */
export async function mapLegacySettings(
  legacy: LegacyLayout,
  installation: BuildImportOptions['installation'],
): Promise<MappedConfig> {
  return mapLegacyConfig(await readLegacyConfig(legacy), installation)
}

const PROMPT_FILE = 'prompt.md'

/** The messages of the previous tool carry its Spanish placeholders; this program's prompt uses {{name}}. */
export function convertLegacyPrompt(text: string): string {
  return text.replaceAll('{{nombre}}', '{{name}}')
}

/**
 * Builds the account in `workDir`, never touching the previous installation (which is only read) and never the real
 * account: the session, the database (through this program's own capture use case, so every invariant holds), the
 * `config.json` and the prompt. The caller then moves the directory into place with one rename.
 *
 * How the previous tool's data lands (see `LegacyDatabase` for its tables):
 * - `contacts` become participants (`name` is the saved name, `push_name` the public name; masked names are dropped);
 * - `chats` and every `chat_jid` of a message become conversations (a group is `is_group` or an `@g.us` id; the
 *   address is what `addressOf` computes, as at capture; the name is the chat name, unmasked);
 * - `messages` become messages in order, as history (`ts` is already in ms; `from_me`, `kind`, `text` as they are,
 *   `sender_name` is kept for incoming messages, `transcript` and `read` as they are). An edit is already folded into
 *   `text` with the "(editado) " prefix, which is this program's marker too, so it is kept as it stands;
 * - `chats.unread_count` becomes the unread snapshot: null unknown, -1 marked unread, else a count;
 * - `state.last_summary_ts` becomes the digest pointer, so the first digest does not summarize the past again;
 * - the account's identity (RF-51) is bound to the number of the session, as `link` does.
 */
export async function buildImport(options: BuildImportOptions): Promise<ImportReport> {
  const { legacy, workDir, account } = options
  const step = async (name: ImportStep): Promise<void> => {
    await options.afterStep?.(name)
  }
  await mkdir(workDir, { recursive: true, mode: 0o700 })
  await chmod(workDir, 0o700)

  // 0. The settings first: a privacy list that cannot be imported stops everything before anything is copied, because
  // importing without it would let chats reach an outside provider (`soloLocal`) or be stored (`excluir`).
  const mapped = await mapLegacySettings(legacy, options.installation)
  if (mapped.blocked.length > 0) throw new PrivacyListError(mapped.blocked)
  // What the account excludes (RF-14): the installation's patterns and the previous tool's, together (they are unioned).
  const excludePatterns = [
    ...new Set([
      ...options.installation.baseline.digest.excludePatterns,
      ...((mapped.config.excludePatterns as string[] | undefined) ?? []),
    ]),
  ]

  // 1. The session, copied byte for byte.
  const authDir = join(workDir, 'auth')
  const session = await copyLegacySession(legacy.authDir, authDir)
  if (session.me === null) throw new NoSessionError()
  const me = selfChatJid({ id: session.me })
  if (me === null) throw new NoSessionError()
  await step('session')

  // 2. The data.
  const dbFile = join(workDir, 'db.sqlite')
  const target: AccountLayout = {
    ...account,
    dir: workDir,
    dbFile,
    authDir,
    mediaDir: join(workDir, 'media'),
    qrFile: join(workDir, 'qr.png'),
    blockedFile: join(workDir, 'blocked.json'),
    configFile: join(workDir, 'config.json'),
    linkLockFile: join(workDir, 'link.lock'),
    stateFile: join(workDir, 'state.json'),
  }
  const counts = {
    conversations: 0,
    participants: 0,
    messages: 0,
    skippedKinds: 0,
    excludedMessages: 0,
    edited: 0,
    unreadCounted: 0,
    unreadMarked: 0,
    mediaFiles: 0,
    imageTexts: 0,
    transcribeErrors: 0,
  }
  let pointer: number | null = null
  let pendingOutbox = 0
  let otherState: string[] = []
  const legacyDb = options.sessionOnly === true ? null : await LegacyDatabase.openCopy(legacy, join(workDir, 'legacy'))
  const runtime = createRuntime({
    layout: target,
    config: options.installation.baseline,
    env: options.env,
    clock: options.clock,
    summarizer: null,
  })
  try {
    // One transaction around the whole import: it is fast, and a failure leaves the database as it was.
    runtime.db.exec('BEGIN IMMEDIATE')
    try {
      const capture = createCaptureMessages({
        repository: runtime.repository,
        clock: options.clock,
        // Excluded chats are never stored (RF-14), also here: what the account excludes now may be more than what the
        // previous tool excluded when it captured. The owner's own chat was never stored by the previous tool.
        excludePatterns: () => excludePatterns,
        ownConversationIds: () => [],
      })
      if (legacyDb !== null) {
        const chats = legacyDb.chats()
        const contacts = legacyDb.contacts()
        const messages = legacyDb.messages()

        for (const contact of contacts) {
          await capture.participantInfo({
            participant: {
              id: contact.jid,
              savedName: unmaskedName(contact.name),
              publicName: unmaskedName(contact.pushName),
            },
          })
          counts.participants++
        }

        const known = new Map(chats.map((chat) => [chat.jid, chat]))
        for (const message of messages) {
          if (!known.has(message.chatJid)) {
            known.set(message.chatJid, {
              jid: message.chatJid,
              name: null,
              isGroup: isGroupJid(message.chatJid),
              unreadCount: null,
            })
          }
        }
        for (const chat of known.values()) {
          const isGroup = chat.isGroup || isGroupJid(chat.jid)
          await capture.conversationMetadata({
            conversation: {
              id: chat.jid,
              isGroup,
              name: unmaskedName(chat.name),
              participantId: isGroup ? null : chat.jid,
              address: addressOf(chat.jid),
            },
          })
          counts.conversations++
        }

        for (const row of messages) {
          if (!(MESSAGE_KINDS as readonly string[]).includes(row.kind) || !Number.isFinite(row.ts)) {
            counts.skippedKinds++
            continue
          }
          const message: Message = {
            id: row.id,
            conversationId: row.chatJid,
            senderId: row.fromMe ? null : row.senderJid,
            senderName: row.fromMe ? null : row.senderName,
            senderAddress: row.fromMe || row.senderJid === null ? null : addressOf(row.senderJid),
            fromMe: row.fromMe,
            timestamp: row.ts,
            kind: row.kind as Message['kind'],
            text: row.text,
            transcript: row.transcript,
            read: row.read,
          }
          const isGroup = known.get(row.chatJid)?.isGroup === true || isGroupJid(row.chatJid)
          const outcome = await capture.receiveMessage({ message, isGroup, origin: 'history' })
          if (!outcome.stored) {
            // an excluded chat (RF-14): nothing of it is stored, and it is counted
            counts.excludedMessages++
            continue
          }
          counts.messages++
          if (row.text?.startsWith('(editado) ')) counts.edited++
          if (row.mediaPath !== null) counts.mediaFiles++
          if (row.imageText !== null && row.imageText !== '') counts.imageTexts++
          if (row.transcribeError !== null) counts.transcribeErrors++
        }

        const snapshotStartedAt = options.clock.now()
        for (const chat of known.values()) {
          if (chat.unreadCount === null) continue
          let state: UnreadState | null = null
          if (chat.unreadCount === -1) {
            state = { kind: 'markedUnread' }
            counts.unreadMarked++
          } else if (chat.unreadCount >= 0) {
            state = { kind: 'count', count: chat.unreadCount }
            counts.unreadCounted++
          }
          if (state === null) continue
          await capture.unreadSnapshot({
            conversationId: chat.jid,
            isGroup: chat.isGroup || isGroupJid(chat.jid),
            state,
            snapshotStartedAt,
          })
        }

        // The pointer: the end of the last digest. Only a real time is carried over.
        const state = legacyDb.state()
        const last = Number(state.get('last_summary_ts'))
        if (state.has('last_summary_ts') && Number.isFinite(last) && last > 0) {
          const committed = await runtime.store.commit({
            previousPointer: null,
            pointer: last,
            digest: null,
            parts: [],
          })
          if (committed.ok) pointer = last
        }
        otherState = [...state.keys()].filter((key) => key !== 'last_summary_ts').sort()
        pendingOutbox = legacyDb.pendingOutbox()
      }

      // RF-51: the account is bound to the number of the session, as `link` binds it.
      if (!runtime.identity.bind(me)) throw new Error('could not bind the account')
      runtime.db.exec('COMMIT')
    } catch (error) {
      if (runtime.db.isTransaction) runtime.db.exec('ROLLBACK')
      throw error
    }
  } finally {
    runtime.close()
    legacyDb?.close()
    // The copy of the previous database is private data too: it never stays in the account.
    await rm(join(workDir, 'legacy'), { recursive: true, force: true })
  }
  await step('database')

  // 3. The configuration and the prompt.
  const config: Record<string, unknown> = { ...mapped.config }
  let promptCopied = false
  const promptFile = await findLegacyPrompt(legacy)
  if (promptFile !== null) {
    await writeFile(join(workDir, PROMPT_FILE), convertLegacyPrompt(await readFile(promptFile, 'utf8')), {
      mode: FILE_MODE,
    })
    config.promptFile = PROMPT_FILE
    promptCopied = true
  }
  if (Object.keys(config).length > 0) {
    await writeFile(join(workDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: FILE_MODE })
  }
  await step('config')

  return {
    sessionFiles: session.files,
    me,
    ...counts,
    pointer,
    configWritten: mapped.written,
    configUnmapped: mapped.unmapped,
    configInvalid: mapped.invalid,
    promptCopied,
    pendingOutbox,
    digestFiles: await countLegacyDigestFiles(legacy),
    otherState,
  }
}

/** A fresh name for the directory where an import builds an account: a hidden sibling of the accounts, never an account id. */
export const importWorkDirName = (): string => `.import-${randomUUID()}`
