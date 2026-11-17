import { randomBytes } from 'node:crypto'
import { chmod, link, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { type DataLayout, FILE_MODE } from './paths.js'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** The token as stored, or null when the file is missing or does not hold a token this program wrote. */
async function readToken(file: string): Promise<string | null> {
  try {
    const text = (await readFile(file, 'utf8')).trim()
    return TOKEN_PATTERN.test(text) ? text : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * The access token of the local web (RNF-03): 32 random bytes in base64url, generated once per installation and kept in
 * `web-token` with mode 0600 (RNF-04). An existing token is reused (and its mode tightened if it was looser); a file
 * with anything else in it is replaced. The token is a secret: callers never log it.
 */
export async function ensureWebToken(layout: Pick<DataLayout, 'webTokenFile'>): Promise<string> {
  const existing = await readToken(layout.webTokenFile)
  if (existing !== null) {
    if (process.platform !== 'win32') await chmod(layout.webTokenFile, FILE_MODE)
    return existing
  }
  const token = randomBytes(32).toString('base64url')
  // Written complete under another name and then linked into place: a reader never sees half a token, and of several
  // callers at once exactly one link succeeds, so they all end up with the same token.
  const temp = `${layout.webTokenFile}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, `${token}\n`, { mode: FILE_MODE })
  try {
    try {
      await link(temp, layout.webTokenFile)
      return token
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    // Someone got there first: theirs wins when valid. A file with anything else in it is replaced.
    const raced = await readToken(layout.webTokenFile)
    if (raced !== null) return raced
    await rename(temp, layout.webTokenFile)
    return token
  } finally {
    await rm(temp, { force: true })
  }
}
