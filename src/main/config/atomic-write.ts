import { randomBytes } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { syncDirectory, writeDurably } from './config-writer.js'

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 5
const RENAME_PAUSE_MS = 25

/**
 * On Windows a rename over a file that a reader (a poll, an antivirus, `msum status`) holds open fails for a moment
 * with EPERM, EBUSY or EACCES. Retrying a few times keeps the write, and so a ban marker, from being lost to a race.
 * When the attempts run out the last error is thrown.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= RENAME_ATTEMPTS || code === undefined || !RETRYABLE.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, RENAME_PAUSE_MS * attempt))
    }
  }
}

/**
 * Replaces `file` with `text` so a reader sees either the old content or the new one, never an empty or half-written
 * file: written and synced under an unpredictable name in the same directory (mode 0600), then renamed over `file`.
 * When anything fails the temporary file is removed and `file` is left as it was. The directory is synced after the
 * rename so the replacement survives a crash.
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeDurably(temporary, text)
    await renameWithRetry(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  // After the rename (and outside the cleanup above): the new directory entry reaches the disk, so a power cut right
  // after a block cannot leave the old state in its place.
  await syncDirectory(dirname(file))
}
