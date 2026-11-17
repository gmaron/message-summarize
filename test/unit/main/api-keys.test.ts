import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  envNames,
  InvalidSecretsFileError,
  listStoredProviders,
  readKeysSync,
  removeApiKey,
  resolveApiKey,
  storeApiKey,
} from '../../../src/infrastructure/secrets/index.js'

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'msum-keys-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('storing keys (RNF-04)', () => {
  it('writes the file with mode 0600 and leaves no temporary file behind', async () => {
    const file = join(tmp(), 'sub', 'secrets.json')
    await storeApiKey(file, 'openai', 'key-one')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ openai: 'key-one' })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(file, '..'))).toEqual(['secrets.json'])
  })

  it('tightens a file that already existed with looser permissions', async () => {
    const dir = tmp()
    const file = join(dir, 'secrets.json')
    writeFileSync(file, '{}', { mode: 0o644 })
    await storeApiKey(file, 'gemini', 'key-two')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps the other keys, and replaces the one that is set again', async () => {
    const file = join(tmp(), 'secrets.json')
    await storeApiKey(file, 'openai', 'a')
    await storeApiKey(file, 'anthropic', 'b')
    await storeApiKey(file, 'openai', 'c')
    expect(readKeysSync(file)).toEqual({ openai: 'c', anthropic: 'b' })
    expect(await listStoredProviders(file)).toEqual(['openai', 'anthropic'])
  })

  it('removes a key, and says when there was none', async () => {
    const file = join(tmp(), 'secrets.json')
    await storeApiKey(file, 'openai', 'a')
    expect(await removeApiKey(file, 'openai')).toBe(true)
    expect(await removeApiKey(file, 'openai')).toBe(false)
    expect(await removeApiKey(join(tmp(), 'nothing.json'), 'gemini')).toBe(false)
    expect(readKeysSync(file)).toEqual({})
  })

  it('never overwrites a file that is not a JSON object', async () => {
    const dir = tmp()
    const file = join(dir, 'secrets.json')
    writeFileSync(file, 'not json')
    await expect(storeApiKey(file, 'openai', 'x')).rejects.toBeInstanceOf(InvalidSecretsFileError)
    writeFileSync(file, '[]')
    await expect(removeApiKey(file, 'openai')).rejects.toBeInstanceOf(InvalidSecretsFileError)
    expect(readFileSync(file, 'utf8')).toBe('[]')
  })

  it('reads no keys from a missing or broken file, and ignores values that are not text', () => {
    const dir = tmp()
    expect(readKeysSync(join(dir, 'missing.json'))).toEqual({})
    const file = join(dir, 'secrets.json')
    writeFileSync(file, JSON.stringify({ openai: '', anthropic: 5, gemini: 'g', other: 'x' }))
    expect(readKeysSync(file)).toEqual({ gemini: 'g' })
    writeFileSync(file, '{broken')
    expect(readKeysSync(file)).toEqual({})
  })
})

describe('resolveApiKey: the environment, then the account file, then the installation file', () => {
  const setup = async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'acc'))
    const file = join(dir, 'secrets.json')
    const accountFile = join(dir, 'acc', 'secrets.json')
    await storeApiKey(file, 'anthropic', 'from-file')
    return { file, accountFile }
  }

  it('uses the installation file when nothing else has a key', async () => {
    const { file, accountFile } = await setup()
    expect(resolveApiKey('anthropic', { env: {}, file, accountFile })).toEqual({
      key: 'from-file',
      source: { kind: 'file', file },
    })
  })

  it('the file of the account wins over the one of the installation', async () => {
    const { file, accountFile } = await setup()
    await storeApiKey(accountFile, 'anthropic', 'from-account')
    expect(resolveApiKey('anthropic', { env: {}, file, accountFile })?.source).toEqual({
      kind: 'accountFile',
      file: accountFile,
    })
  })

  it('the environment wins over both', async () => {
    const { file, accountFile } = await setup()
    await storeApiKey(accountFile, 'anthropic', 'from-account')
    expect(resolveApiKey('anthropic', { env: { ANTHROPIC_API_KEY: 'from-env' }, file, accountFile })).toEqual({
      key: 'from-env',
      source: { kind: 'env', name: 'ANTHROPIC_API_KEY' },
    })
  })

  it('has no key when there is none anywhere (an empty variable does not count)', async () => {
    const { file } = await setup()
    expect(resolveApiKey('gemini', { env: { GEMINI_API_KEY: '' }, file })).toBeNull()
  })

  it('names the variables: one per key, openai and openai-compatible apart', () => {
    expect(envNames('gemini')).toEqual(['GEMINI_API_KEY'])
    expect(envNames('anthropic')).toEqual(['ANTHROPIC_API_KEY'])
    expect(envNames('openai')).toEqual(['OPENAI_API_KEY'])
    expect(envNames('openai-compatible')).toEqual(['MSUM_OPENAI_API_KEY'])
  })

  it('the openai and openai-compatible keys never answer for each other, in the environment or in files', async () => {
    const { file, accountFile } = await setup()
    await storeApiKey(file, 'openai', 'real-openai-key')
    await storeApiKey(accountFile, 'openai', 'account-openai-key')
    const env = { OPENAI_API_KEY: 'env-openai-key' }
    expect(resolveApiKey('openai-compatible', { env, file, accountFile })).toBeNull()
    await storeApiKey(file, 'openai-compatible', 'other-server-key')
    expect(resolveApiKey('openai-compatible', { env, file, accountFile })?.key).toBe('other-server-key')
    expect(resolveApiKey('openai', { env: { MSUM_OPENAI_API_KEY: 'x-key-123456' }, file })?.key).toBe('real-openai-key')
  })
})
