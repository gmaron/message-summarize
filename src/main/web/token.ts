import { randomBytes } from 'node:crypto'
import { chmod, link, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { type DataLayout, FILE_MODE } from '../installation/paths.js'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** The secret as stored, or null when the file is missing or does not hold one this program wrote. */
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
export const ensureWebToken = (layout: Pick<DataLayout, 'webTokenFile'>): Promise<string> =>
  ensureSecret(layout.webTokenFile)

/**
 * The secret behind the session cookies of the web: generated once, kept in `web-session` with mode 0600 (RNF-04) and
 * reused by every run of the daemon, so a restart does not end the sessions. Deleting the file (and restarting) ends
 * all of them. Never logged.
 */
export const ensureWebSession = (layout: Pick<DataLayout, 'webSessionFile'>): Promise<string> =>
  ensureSecret(layout.webSessionFile)

async function ensureSecret(file: string): Promise<string> {
  const existing = await readToken(file)
  if (existing !== null) {
    if (process.platform !== 'win32') await chmod(file, FILE_MODE)
    return existing
  }
  const token = randomBytes(32).toString('base64url')
  // Written complete under another name and then linked into place: a reader never sees half a token, and of several
  // callers at once exactly one link succeeds, so they all end up with the same token.
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, `${token}\n`, { mode: FILE_MODE })
  try {
    try {
      await link(temp, file)
      return token
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    // Someone got there first: theirs wins when valid. A file with anything else in it is replaced.
    const raced = await readToken(file)
    if (raced !== null) return raced
    await rename(temp, file)
    return token
  } finally {
    await rm(temp, { force: true })
  }
}
