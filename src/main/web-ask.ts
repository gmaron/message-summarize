import { type AskPreset, MAX_ASK_PRESETS } from '../domain/ask-presets.js'
import { MAX_QUESTION_CHARS } from '../domain/ask-text.js'
import { getCatalog } from '../infrastructure/i18n/index.js'
import { HttpError, type Route } from '../interfaces/http/router.js'
import {
  ASK_PERIODS,
  ASK_SELECTIONS,
  type AskPeriod,
  type AskSelection,
  type AskService,
  type StartAskInput,
} from './ask.js'
import { readConfigObject, validateEffective } from './config.js'
import { updateAccountConfig } from './config-writer.js'
import { accountLayoutOf, unsafeAccountPath } from './paths.js'
import { type AccountRoutesSource, knownAccount } from './web-routes.js'
import { issueViews } from './web-settings.js'

export interface AskRoutesSource extends AccountRoutesSource {
  readonly asks: AskService
}

/** The most chat filters of a request and the longest one. */
const MAX_FILTERS = 20
const MAX_FILTER_CHARS = 100

function parseRequest(body: unknown): StartAskInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'invalidRequest')
  const { question, period, selection, chats, deliver } = body as {
    question?: unknown
    period?: unknown
    selection?: unknown
    chats?: unknown
    deliver?: unknown
  }
  if (typeof question !== 'string') throw new HttpError(400, 'invalidRequest')
  if (question.trim() === '') throw new HttpError(400, 'emptyQuestion')
  if (question.trim().length > MAX_QUESTION_CHARS) throw new HttpError(400, 'questionTooLong')
  if (typeof period !== 'string' || !(ASK_PERIODS as readonly string[]).includes(period)) {
    throw new HttpError(400, 'invalidRequest')
  }
  if (typeof selection !== 'string' || !(ASK_SELECTIONS as readonly string[]).includes(selection)) {
    throw new HttpError(400, 'invalidRequest')
  }
  if (typeof deliver !== 'boolean') throw new HttpError(400, 'invalidRequest')
  let filters: string[] = []
  if (chats !== undefined) {
    if (!Array.isArray(chats) || !chats.every((c) => typeof c === 'string') || chats.length > MAX_FILTERS) {
      throw new HttpError(400, 'invalidRequest')
    }
    filters = (chats as string[]).map((c) => c.trim().slice(0, MAX_FILTER_CHARS)).filter((c) => c !== '')
  }
  return { question, period: period as AskPeriod, selection: selection as AskSelection, chats: filters, deliver }
}

/** A preset as stored: name and text without the blanks around them. Anything that is not a preset is left for the validation to say. */
function trimmed(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
  const { name, text, ...rest } = entry as Record<string, unknown>
  return {
    ...rest,
    name: typeof name === 'string' ? name.trim() : name,
    text: typeof text === 'string' ? text.trim() : text,
  }
}

/**
 * The free requests over the chats (the "Ask" tab). `POST .../ask` answers 202 at once and the page learns how it ended
 * from an `ask` event; `GET .../asks` hands over the requests with their answers (private text, behind the token).
 * `GET/PUT .../ask-presets` are the saved requests of the account (`askPresets` of its config.json).
 */
export function askRoutes(source: AskRoutesSource): Route[] {
  const { asks, ctx, host } = source

  /** The presets in force (the account's, else the installation's) or the defaults of the language, and whether they are the defaults. */
  const presetsOf = async (id: string): Promise<{ presets: readonly AskPreset[]; defaults: boolean }> => {
    const account = accountLayoutOf(ctx.layout, id)
    const root = await readConfigObject(ctx.layout.configFile)
    const own = await readConfigObject(account.configFile)
    if (!root.ok || !own.ok) throw new HttpError(422, 'invalidConfig')
    const effective = validateEffective(root.value, own.value, ctx.layout.configFile, account.configFile)
    if (!effective.ok) throw new HttpError(422, 'invalidConfig')
    if (effective.value.askPresets.length > 0) return { presets: effective.value.askPresets, defaults: false }
    return { presets: getCatalog(effective.value.language).ask.defaultPresets, defaults: true }
  }

  return [
    {
      method: 'POST',
      path: '/api/accounts/:id/ask',
      handler: async ({ params, body }) => {
        const id = knownAccount(source, params)
        const started = await asks.start(id, parseRequest(body))
        if (started.ok) return { status: 202, body: { id: started.id } }
        switch (started.reason) {
          case 'busy':
          case 'notRunning':
            throw new HttpError(409, started.reason)
          case 'noProvider':
            throw new HttpError(422, 'invalidConfig')
          case 'emptyQuestion':
            throw new HttpError(400, 'emptyQuestion')
          default:
            throw new HttpError(503, 'unavailable')
        }
      },
    },
    {
      method: 'GET',
      path: '/api/accounts/:id/asks',
      handler: async ({ params }) => ({ body: { asks: await asks.list(knownAccount(source, params)) } }),
    },
    {
      method: 'DELETE',
      path: '/api/accounts/:id/asks/:askId',
      handler: async ({ params }) => {
        const id = knownAccount(source, params)
        const askId = Number(params.askId)
        if (!Number.isInteger(askId) || !(await asks.remove(id, askId))) throw new HttpError(404, 'notFound')
        return { status: 204 }
      },
    },
    {
      method: 'GET',
      path: '/api/accounts/:id/ask-presets',
      handler: async ({ params }) => ({ body: await presetsOf(knownAccount(source, params)) }),
    },
    {
      method: 'PUT',
      path: '/api/accounts/:id/ask-presets',
      handler: async ({ params, body }) => {
        const id = knownAccount(source, params)
        const list = (body as { presets?: unknown } | null)?.presets
        if (typeof body !== 'object' || body === null || !Array.isArray(list) || list.length > MAX_ASK_PRESETS) {
          throw new HttpError(400, 'invalidRequest')
        }
        const account = accountLayoutOf(ctx.layout, id)
        if ((await unsafeAccountPath(account)) !== null) throw new HttpError(500, 'internal')
        // An empty list removes the account's own value: the installation's (or the defaults) apply again.
        const written = await updateAccountConfig({
          rootFile: ctx.layout.configFile,
          accountFile: account.configFile,
          patch: { askPresets: list.length === 0 ? undefined : list.map(trimmed) },
        })
        if (!written.ok) {
          if (written.error.some((issue) => issue.code === 'concurrentEdit')) throw new HttpError(409, 'concurrentEdit')
          return { status: 422, body: { error: 'invalidConfig', issues: issueViews(written.error) } }
        }
        await host.reloadConfig(id)
        return { body: await presetsOf(id) }
      },
    },
  ]
}
