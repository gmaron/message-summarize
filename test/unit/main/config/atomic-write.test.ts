import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isWindows } from '../../../support/platform.js'

// `rename` can be made to fail: that is the moment between "written aside" and "in place".
// `renameTimes` 0 means every attempt fails; otherwise only the first `renameTimes` do.
const failing = vi.hoisted(() => ({ renameCode: '', renameTimes: 0, renames: 0, write: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (failing.renameCode) {
        failing.renames++
        if (failing.renameTimes === 0 || failing.renames <= failing.renameTimes) {
          throw Object.assign(new Error('busy'), { code: failing.renameCode })
        }
      }
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

const { readBlocked, writeBlocked } = await import('../../../../src/main/installation/blocked.js')
const { writeFileAtomic } = await import('../../../../src/main/config/atomic-write.js')

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msum-atomic-'))
  failing.renameCode = ''
  failing.renameTimes = 0
  failing.renames = 0
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
    failing.renameCode = 'EBUSY'
    await expect(writeFileAtomic(file, 'new\n')).rejects.toMatchObject({ code: 'EBUSY' })
    expect(failing.renames).toBe(5)
    expect(readFileSync(file, 'utf8')).toBe('old\n')
    expect(readdirSync(dir)).toEqual(['x.json'])
  })

  it.each(['EPERM', 'EBUSY', 'EACCES'])(
    'retries the rename after a passing %s and writes the new content',
    async (code) => {
      const file = join(dir, 'x.json')
      writeFileSync(file, 'old\n')
      failing.renameCode = code
      failing.renameTimes = 3
      await writeFileAtomic(file, 'new\n')
      expect(failing.renames).toBe(4)
      expect(readFileSync(file, 'utf8')).toBe('new\n')
      expect(readdirSync(dir)).toEqual(['x.json'])
    },
  )

  it('does not retry an error that is not a passing lock', async () => {
    const file = join(dir, 'x.json')
    failing.renameCode = 'ENOSPC'
    await expect(writeFileAtomic(file, 'new\n')).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(failing.renames).toBe(1)
    expect(readdirSync(dir)).toEqual([])
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
