import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { type DataLayout, FILE_MODE } from '../installation/paths.js'

/** Where the web of the running daemon listens, as bound. */
export interface WebAddress {
  readonly host: string
  readonly port: number
}

/**
 * Records where the web really listens (`web.json`), mode 0600 and written atomically. `msum open` trusts this and
 * nothing else (not the configuration: the port may be held by another program, or the web may be off), and only
 * while a live daemon holds the lock; the daemon removes the file when the web stops and when it exits.
 */
export async function writeWebAddress(layout: Pick<DataLayout, 'webAddressFile'>, address: WebAddress): Promise<void> {
  const temp = `${layout.webAddressFile}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, `${JSON.stringify({ host: address.host, port: address.port })}\n`, { mode: FILE_MODE })
  try {
    await rename(temp, layout.webAddressFile)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export async function removeWebAddress(layout: Pick<DataLayout, 'webAddressFile'>): Promise<void> {
  await rm(layout.webAddressFile, { force: true })
}

/** The recorded address, or null when there is none or it is not valid. */
export async function readWebAddress(layout: Pick<DataLayout, 'webAddressFile'>): Promise<WebAddress | null> {
  try {
    const data = JSON.parse(await readFile(layout.webAddressFile, 'utf8')) as { host?: unknown; port?: unknown }
    if (
      typeof data.host === 'string' &&
      data.host !== '' &&
      typeof data.port === 'number' &&
      Number.isInteger(data.port) &&
      data.port >= 1 &&
      data.port <= 65535
    ) {
      return { host: data.host, port: data.port }
    }
  } catch {
    // missing or not complete: no address
  }
  return null
}
