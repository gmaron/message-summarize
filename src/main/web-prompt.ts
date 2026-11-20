import { randomBytes } from 'node:crypto'
import { chmod, lstat, readFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  PROMPT_MAX_LENGTH,
  PROMPT_PRESET_IDS,
  PROMPT_VARIABLES,
  type PromptPresetId,
  promptIssue,
} from '../domain/prompt.js'
import { getCatalog } from '../infrastructure/i18n/index.js'
import { HttpError, type Route } from '../interfaces/http/router.js'
import { isObject, isSetIn, readConfigObject, validateEffective } from './config.js'
import { serialized, syncDirectory, updateAccountConfig, writeDurably } from './config-writer.js'
import type { CommandContext } from './context.js'
import type { DaemonHost } from './daemon-host.js'
import { accountLayoutOf, unsafeAccountPath } from './paths.js'
import { type AccountRoutesSource, knownAccount } from './web-routes.js'
import { issueViews } from './web-settings.js'

export interface PromptRoutesSource extends AccountRoutesSource {
  readonly ctx: Pick<CommandContext, 'layout' | 'logger'>
  readonly host: DaemonHost
}

/** The file the web writes, inside the account's directory: always this name, never one the request gives. */
export const PROMPT_FILE_NAME = 'prompt.md'

/** Where Restore keeps the text it takes out of use (an older copy there is replaced). */
export const PREVIOUS_FILE_NAME = 'prompt.previous.md'

/** `GET /api/accounts/:id/prompt` (and what a successful PUT or DELETE answers). */
export interface PromptView {
  /** Where the prompt in force comes from: the account's own `promptFile`, the installation's, or the built-in one. */
  readonly source: 'account' | 'installation' | 'default'
  /** The prompt in force. When its file cannot be read (`error`), the built-in one, as a starting point. */
  readonly text: string
  /** The built-in template for the language of the account. */
  readonly defaultText: string
  /** The templates the editor offers, in the language of the account; `full` is `defaultText`. */
  readonly presets: readonly { readonly id: PromptPresetId; readonly text: string }[]
  readonly variables: readonly string[]
  readonly maxLength: number
  /** What `{{name}}` becomes now, or null (the language's own word is used then). */
  readonly ownerName: string | null
  /** `promptFile`: it is set and cannot be read, so digests fail until it is restored or replaced. */
  readonly error?: 'promptFile'
}

type Loaded =
  | { readonly ok: true; readonly view: PromptView }
  | { readonly ok: false; readonly issues: ReturnType<typeof issueViews> }

/**
 * The prompt of an account (RF-38).
 *
 * The prompt is the system prompt TEMPLATE. The format of the answer is not in it: every summarizer sends the output schema
 * apart (`--json-schema`, Ollama's `format`), so what is edited here cannot change it. The only variable is `{{name}}`.
 *
 * `PUT` writes `accounts/<id>/prompt.md` (atomically, mode 0600) and sets the ACCOUNT's `promptFile` to that name; the
 * settings API still refuses `promptFile`. `DELETE` goes back to the original: it removes the account's `promptFile` and,
 * when it pointed at that file, moves it to `prompt.previous.md`. If the installation's config.json sets a `promptFile`, the account inherits it
 * again (`source: "installation"`); the built-in prompt is used only when neither sets one. Only the file inside the
 * account's own directory is ever written or moved. Restore keeps the text it takes out of use in `prompt.previous.md`. Every digest and preview reads the file when it starts, and the
 * running unit is told to reload its configuration, so the next one uses the change.
 *
 * The text is user content: it is never logged (the logs hold the account and a length).
 */
export function promptRoutes(source: PromptRoutesSource, onChanged: () => void): Route[] {
  const { host, ctx } = source

  async function describePrompt(id: string): Promise<Loaded> {
    const { layout } = ctx
    const account = accountLayoutOf(layout, id)
    const root = await readConfigObject(layout.configFile)
    if (!root.ok) return { ok: false, issues: issueViews([root.error]) }
    const own = await readConfigObject(account.configFile)
    if (!own.ok) return { ok: false, issues: issueViews([own.error]) }
    const effective = validateEffective(root.value, own.value, layout.configFile, account.configFile)
    if (!effective.ok) return { ok: false, issues: issueViews(effective.error) }
    const config = effective.value
    const catalog = getCatalog(config.language)
    const defaultText = catalog.defaultSystemPrompt
    const base = {
      defaultText,
      presets: PROMPT_PRESET_IDS.map((presetId) => ({
        id: presetId,
        text: presetId === 'full' ? defaultText : catalog.promptPresets[presetId],
      })),
      variables: PROMPT_VARIABLES,
      maxLength: PROMPT_MAX_LENGTH,
      ownerName: config.digest.ownerName,
    }
    if (config.promptFile === null) return { ok: true, view: { ...base, source: 'default', text: defaultText } }
    const from = isSetIn(own.value, 'promptFile') ? 'account' : 'installation'
    try {
      const text = await readFile(config.promptFile, 'utf8')
      return { ok: true, view: { ...base, source: from, text } }
    } catch {
      return { ok: true, view: { ...base, source: from, text: defaultText, error: 'promptFile' } }
    }
  }

  async function view(id: string) {
    const loaded = await describePrompt(id)
    if (!loaded.ok) return { status: 422, body: { error: 'invalidConfig', issues: loaded.issues } }
    return { body: loaded.view }
  }

  /** The answer for a configuration change that was not accepted; a concurrent edit is a 409. */
  function refusal(issues: Parameters<typeof issueViews>[0]) {
    if (issues.some((problem) => problem.code === 'concurrentEdit')) throw new HttpError(409, 'concurrentEdit')
    return { status: 422, body: { error: 'invalidConfig', issues: issueViews(issues) } }
  }

  /** Writes the file next to its final place and renames it: a reader sees the old text or the new one, never half. */
  async function writePromptFile(dir: string, file: string, text: string): Promise<void> {
    const temporary = join(dir, `.${PROMPT_FILE_NAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await writeDurably(temporary, text)
      // `rename` replaces whatever is at `file` (a link included) without following it.
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    await syncDirectory(dir)
  }

  /**
   * Restore does not destroy the text: it moves it to `prompt.previous.md` (replacing an older one, mode 0600). A link is
   * moved as a link and never followed.
   */
  async function keepPrevious(dir: string, file: string): Promise<void> {
    const previous = join(dir, PREVIOUS_FILE_NAME)
    const info = await lstat(file).catch(() => null)
    if (info === null) return
    await rename(file, previous)
    if (!info.isSymbolicLink()) await chmod(previous, 0o600)
    await syncDirectory(dir)
  }

  /** The state of the file the web owns: a regular file, a link (never followed), a directory, or nothing. */
  const isDirectoryAt = async (file: string): Promise<boolean> =>
    (await lstat(file).catch(() => null))?.isDirectory() === true

  return [
    {
      method: 'GET',
      path: '/api/accounts/:id/prompt',
      handler: async ({ params }) => view(knownAccount(source, params)),
    },
    {
      method: 'PUT',
      path: '/api/accounts/:id/prompt',
      handler: async ({ params, body }) => {
        const id = knownAccount(source, params)
        if (!isObject(body) || typeof body.text !== 'string') throw new HttpError(400, 'invalidRequest')
        const { text } = body
        const issue = promptIssue(text)
        if (issue?.code === 'blank') return { status: 422, body: { error: 'blankPrompt' } }
        if (issue?.code === 'tooLong') {
          return { status: 422, body: { error: 'promptTooLong', maxLength: PROMPT_MAX_LENGTH } }
        }
        if (issue?.code === 'unknownVariable') {
          return { status: 422, body: { error: 'unknownVariable', variables: issue.variables } }
        }
        const account = accountLayoutOf(ctx.layout, id)
        if ((await unsafeAccountPath(account)) !== null) throw new HttpError(500, 'internal')
        const file = join(account.dir, PROMPT_FILE_NAME)
        const result = await serialized(file, async () => {
          if (await isDirectoryAt(file)) throw new HttpError(500, 'internal')
          const current = await readConfigObject(account.configFile)
          if (!current.ok) return { status: 422, body: { error: 'invalidConfig', issues: issueViews([current.error]) } }
          const raw = current.value.promptFile
          const pointsHere = typeof raw === 'string' && resolve(account.dir, raw) === file
          const change = {
            rootFile: ctx.layout.configFile,
            accountFile: account.configFile,
            patch: { promptFile: PROMPT_FILE_NAME },
          }
          // The change is checked first: a refusal must not have overwritten a prompt.md nobody points at.
          if (!pointsHere) {
            const checked = await updateAccountConfig({ ...change, dryRun: true })
            if (!checked.ok) return refusal(checked.error)
          }
          // The file first: if saving the option fails afterwards, nothing in force changes.
          await writePromptFile(account.dir, file, text)
          if (pointsHere) return null
          const written = await updateAccountConfig(change)
          return written.ok ? null : refusal(written.error)
        })
        if (result !== null) return result
        await host.reloadConfig(id)
        ctx.logger.info('prompt.saved', { account: id, count: text.length })
        onChanged()
        return view(id)
      },
    },
    {
      method: 'DELETE',
      path: '/api/accounts/:id/prompt',
      handler: async ({ params }) => {
        const id = knownAccount(source, params)
        const account = accountLayoutOf(ctx.layout, id)
        if ((await unsafeAccountPath(account)) !== null) throw new HttpError(500, 'internal')
        const file = join(account.dir, PROMPT_FILE_NAME)
        const result = await serialized(file, async () => {
          const current = await readConfigObject(account.configFile)
          if (!current.ok) return { status: 422, body: { error: 'invalidConfig', issues: issueViews([current.error]) } }
          if (!isSetIn(current.value, 'promptFile')) return null
          const raw = current.value.promptFile
          // Only the file the account points at AND that is the web's own is deleted: a prompt the user keeps elsewhere stays.
          const owned = typeof raw === 'string' && resolve(account.dir, raw) === file
          if (owned && (await isDirectoryAt(join(account.dir, PREVIOUS_FILE_NAME))))
            throw new HttpError(500, 'internal')
          const written = await updateAccountConfig({
            rootFile: ctx.layout.configFile,
            accountFile: account.configFile,
            patch: { promptFile: undefined },
          })
          if (!written.ok) {
            if (written.error.some((problem) => problem.code === 'concurrentEdit')) {
              throw new HttpError(409, 'concurrentEdit')
            }
            return { status: 422, body: { error: 'invalidConfig', issues: issueViews(written.error) } }
          }
          // The unit stops reading the file before it goes: no digest finds the option pointing at nothing.
          await host.reloadConfig(id)
          if (owned && !(await isDirectoryAt(file))) await keepPrevious(account.dir, file)
          return null
        })
        if (result !== null) return result
        ctx.logger.info('prompt.restored', { account: id })
        onChanged()
        return view(id)
      },
    },
  ]
}
