import { exactIdOf, hasIdPattern, isExcluded } from '../../domain/exclusion.js'
import { getCatalog } from '../../infrastructure/i18n/index.js'
import {
  type DirectoryEntry,
  SqliteConversationDirectory,
  SqliteConversationPurge,
} from '../../infrastructure/persistence/sqlite/index.js'
import { HttpError, type Route } from '../../interfaces/http/router.js'
import { isObject, loadEffectiveConfig, readConfigObject } from '../config/config.js'
import { editAccountPrivacyLists, type PrivacyEdit } from '../config/config-writer.js'
import type { CommandContext } from '../context.js'
import type { DaemonHost } from '../daemon/host.js'
import { accountLayoutOf, unsafeAccountPath } from '../installation/paths.js'
import { databaseAccess } from './database.js'
import { type AccountRoutesSource, knownAccount } from './routes.js'
import { issueViews } from './settings.js'

export interface ConversationRoutesSource extends AccountRoutesSource {
  readonly ctx: Pick<CommandContext, 'layout' | 'logger'>
  readonly host: DaemonHost
}

/** Where a mark comes from: the account's file names exactly this chat (removable here), or some other pattern does. */
type MarkSource = 'account' | 'pattern' | null

interface Marks {
  readonly excluded: MarkSource
  readonly localOnly: MarkSource
}

/** What `GET .../conversations` and `PUT .../marks` say of a chat's privacy. */
interface MarkView {
  readonly excluded: boolean
  readonly localOnly: boolean
  readonly marks: Marks
}

/** The privacy of an account as its files say it now. */
interface Privacy {
  readonly language: 'es' | 'en'
  readonly timezone: string
  /** Whether "local only" chats have a provider: an Ollama model is set (the configuration is not valid without one). */
  readonly localAvailable: boolean
  /** What each list holds in the ACCOUNT's file. */
  readonly own: { readonly excluded: readonly string[]; readonly localOnly: readonly string[] }
  /** What each list holds in force: the installation's and the account's together. */
  readonly all: { readonly excluded: readonly string[]; readonly localOnly: readonly string[] }
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [])

/** Items of the page that fit in one answer: the account's own `id:` marks that name no stored chat. */
const ID_PREFIX = 'id:'

/**
 * The conversations of an account (RF-72): list and search them, and mark them excluded (RF-14) or local only (RF-43).
 *
 * The marks are the privacy lists of the ACCOUNT's config.json: a chat is marked by the exact pattern `id:<conversation id>`
 * (the substring form is not used: an id can contain another). Marks that come from other patterns, or from the
 * installation's lists, are shown but not removable here (409 `matchedByPattern`).
 *
 * Excluding a chat deletes what was stored of it (RF-14: "no se guarda ni se resume"), after the configuration is saved and
 * applied, so capture already ignores it. It needs `confirmDelete: true` when messages are stored (409 `confirmRequired`).
 * Un-excluding restores nothing. A chat that was excluded is no longer a stored conversation, so it comes back in `unlisted`
 * (the account's `id:` marks with no stored chat), where it can be un-marked.
 *
 * Everything here is private chat data: behind the token, and never in an event or a log (counts and codes only).
 */
export function conversationRoutes(source: ConversationRoutesSource): Route[] {
  const { host, ctx } = source

  async function loadPrivacy(id: string): Promise<Privacy> {
    const account = accountLayoutOf(ctx.layout, id)
    const loaded = await loadEffectiveConfig(ctx.layout.configFile, account.configFile)
    if (!loaded.ok) throw new HttpError(422, 'invalidConfig')
    const own = await readConfigObject(account.configFile)
    if (!own.ok) throw new HttpError(422, 'invalidConfig')
    const config = loaded.value
    return {
      language: config.language,
      timezone: config.timezone,
      localAvailable: config.provider.ollama.model !== null,
      own: { excluded: strings(own.value.excludePatterns), localOnly: strings(own.value.localOnlyPatterns) },
      all: { excluded: config.digest.excludePatterns, localOnly: config.localOnlyPatterns },
    }
  }

  const withDatabase = databaseAccess({ host, ctx })

  const markSource = (
    own: readonly string[],
    all: readonly string[],
    chat: string,
    name: string | null,
  ): MarkSource => {
    if (hasIdPattern(own, chat)) return 'account'
    return isExcluded(all, chat, name) ? 'pattern' : null
  }

  function marksOf(privacy: Privacy, chat: string, name: string | null): MarkView {
    const excluded = markSource(privacy.own.excluded, privacy.all.excluded, chat, name)
    const localOnly = markSource(privacy.own.localOnly, privacy.all.localOnly, chat, name)
    return { excluded: excluded !== null, localOnly: localOnly !== null, marks: { excluded, localOnly } }
  }

  const unnamedGroupOf = (privacy: Privacy): string => getCatalog(privacy.language).unnamedGroup

  /** The ids the account marks by the exact form, in either list (as written, without the prefix). */
  const markedIds = (privacy: Privacy): string[] => {
    const seen = new Map<string, string>()
    for (const pattern of [...privacy.own.excluded, ...privacy.own.localOnly]) {
      const normalized = exactIdOf(pattern)
      if (normalized === null || normalized === '' || seen.has(normalized)) continue
      seen.set(normalized, pattern.slice(ID_PREFIX.length).trim())
    }
    return [...seen.values()]
  }

  const intParam = (query: URLSearchParams, name: string): number | undefined => {
    const value = query.get(name)
    if (value === null || value === '') return undefined
    if (!/^\d{1,9}$/.test(value)) throw new HttpError(400, 'invalidRequest')
    return Number(value)
  }

  const view = (entry: DirectoryEntry, privacy: Privacy) => ({
    id: entry.id,
    name: entry.name,
    isGroup: entry.isGroup,
    address: entry.address,
    lastMessageAt: entry.lastMessageAt,
    messages: entry.messages,
    unread: entry.unread,
    ...marksOf(privacy, entry.id, entry.name),
  })

  return [
    {
      method: 'GET',
      path: '/api/accounts/:id/conversations',
      handler: async ({ params, query }) => {
        const id = knownAccount(source, params)
        const q = (query.get('q') ?? '').slice(0, 200)
        const limit = intParam(query, 'limit')
        const offset = intParam(query, 'offset')
        const privacy = await loadPrivacy(id)
        const labels = { unnamedGroup: unnamedGroupOf(privacy) }
        const found = await withDatabase(id, (db) => {
          const directory = new SqliteConversationDirectory(db, labels)
          const page = directory.list({
            q,
            ...(limit === undefined ? {} : { limit }),
            ...(offset === undefined ? {} : { offset }),
          })
          const marked = markedIds(privacy)
          const stored = directory.existing(marked)
          return { page, stored }
        })
        const needle = q.trim().toLowerCase()
        const stored = found?.stored ?? new Set<string>()
        const unlisted = markedIds(privacy)
          .filter((chat) => !stored.has(chat) && (needle === '' || chat.toLowerCase().includes(needle)))
          .map((chat) => ({ id: chat, ...marksOf(privacy, chat, null) }))
        return {
          body: {
            total: found?.page.total ?? 0,
            items: (found?.page.items ?? []).map((entry) => view(entry, privacy)),
            unlisted,
            timezone: privacy.timezone,
            localAvailable: privacy.localAvailable,
          },
        }
      },
    },
    {
      method: 'PUT',
      path: '/api/accounts/:id/conversations/:cid/marks',
      handler: async ({ params, body }) => {
        const id = knownAccount(source, params)
        const chat = params.cid ?? ''
        if (!isObject(body)) throw new HttpError(400, 'invalidRequest')
        const wanted: { excluded?: boolean; localOnly?: boolean } = {}
        for (const key of Object.keys(body)) {
          if (key !== 'excluded' && key !== 'localOnly' && key !== 'confirmDelete')
            throw new HttpError(400, 'invalidRequest')
          if (typeof body[key] !== 'boolean') throw new HttpError(400, 'invalidRequest')
        }
        if (typeof body.excluded === 'boolean') wanted.excluded = body.excluded
        if (typeof body.localOnly === 'boolean') wanted.localOnly = body.localOnly
        if (wanted.excluded === undefined && wanted.localOnly === undefined) throw new HttpError(400, 'invalidRequest')
        const confirmed = body.confirmDelete === true

        const privacy = await loadPrivacy(id)
        // The chat is known when it is stored, or when the account marks it by id (an excluded chat is not stored).
        const aliases = await host.aliasesOf(id, chat)
        // A mark covers every id of the person that is known: the chat's own and its aliases (a LID and a number).
        const targets = [chat, ...aliases.filter((alias) => alias.toLowerCase() !== chat.toLowerCase())]
        const found = await withDatabase(id, (db) => {
          const entry = new SqliteConversationDirectory(db, { unnamedGroup: unnamedGroupOf(privacy) }).find(chat)
          const purge = new SqliteConversationPurge(db)
          const messages = targets.reduce((sum, target) => sum + purge.messageCount(target), 0)
          return { name: entry?.name ?? null, known: entry !== null, messages }
        })
        const marked = hasIdPattern([...privacy.own.excluded, ...privacy.own.localOnly], chat)
        if (found?.known !== true && !marked) throw new HttpError(404, 'notFound')
        const name = found?.name ?? null
        const stored = found?.messages ?? 0
        const now = marksOf(privacy, chat, name).marks

        // Everything that can be refused is decided before anything is written.
        const edits: PrivacyEdit[] = []
        const plan = (list: PrivacyEdit['list'], want: boolean | undefined, current: MarkSource) => {
          if (want === undefined) return
          if (!want && current === 'pattern') throw new HttpError(409, 'matchedByPattern')
          // Turning a mark on is repeated for every known id even when the chat has it: an id learned since is covered too.
          if (want || current === 'account')
            for (const target of targets) edits.push({ list, id: target, present: want })
        }
        plan('excludePatterns', wanted.excluded, now.excluded)
        plan('localOnlyPatterns', wanted.localOnly, now.localOnly)
        const deleting = wanted.excluded === true && stored > 0
        // The purge would race the reads of a digest or a preview of the account.
        if (wanted.excluded === true && host.isBusy(id)) throw new HttpError(409, 'busy')
        if (deleting && !confirmed) return { status: 409, body: { error: 'confirmRequired', messages: stored } }

        if (edits.length > 0) {
          const account = accountLayoutOf(ctx.layout, id)
          if ((await unsafeAccountPath(account)) !== null) throw new HttpError(500, 'internal')
          const written = await editAccountPrivacyLists({
            rootFile: ctx.layout.configFile,
            accountFile: account.configFile,
            edits,
          })
          if (!written.ok) {
            if (written.error.some((issue) => issue.code === 'concurrentEdit'))
              throw new HttpError(409, 'concurrentEdit')
            return { status: 422, body: { error: 'invalidConfig', issues: issueViews(written.error) } }
          }
          await host.reloadConfig(id)
          // `reloadConfig` never rejects: it is looked at here whether the unit really has the marks now. It does not,
          // and nothing is deleted, when the reload failed (the file stays written: the next successful look applies it).
          const applied = host.runtimeOf(id)?.config
          if (applied !== undefined) {
            const inForce = (list: PrivacyEdit['list']) =>
              list === 'excludePatterns' ? applied.digest.excludePatterns : applied.localOnlyPatterns
            // Only what was ADDED is verified: a removed mark may still be in force through the installation's lists.
            if (edits.some((edit) => edit.present && !hasIdPattern(inForce(edit.list), edit.id))) {
              throw new HttpError(503, 'notApplied')
            }
          }
          for (const edit of edits.filter((candidate) => candidate.id === chat)) {
            ctx.logger.info('conversation.marked', {
              account: id,
              reason: edit.list === 'excludePatterns' ? 'excluded' : 'localOnly',
              state: edit.present ? 'on' : 'off',
            })
          }
        }
        let deleted = 0
        if (wanted.excluded === true) {
          // Looked at again, in the same synchronous step as the deletion: a digest may have started since the first look.
          const purged = await withDatabase(id, (db) => {
            if (host.isBusy(id)) return 'busy' as const
            const purge = new SqliteConversationPurge(db)
            return targets.reduce((sum, target) => sum + purge.purge(target), 0)
          })
          // The mark stays written and applied; only the deletion waits (the page says to try again).
          if (purged === 'busy') throw new HttpError(409, 'busy')
          deleted = purged ?? 0
          ctx.logger.info('conversation.purged', { account: id, count: deleted })
        }
        const after = await loadPrivacy(id)
        return { body: { id: chat, ...marksOf(after, chat, name), deletedMessages: deleted } }
      },
    },
  ]
}
