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

  it('creates the directory of the file private to the owner (mode 0700)', async () => {
    const dir = join(tmp(), 'accounts', 'one')
    await storeApiKey(join(dir, 'secrets.json'), 'openai', 'key-one')
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700)
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

describe('what is read from a secrets file that is not well formed (RNF-04)', () => {
  it.each([
    ['an array', '[{"openai":"k"}]'],
    ['a string', '"openai"'],
    ['null', 'null'],
    ['a number', '5'],
    ['an empty file', ''],
    ['keys that are not text', '{"openai":{"key":"k"},"anthropic":["k"],"gemini":null,"openai-compatible":true}'],
  ])('%s has no keys, and is not an error to read', (_name, content) => {
    const file = join(tmp(), 'secrets.json')
    writeFileSync(file, content)
    expect(readKeysSync(file)).toEqual({})
    expect(resolveApiKey('openai', { env: {}, file })).toBeNull()
  })

  it.each([
    ['a string', '"openai"'],
    ['a number', '5'],
    ['null', 'null'],
    ['an array', '[]'],
    ['text that is not JSON', 'openai=k'],
  ])('storing, removing or listing refuses %s and leaves it as it was', async (_name, content) => {
    const file = join(tmp(), 'secrets.json')
    writeFileSync(file, content)
    await expect(storeApiKey(file, 'openai', 'new-key-value')).rejects.toBeInstanceOf(InvalidSecretsFileError)
    await expect(removeApiKey(file, 'openai')).rejects.toBeInstanceOf(InvalidSecretsFileError)
    await expect(listStoredProviders(file)).rejects.toBeInstanceOf(InvalidSecretsFileError)
    expect(readFileSync(file, 'utf8')).toBe(content)
  })

  it('a path that cannot be read for another reason than not existing is an error, never an empty file to overwrite', async () => {
    const dir = tmp()
    const asDirectory = join(dir, 'secrets.json')
    mkdirSync(asDirectory)
    await expect(storeApiKey(asDirectory, 'openai', 'k')).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(removeApiKey(asDirectory, 'openai')).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(listStoredProviders(asDirectory)).rejects.toMatchObject({ code: 'EISDIR' })
    // nothing was written or replaced: it is still the same empty directory
    expect(statSync(asDirectory).isDirectory()).toBe(true)
    expect(readdirSync(asDirectory)).toEqual([])
    expect(readdirSync(dir)).toEqual(['secrets.json'])
  })

  it('a file that does not exist lists no providers', async () => {
    expect(await listStoredProviders(join(tmp(), 'nothing.json'))).toEqual([])
  })

  it('lists only the providers that have a key, in the order of the providers', async () => {
    const file = join(tmp(), 'secrets.json')
    writeFileSync(file, JSON.stringify({ gemini: 'g', openai: '', anthropic: 'a', other: 'x' }))
    expect(await listStoredProviders(file)).toEqual(['anthropic', 'gemini'])
  })

  it('a removal keeps the other keys and the unknown fields of the file', async () => {
    const file = join(tmp(), 'secrets.json')
    writeFileSync(file, JSON.stringify({ openai: 'o', gemini: 'g', note: 'keep me' }))
    expect(await removeApiKey(file, 'openai')).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ gemini: 'g', note: 'keep me' })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('a key that is an empty string counts as no key to remove', async () => {
    const file = join(tmp(), 'secrets.json')
    writeFileSync(file, JSON.stringify({ openai: '' }))
    expect(await removeApiKey(file, 'openai')).toBe(false)
  })
})

describe('resolveApiKey, the details', () => {
  it.each(['', ' ', '\t', '\n', ' \t\r\n '])(
    'an environment key of only white space (%j) is no key at all',
    async (blank) => {
      const directory = tmp()
      const file = join(directory, 'secrets.json')
      const accountFile = join(directory, 'account-secrets.json')
      const env = { GEMINI_API_KEY: blank }
      expect(resolveApiKey('gemini', { env, file, accountFile })).toBeNull()
      await storeApiKey(file, 'gemini', 'installation-value')
      expect(resolveApiKey('gemini', { env, file, accountFile })).toEqual({
        key: 'installation-value',
        source: { kind: 'file', file },
      })
      await storeApiKey(accountFile, 'gemini', 'account-value')
      expect(resolveApiKey('gemini', { env, file, accountFile })).toEqual({
        key: 'account-value',
        source: { kind: 'accountFile', file: accountFile },
      })
    },
  )

  it('trims what comes from the environment (a pasted key often ends in a line break)', () => {
    const file = join(tmp(), 'secrets.json')
    expect(resolveApiKey('gemini', { env: { GEMINI_API_KEY: '  plain-key-value\n' }, file })).toEqual({
      key: 'plain-key-value',
      source: { kind: 'env', name: 'GEMINI_API_KEY' },
    })
  })

  it('a broken file of the account, or one with an empty key, falls through to the installation file', async () => {
    const dir = tmp()
    const file = join(dir, 'secrets.json')
    const accountFile = join(dir, 'account-secrets.json')
    await storeApiKey(file, 'anthropic', 'from-installation')
    writeFileSync(accountFile, '{broken')
    expect(resolveApiKey('anthropic', { env: {}, file, accountFile })).toEqual({
      key: 'from-installation',
      source: { kind: 'file', file },
    })
    writeFileSync(accountFile, JSON.stringify({ anthropic: '' }))
    expect(resolveApiKey('anthropic', { env: {}, file, accountFile })?.source).toEqual({ kind: 'file', file })
    expect(resolveApiKey('anthropic', { env: {}, file, accountFile: undefined })?.source).toEqual({
      kind: 'file',
      file,
    })
  })

  it('without an account file, a missing installation file means no key', () => {
    expect(resolveApiKey('openai', { env: {}, file: join(tmp(), 'missing.json') })).toBeNull()
  })

  it('the key of the result never appears in its source', async () => {
    const file = join(tmp(), 'secrets.json')
    await storeApiKey(file, 'openai', 'never-in-the-source-value')
    const found = resolveApiKey('openai', { env: {}, file })
    expect(JSON.stringify(found?.source)).not.toContain('never-in-the-source-value')
  })
})
