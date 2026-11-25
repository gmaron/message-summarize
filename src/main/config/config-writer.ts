import { randomBytes } from 'node:crypto'
import { open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { exactIdOf, hasIdPattern, idPattern } from '../../domain/exclusion.js'
import { err, ok, type Result } from '../../domain/result.js'
import { LANGUAGES, type Language } from '../../infrastructure/i18n/index.js'
import { isValidTimezone } from '../../infrastructure/scheduling/croner-scheduler.js'
import {
  type AppConfig,
  type ConfigIssue,
  defaultConfigJson,
  isObject,
  type Obj,
  readConfigObject,
  validateEffective,
} from './config.js'

/**
 * A change to an account's config.json: option (a dotted path such as `unreadOnly` or `provider.claudeCli.model`) to
 * its new value. `undefined` removes the option from the account file, so the account inherits the installation's
 * value (or the default) again.
 */
export type ConfigPatch = Readonly<Record<string, unknown>>

export interface UpdateAccountConfigOptions {
  /** The installation's config.json: read, never written. */
  readonly rootFile: string
  /** The account's config.json: the one that is written. It does not have to exist. */
  readonly accountFile: string
  /** The change, or a function that builds it from the account file as it is when the write happens (read-modify-write). */
  readonly patch: ConfigPatch | ((current: Obj, root: Obj) => ConfigPatch)
  /** The default of `timezone` (the system's). */
  readonly fallbackTimezone?: string
  /** Validate the change exactly as a write would and return the result, without writing anything. */
  readonly dryRun?: boolean
  /** Runs after the account file was read and patched, right before the final check. For tests: they edit the file there. */
  readonly beforeCommit?: (attempt: number) => void | Promise<void>
}

export type UpdateAccountConfigResult = Result<AppConfig, ConfigIssue[]>

/** The writes of each file wait for the one before it, so two changes never read the same old contents. */
const queues = new Map<string, Promise<unknown>>()

/** Runs `work` after every earlier job of `key` is over (whether it went well or not). */
export function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const run = previous.then(work, work)
  const tail = run.catch(() => undefined)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

/** Sets (or, for `undefined`, removes) the dotted `path` in `target`, creating or replacing sections as needed. */
function applyOne(target: Obj, path: string, value: unknown): void {
  const keys = path.split('.')
  if (keys.some((key) => key === '__proto__' || key === 'constructor' || key === 'prototype')) return
  const chain: Obj[] = [target]
  for (const key of keys.slice(0, -1)) {
    const parent = chain[chain.length - 1] as Obj
    const child = parent[key]
    if (isObject(child)) chain.push(child)
    else {
      // Nothing to remove under a section that is not there. For a set, a section of the wrong shape is replaced.
      if (value === undefined) return
      const created: Obj = {}
      parent[key] = created
      chain.push(created)
    }
  }
  const last = keys[keys.length - 1] as string
  const holder = chain[chain.length - 1] as Obj
  if (value === undefined) {
    delete holder[last]
    // A section left empty by the removal goes too (`provider: {}` says nothing).
    for (let depth = keys.length - 1; depth > 0; depth--) {
      const section = chain[depth] as Obj
      if (Object.keys(section).length > 0) break
      delete (chain[depth - 1] as Obj)[keys[depth - 1] as string]
    }
  } else {
    holder[last] = value
  }
}

/**
 * Applies a patch to the account's config.json (RF-73) and saves it, only when the configuration that results is valid.
 *
 * - The web edits the ACCOUNT's file (an override), never the installation's: one account's change cannot affect another.
 *   A value equal to the installation's is stored anyway (explicit, and it survives a change of the installation).
 * - The result is validated as the daemon loads it (installation merged with the new account file, `parseConfig`
 *   rules). A problem returns its issues and writes nothing. An account file that is not valid JSON is not rewritten
 *   either: it was edited by hand, and replacing it would lose that.
 * - The file is written atomically (a temporary file in the same directory, mode 0600, then renamed), and any other key
 *   it holds (the privacy lists, `promptFile`...) is kept as it is.
 * - Writes to the same file are serialized in this process.
 */
export function updateAccountConfig(options: UpdateAccountConfigOptions): Promise<UpdateAccountConfigResult> {
  return serialized(options.accountFile, () => write(options))
}

/** The privacy lists (RF-14, RF-43): the ones the web adds conversations to and removes them from. */
export type PrivacyList = 'excludePatterns' | 'localOnlyPatterns'

/** Puts the exact pattern of a conversation id (`id:<id>`) in a privacy list (`present: true`) or takes it out of it. */
export interface PrivacyEdit {
  readonly list: PrivacyList
  /** The conversation id, not the pattern. Ids are compared without case, as the matcher does. */
  readonly id: string
  readonly present: boolean
}

/**
 * Adds or removes patterns in the privacy lists of the ACCOUNT's file (RF-72). Not part of the settings API (which refuses
 * these lists): the conversations API is the only caller. It reads the lists at the moment of the write, so two
 * changes at once never overwrite each other, and it validates and writes exactly as `updateAccountConfig` does. Only the
 * entries for the given ids are touched; a list of the wrong shape (a hand edit) is left alone and the validation says
 * so (nothing is written). Adding what is there already, or removing what is not, changes nothing.
 */
export function editAccountPrivacyLists(
  options: Omit<UpdateAccountConfigOptions, 'patch'> & {
    /**
     * The edits, or a function that decides them from the lists in force (the installation's and the account's, from the
     * files as they are when the write happens, and re-run if the file changed under it): decided inside the serialized
     * write, so a change that just landed is respected.
     */
    readonly edits:
      | readonly PrivacyEdit[]
      | ((inForce: Readonly<Record<PrivacyList, readonly string[]>>) => readonly PrivacyEdit[])
  },
): Promise<UpdateAccountConfigResult> {
  const { edits: given, ...rest } = options
  const patch = (current: Obj, root: Obj): ConfigPatch => {
    const texts = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
    const edits =
      typeof given === 'function'
        ? given({
            excludePatterns: [...texts(root.excludePatterns), ...texts(current.excludePatterns)],
            localOnlyPatterns: [...texts(root.localOnlyPatterns), ...texts(current.localOnlyPatterns)],
          })
        : given
    const changes: Record<string, unknown> = {}
    for (const { list, id, present } of edits) {
      const known = list in changes ? changes[list] : current[list]
      if (known !== undefined && !Array.isArray(known)) continue
      const entries = (known as string[] | undefined) ?? []
      changes[list] = present
        ? hasIdPattern(entries, id)
          ? entries
          : [...entries, idPattern(id)]
        : entries.filter((entry) => exactIdOf(entry) !== id.toLowerCase().trim())
    }
    return changes
  }
  return updateAccountConfig({ ...rest, patch })
}

/** How the file looks (modification time and size), or "missing". */
export async function fingerprint(file: string): Promise<string> {
  try {
    const info = await stat(file)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return 'missing'
  }
}

/** Writes `text` to `file` and forces it to disk (data, then the directory entry, best effort). */
export async function writeDurably(file: string, text: string): Promise<void> {
  const handle = await open(file, 'w', 0o600)
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Some platforms cannot sync a directory: the rename is already done, this only narrows a crash window.
  }
}

/** Reading and patching are redone this many times when the file changes under them. */
const ATTEMPTS = 2

async function write(options: UpdateAccountConfigOptions): Promise<UpdateAccountConfigResult> {
  const { rootFile, accountFile, patch, fallbackTimezone } = options
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // Taken BEFORE reading: a change after this point is seen by the check before the rename.
    const seen = await fingerprint(accountFile)
    const root = await readConfigObject(rootFile)
    if (!root.ok) return err([root.error])
    const current = await readConfigObject(accountFile)
    if (!current.ok) return err([current.error])
    const next = structuredClone(current.value)
    const changes = typeof patch === 'function' ? patch(current.value, root.value) : patch
    for (const [path, value] of Object.entries(changes)) applyOne(next, path, value)
    const effective = validateEffective(root.value, next, rootFile, accountFile, fallbackTimezone)
    if (!effective.ok) return effective
    if (options.dryRun === true) return ok(effective.value)
    const temporary = join(dirname(accountFile), `.config.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await writeDurably(temporary, `${JSON.stringify(next, null, 2)}\n`)
      await options.beforeCommit?.(attempt)
      // A hand edit that landed since the read would be lost by the rename: read and patch again from what is there now.
      // Another process can still write between this check and the rename (no file lock is taken): that gap is narrow
      // and remains, since a lock would have to be honored by editors too.
      if ((await fingerprint(accountFile)) !== seen) {
        await rm(temporary, { force: true })
        continue
      }
      await rename(temporary, accountFile)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    await syncDirectory(dirname(accountFile))
    return ok(effective.value)
  }
  return err([{ option: '(config)', code: 'concurrentEdit', file: accountFile }])
}

export interface UpdateInstallationLanguageOptions {
  /** The installation's config.json. It does not have to exist: then it is created as `msum init` would. */
  readonly rootFile: string
  /** The language to set, or none to leave it as it is. */
  readonly language?: Language
  /** The IANA time zone to set (the browser's on a fresh install), or none to leave it as it is. */
  readonly timezone?: string
  /** The default of `timezone` (the system's). */
  readonly fallbackTimezone?: string
}

export type UpdateInstallationLanguageResult = Result<null, ConfigIssue[]>

/**
 * Sets `language` and/or `timezone` in the INSTALLATION's config.json, and nothing else: the one write of the web to that file (the setup
 * wizard, RF-70, where there is no other account yet to hold the choice, and the language of the installation drives the
 * texts of the web and of the command line). Every other key is kept as it is. A file that is not valid JSON is not
 * rewritten (it was edited by hand). It is validated and written like an account's file: atomically, mode 0600, with
 * the check for a change made meanwhile, and serialized with the other writes to the same file.
 */
export function updateInstallationLanguage(
  options: UpdateInstallationLanguageOptions,
): Promise<UpdateInstallationLanguageResult> {
  return serialized(options.rootFile, () => writeInstallationLanguage(options))
}

async function writeInstallationLanguage(
  options: UpdateInstallationLanguageOptions,
): Promise<UpdateInstallationLanguageResult> {
  const { rootFile, language, timezone, fallbackTimezone } = options
  if (language !== undefined && !(LANGUAGES as readonly string[]).includes(language)) {
    return err([{ option: 'language', code: 'notOneOf', allowed: LANGUAGES }])
  }
  if (timezone !== undefined && !isValidTimezone(timezone))
    return err([{ option: 'timezone', code: 'invalidTimezone' }])
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const seen = await fingerprint(rootFile)
    const current = await readConfigObject(rootFile)
    if (!current.ok) return err([current.error])
    const base: Obj =
      seen === 'missing' ? (JSON.parse(defaultConfigJson(fallbackTimezone)) as Obj) : structuredClone(current.value)
    const next: Obj = {
      ...base,
      ...(language === undefined ? {} : { language }),
      ...(timezone === undefined ? {} : { timezone }),
    }
    // Only what the language change brings is refused: the file may be valid just once merged with the accounts' files, or
    // have an old problem the user has not fixed, and that must not block the first step.
    const effective = validateEffective(next, {}, rootFile, null, fallbackTimezone)
    if (!effective.ok) {
      const before = validateEffective(base, {}, rootFile, null, fallbackTimezone)
      const known = new Set(before.ok ? [] : before.error.map((issue) => `${issue.option}:${issue.code}`))
      const added = effective.error.filter(
        (issue) =>
          issue.option === 'language' || issue.option === 'timezone' || !known.has(`${issue.option}:${issue.code}`),
      )
      if (added.length > 0) return err(added)
    }
    const temporary = join(dirname(rootFile), `.config.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await writeDurably(temporary, `${JSON.stringify(next, null, 2)}\n`)
      if ((await fingerprint(rootFile)) !== seen) {
        await rm(temporary, { force: true })
        continue
      }
      await rename(temporary, rootFile)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    await syncDirectory(dirname(rootFile))
    return ok(null)
  }
  return err([{ option: '(config)', code: 'concurrentEdit', file: rootFile }])
}
