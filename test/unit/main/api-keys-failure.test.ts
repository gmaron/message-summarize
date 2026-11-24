import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The write of a secrets file is a temporary file and a rename. When the rename fails, the temporary file (which holds
// the keys) must not be left behind, and the file that was there must stay as it was (RNF-04).
const failing = vi.hoisted(() => ({ rename: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (failing.rename) throw new Error('rename refused')
      return actual.rename(...args)
    },
  }
})

const { removeApiKey, storeApiKey } = await import('../../../src/infrastructure/secrets/index.js')

const dirs: string[] = []
afterEach(() => {
  failing.rename = false
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'msum-keys-fail-'))
  dirs.push(dir)
  return dir
}

describe('a write of the secrets file that fails half way (RNF-04)', () => {
  it('leaves no temporary file with the keys, reports the error, and keeps the old file', async () => {
    const dir = tmp()
    const file = join(dir, 'secrets.json')
    writeFileSync(file, JSON.stringify({ openai: 'old-key-value' }))
    failing.rename = true
    await expect(storeApiKey(file, 'anthropic', 'new-key-value')).rejects.toThrow('rename refused')
    expect(readdirSync(dir)).toEqual(['secrets.json'])
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify({ openai: 'old-key-value' }))
  })

  it('the same for a removal, and for a file in a directory that had to be created', async () => {
    const dir = tmp()
    const file = join(dir, 'secrets.json')
    writeFileSync(file, JSON.stringify({ openai: 'old-key-value' }))
    failing.rename = true
    await expect(removeApiKey(file, 'openai')).rejects.toThrow('rename refused')
    expect(readdirSync(dir)).toEqual(['secrets.json'])
    const nested = join(dir, 'new', 'secrets.json')
    await expect(storeApiKey(nested, 'openai', 'a-key-value')).rejects.toThrow('rename refused')
    expect(readdirSync(join(dir, 'new'))).toEqual([])
  })
})
