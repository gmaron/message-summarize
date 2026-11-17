import { randomBytes } from 'node:crypto'
import { open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { err, ok, type Result } from '../domain/result.js'
import { type AppConfig, type ConfigIssue, isObject, type Obj, readConfigObject, validateEffective } from './config.js'

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
  readonly patch: ConfigPatch
  /** The default of `timezone` (the system's). */
  readonly fallbackTimezone?: string
  /** Runs after the account file was read and patched, right before the final check. For tests: they edit the file there. */
  readonly beforeCommit?: (attempt: number) => void | Promise<void>
}

export type UpdateAccountConfigResult = Result<AppConfig, ConfigIssue[]>

/** The writes of each file wait for the one before it, so two changes never read the same old contents. */
const queues = new Map<string, Promise<unknown>>()

/** Runs `work` after every earlier job of `key` is over (whether it went well or not). */
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
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

/** How the file looks (modification time and size), or "missing". */
async function fingerprint(file: string): Promise<string> {
  try {
    const info = await stat(file)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return 'missing'
  }
}

/** Writes `text` to `file` and forces it to disk (data, then the directory entry, best effort). */
async function writeDurably(file: string, text: string): Promise<void> {
  const handle = await open(file, 'w', 0o600)
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(dir: string): Promise<void> {
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
    for (const [path, value] of Object.entries(patch)) applyOne(next, path, value)
    const effective = validateEffective(root.value, next, rootFile, accountFile, fallbackTimezone)
    if (!effective.ok) return effective
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
