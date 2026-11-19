import { randomBytes } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { writeDurably } from './config-writer.js'

/**
 * Replaces `file` with `text` so a reader sees either the old content or the new one, never an empty or half-written
 * file: written and synced under an unpredictable name in the same directory (mode 0600), then renamed over `file`.
 * When anything fails the temporary file is removed and `file` is left as it was.
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeDurably(temporary, text)
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
