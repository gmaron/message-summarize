import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDirectory } from './accounts.js'
import { runningDaemonPid } from './daemon-lock.js'
import type { Logger } from './logger.js'
import type { DataLayout } from './paths.js'

/** An import builds the account in a hidden directory of `accounts/` with this prefix, and moves it into place at the end. */
export const IMPORT_DIR_PATTERN = /^\.import-/
/** The pid file (the format of the daemon lock) an import keeps in its work directory while it lives. */
export const IMPORT_LOCK = 'import.lock'
/** A work directory without a pid file younger than this is an import that is just starting. */
const YOUNG_MS = 60_000

export interface ImportDir {
  readonly name: string
  readonly path: string
  /** A live process holds its pid file: an import is working in it right now. */
  readonly live: boolean
}

/** The work directories of imports under `accounts/`. */
export async function importDirs(layout: Pick<DataLayout, 'accountsDir'>): Promise<ImportDir[]> {
  const entries = await readdir(layout.accountsDir, { withFileTypes: true }).catch(() => [])
  const found: ImportDir[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !IMPORT_DIR_PATTERN.test(entry.name)) continue
    const path = join(layout.accountsDir, entry.name)
    const pid = await runningDaemonPid(join(path, IMPORT_LOCK))
    // An import creates the directory and writes its pid file a moment later: a directory with no pid file that is
    // only seconds old is that moment, not an abandoned one.
    const young =
      pid === null &&
      !(await stat(join(path, IMPORT_LOCK)).catch(() => null)) &&
      Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? 0) < YOUNG_MS
    found.push({ name: entry.name, path, live: pid !== null || young })
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Removes the work directories of imports that died (a crash, a kill): their pid file names a process that is gone, or
 * there is none (the directory was made and the process died before writing it). They hold a copy of a WhatsApp
 * session and of messages, so they must not stay. A directory whose pid is alive belongs to an import that is running
 * and is left alone. It logs how many, and nothing of what they held. Called at the start of every import and of every
 * daemon.
 */
export async function removeStaleImportDirs(layout: Pick<DataLayout, 'accountsDir'>, logger: Logger): Promise<number> {
  let removed = 0
  for (const dir of await importDirs(layout)) {
    if (dir.live || !isDirectory(dir.path)) continue
    await rm(dir.path, { recursive: true, force: true })
    removed++
  }
  if (removed > 0) logger.warn('import.staleRemoved', { count: removed })
  return removed
}
