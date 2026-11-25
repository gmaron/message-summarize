import { hasIdPattern } from '../../domain/exclusion.js'
import { SqliteConversationPurge } from '../../infrastructure/persistence/sqlite/index.js'
import type { AccountLayout, DataLayout } from '../installation/paths.js'
import type { Runtime } from '../runtime.js'
import { editAccountPrivacyLists, type PrivacyEdit, type PrivacyList } from './config-writer.js'

/** What `coverAlias` needs of the host. */
export interface AliasHost {
  readonly layout: Pick<DataLayout, 'configFile'>
  readonly account: Pick<AccountLayout, 'configFile'>
  readonly runtime: Runtime
  /** Applies the written file to the running unit (never rejects). */
  reload(): Promise<void>
  /**
   * Puts marks in force in the running unit's memory only, and remembers them for the host to write later and to keep
   * when the files are read again. STRICTER ONLY: it is called when the marks could not be written or applied.
   */
  applyInMemory(edits: readonly PrivacyEdit[]): void
  /** A digest or a preview of the account is running: deleting stored messages now would race their reads. */
  isBusy(): boolean
  /** Asks for the stored data of these ids to be deleted later, when nothing is running. */
  deferPurge(ids: readonly string[]): void
}

export interface CoverResult {
  /** How many marks were added. */
  readonly added: number
  /** False when the marks could not be written to the file (they are in force in memory and will be written again). */
  readonly written: boolean
}

const LISTS: readonly PrivacyList[] = ['excludePatterns', 'localOnlyPatterns']

/** The edits that put a mark of one id of the pair on the other, from the lists given. */
function decide(inForce: Readonly<Record<PrivacyList, readonly string[]>>, a: string, b: string): PrivacyEdit[] {
  const edits: PrivacyEdit[] = []
  for (const list of LISTS) {
    const hasA = hasIdPattern(inForce[list], a)
    const hasB = hasIdPattern(inForce[list], b)
    if (hasA && !hasB) edits.push({ list, id: b, present: true })
    if (hasB && !hasA) edits.push({ list, id: a, present: true })
  }
  return edits
}

const inMemory = (runtime: Runtime): Record<PrivacyList, readonly string[]> => ({
  excludePatterns: runtime.config.digest.excludePatterns,
  localOnlyPatterns: runtime.config.localOnlyPatterns,
})

/** Deletes what is stored under these ids, unless something is running (then it is deferred). Returns whether it ran. */
export function purgeNow(host: Pick<AliasHost, 'runtime' | 'isBusy' | 'deferPurge'>, ids: readonly string[]): boolean {
  if (ids.length === 0) return true
  // Only what is excluded in the unit's memory NOW is deleted: a mark that is not in force would be a deletion without it.
  const covered = ids.filter((id) => hasIdPattern(host.runtime.config.digest.excludePatterns, id))
  if (host.isBusy()) {
    host.deferPurge(covered)
    return false
  }
  // Synchronous from the check to the end: a digest cannot start in between.
  const purge = new SqliteConversationPurge(host.runtime.db)
  for (const id of covered) purge.purge(id)
  return true
}

/**
 * A person can be stored under two ids (a LID and the phone number: WhatsApp gives a chat the LID until the number is
 * known). The privacy marks name an id (`id:<id>`), so when the platform says that two ids are one person, a mark of one
 * is put on the other, in the account's file, and applied before anything else is stored for either.
 *
 * - The decision is taken INSIDE the serialized write, from the files as they are then, so an un-mark that just landed is
 *   respected. The in-memory configuration is only a cheap first look (the many pairs of a history sync that touch no mark
 *   cost nothing); `force` skips it (a retry).
 * - It does not fail open: when the file cannot be written (invalid, edited meanwhile, IO) or the reload did not apply it,
 *   the marks are put in force in memory (`applyInMemory`) and `written` is false, so the host writes them again later.
 * - What is already stored under an id that gained an EXCLUDED mark is deleted, as marking the chat does, unless a digest or
 *   a preview is running: then the deletion is deferred, never dropped.
 *
 * Remaining race, accepted: a pair learned in the instants between the web writing a mark and the unit applying it is not
 * seen by the first look (the configuration in memory is the old one); the web also writes the aliases it knows when it
 * marks, and the next start looks at every pair again, so the gap closes at the latest then.
 */
export async function coverAlias(
  host: AliasHost,
  a: string,
  b: string,
  options: { readonly force?: boolean } = {},
): Promise<CoverResult> {
  const first = decide(inMemory(host.runtime), a, b)
  if (first.length === 0 && options.force !== true) return { added: 0, written: true }
  let decided: PrivacyEdit[] = []
  let written = false
  try {
    const result = await editAccountPrivacyLists({
      rootFile: host.layout.configFile,
      accountFile: host.account.configFile,
      edits: (inForce) => {
        decided = decide(inForce, a, b)
        return decided
      },
    })
    written = result.ok
  } catch {
    written = false
  }
  // Written: what the files say is what counts. Not written: what memory says (stricter than nothing).
  const edits = written ? decided : first
  if (edits.length === 0) return { added: 0, written }
  if (written) await host.reload()
  const missing = edits.filter((edit) => !hasIdPattern(inMemory(host.runtime)[edit.list], edit.id))
  if (missing.length > 0) host.applyInMemory(missing)
  purgeNow(
    host,
    edits.filter((edit) => edit.list === 'excludePatterns').map((edit) => edit.id),
  )
  return { added: edits.length, written }
}
