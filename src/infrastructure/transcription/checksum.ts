import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/** SHA-256 of a file, lowercase hexadecimal, read as a stream (a model can be 3 GB). Rejects when it cannot be read. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
