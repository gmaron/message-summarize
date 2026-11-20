import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isWindows } from '../../support/platform.js'

// `rename` can be made to fail: that is the moment between "written aside" and "in place".
const failing = vi.hoisted(() => ({ rename: false, write: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (failing.rename) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return actual.rename(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (!failing.write) return handle
      // The write dies half way: some bytes are in the temporary file, then the call fails.
      const writeFile = handle.writeFile.bind(handle)
      handle.writeFile = (async (data: string) => {
        await writeFile(String(data).slice(0, 3))
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      }) as typeof handle.writeFile
      return handle
    },
  }
})

const { readBlocked, writeBlocked } = await import('../../../src/main/blocked.js')
const { writeFileAtomic } = await import('../../../src/main/atomic-write.js')

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msum-atomic-'))
  failing.rename = false
  failing.write = false
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temporary file, private to the user', async () => {
    const file = join(dir, 'x.json')
    writeFileSync(file, 'old\n')
    await writeFileAtomic(file, 'new\n')
    expect(readFileSync(file, 'utf8')).toBe('new\n')
    expect(readdirSync(dir)).toEqual(['x.json'])
    if (!isWindows) expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps the old content and removes the temporary file when the rename fails', async () => {
    const file = join(dir, 'x.json')
    writeFileSync(file, 'old\n')
    failing.rename = true
    await expect(writeFileAtomic(file, 'new\n')).rejects.toMatchObject({ code: 'EBUSY' })
    expect(readFileSync(file, 'utf8')).toBe('old\n')
    expect(readdirSync(dir)).toEqual(['x.json'])
  })

  it('keeps the old content, and never shows a partial file, when the write dies half way', async () => {
    const file = join(dir, 'x.json')
    writeFileSync(file, 'old\n')
    failing.write = true
    await expect(writeFileAtomic(file, 'new content\n')).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(readFileSync(file, 'utf8')).toBe('old\n')
    expect(readdirSync(dir)).toEqual(['x.json'])
  })

  it('does not create a file that was not there when the write fails', async () => {
    failing.write = true
    await expect(writeFileAtomic(join(dir, 'y.json'), 'abcdef')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('writeBlocked', () => {
  it('keeps a block with its reason and time when a rewrite fails: it is never read as notLinked', async () => {
    const file = join(dir, 'blocked.json')
    await writeBlocked(file, 'forbidden', 1234)
    failing.write = true
    await expect(writeBlocked(file, 'replaced', 5678)).rejects.toThrow()
    expect(await readBlocked(file)).toEqual({ reason: 'forbidden', at: 1234 })
    expect(readdirSync(dir)).toEqual(['blocked.json'])
  })

  it('still counts an unreadable marker as blocked, and a missing one as not blocked', async () => {
    const file = join(dir, 'blocked.json')
    expect(await readBlocked(file)).toBeNull()
    writeFileSync(file, '')
    expect(await readBlocked(file)).toEqual({ reason: 'notLinked', at: 0 })
    rmSync(file)
    mkdirSync(file) // a read error that is not ENOENT (EISDIR)
    expect(await readBlocked(file)).toEqual({ reason: 'notLinked', at: 0 })
  })
})
