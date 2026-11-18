import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEffectiveConfig } from '../../../src/main/config.js'
import { updateAccountConfig } from '../../../src/main/config-writer.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function files(root: Record<string, unknown> | string = { timezone: 'UTC', provider: { primary: 'claude-cli' } }) {
  const dir = mkdtempSync(join(tmpdir(), 'msum-writer-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'accounts', 'alpha'), { recursive: true })
  const rootFile = join(dir, 'config.json')
  const accountFile = join(dir, 'accounts', 'alpha', 'config.json')
  writeFileSync(rootFile, typeof root === 'string' ? root : JSON.stringify(root))
  return {
    dir,
    rootFile,
    accountFile,
    account: () => JSON.parse(readFileSync(accountFile, 'utf8')) as Record<string, unknown>,
  }
}

describe('updateAccountConfig (RF-73)', () => {
  it('creates the account file with mode 0600 and returns the effective configuration', async () => {
    const f = files()
    const result = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { unreadOnly: true, 'provider.claudeCli.model': 'opus' },
    })
    expect(result.ok && result.value.digest.unreadOnly).toBe(true)
    expect(result.ok && result.value.provider.claudeCli.model).toBe('opus')
    expect(f.account()).toEqual({ unreadOnly: true, provider: { claudeCli: { model: 'opus' } } })
    expect(statSync(f.accountFile).mode & 0o777).toBe(0o600)
    // The installation's file is never touched.
    expect(JSON.parse(readFileSync(f.rootFile, 'utf8'))).toEqual({
      timezone: 'UTC',
      provider: { primary: 'claude-cli' },
    })
    // What was written loads the same way.
    const loaded = await loadEffectiveConfig(f.rootFile, f.accountFile)
    expect(loaded.ok && loaded.value.provider.claudeCli.model).toBe('opus')
  })

  it('keeps the other keys of the account file, the privacy lists included', async () => {
    const f = files()
    writeFileSync(
      f.accountFile,
      JSON.stringify({ localOnlyPatterns: ['Family'], excludePatterns: ['Spam'], promptFile: 'p.txt' }),
    )
    // The lists need an Ollama model to be valid at all: a patch that does not give one is refused, and nothing changes.
    const refused = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { language: 'es' },
    })
    expect(!refused.ok && refused.error[0]).toMatchObject({ option: 'provider.ollama.model', code: 'required' })
    expect(f.account()).toEqual({ localOnlyPatterns: ['Family'], excludePatterns: ['Spam'], promptFile: 'p.txt' })
    const written = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { language: 'es', 'provider.ollama.model': 'llama3' },
    })
    expect(written.ok).toBe(true)
    expect(f.account()).toEqual({
      localOnlyPatterns: ['Family'],
      excludePatterns: ['Spam'],
      promptFile: 'p.txt',
      language: 'es',
      provider: { ollama: { model: 'llama3' } },
    })
  })

  it('writes nothing for an invalid result and says which option and why', async () => {
    const f = files()
    writeFileSync(f.accountFile, JSON.stringify({ hideRest: true }))
    const before = readFileSync(f.accountFile, 'utf8')
    const result = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: {
        timezone: 'Mars/Olympus',
        language: 'fr',
        maxCharsPerConversation: 0,
        defaultWindowHours: -1,
        concurrency: 1.5,
        'provider.primary': 'gpt',
        ownerName: '',
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.map(({ option, code }) => ({ option, code }))).toEqual(
      expect.arrayContaining([
        { option: 'timezone', code: 'invalidTimezone' },
        { option: 'language', code: 'notOneOf' },
        { option: 'maxCharsPerConversation', code: 'notPositive' },
        { option: 'defaultWindowHours', code: 'notPositive' },
        { option: 'concurrency', code: 'notInteger' },
        { option: 'provider.primary', code: 'notOneOf' },
        { option: 'ownerName', code: 'emptyString' },
      ]),
    )
    expect(result.error.find((issue) => issue.option === 'language')?.allowed).toEqual(['es', 'en'])
    expect(readFileSync(f.accountFile, 'utf8')).toBe(before)
    expect(readdirSync(join(f.dir, 'accounts', 'alpha'))).toEqual(['config.json'])
  })

  it('validates the EFFECTIVE configuration: a backup needs a primary, Ollama needs a model', async () => {
    const f = files({ timezone: 'UTC' })
    const needsPrimary = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { 'provider.backup': 'claude-cli' },
    })
    expect(needsPrimary.ok).toBe(false)
    expect(!needsPrimary.ok && needsPrimary.error).toEqual([
      { option: 'provider.primary', code: 'required', file: f.rootFile },
    ])
    const needsModel = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { 'provider.primary': 'ollama' },
    })
    expect(!needsModel.ok && needsModel.error[0]).toMatchObject({ option: 'provider.ollama.model', code: 'required' })
    const good = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { 'provider.primary': 'ollama', 'provider.ollama.model': 'llama3' },
    })
    expect(good.ok).toBe(true)
  })

  it('removes an option with undefined, and a section that is left empty', async () => {
    const f = files()
    writeFileSync(
      f.accountFile,
      JSON.stringify({ unreadOnly: true, hideRest: true, provider: { claudeCli: { model: 'opus' } } }),
    )
    const result = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { unreadOnly: undefined, 'provider.claudeCli.model': undefined, 'provider.ollama.model': undefined },
    })
    expect(result.ok).toBe(true)
    expect(f.account()).toEqual({ hideRest: true })
  })

  it('stores a value equal to the installation one, and null as a value for the provider', async () => {
    const f = files({ timezone: 'UTC', provider: { primary: 'claude-cli' } })
    const result = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { timezone: 'UTC', 'provider.primary': null },
    })
    expect(result.ok && result.value.provider.primary).toBe(null)
    expect(f.account()).toEqual({ timezone: 'UTC', provider: { primary: null } })
  })

  it('does not rewrite an account file that is not valid JSON, nor accept a broken installation file', async () => {
    const f = files()
    writeFileSync(f.accountFile, '{ "unreadOnly": tru')
    const broken = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { hideRest: true },
    })
    expect(!broken.ok && broken.error).toEqual([{ option: '(config)', code: 'invalidJson', file: f.accountFile }])
    expect(readFileSync(f.accountFile, 'utf8')).toBe('{ "unreadOnly": tru')

    const g = files('not json')
    const root = await updateAccountConfig({
      rootFile: g.rootFile,
      accountFile: g.accountFile,
      patch: { hideRest: true },
    })
    expect(!root.ok && root.error[0]).toMatchObject({ code: 'invalidJson', file: g.rootFile })
  })

  it('refuses an account file that sets the web, and ignores keys that could poison a prototype', async () => {
    const f = files()
    writeFileSync(f.accountFile, JSON.stringify({ web: { port: 1 } }))
    const web = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { hideRest: true },
    })
    expect(!web.ok && web.error[0]).toMatchObject({ option: 'web', code: 'installationOnly' })
    writeFileSync(f.accountFile, '{}')
    const result = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { '__proto__.polluted': true, hideRest: true },
    })
    expect(result.ok).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(f.account()).toEqual({ hideRest: true })
  })

  it('serializes concurrent writes: none is lost', async () => {
    const f = files()
    const options = ['unreadOnly', 'flagUnsaved', 'hideRest'] as const
    const results = await Promise.all(
      options.map((option) =>
        updateAccountConfig({ rootFile: f.rootFile, accountFile: f.accountFile, patch: { [option]: true } }),
      ),
    )
    expect(results.every((result) => result.ok)).toBe(true)
    expect(f.account()).toEqual({ unreadOnly: true, flagUnsaved: true, hideRest: true })
    expect(readdirSync(join(f.dir, 'accounts', 'alpha'))).toEqual(['config.json'])
  })

  it('a failed write does not block the next one, and leaves no temporary file', async () => {
    const f = files()
    // The directory of the account does not exist: the write throws.
    const missing = join(f.dir, 'accounts', 'ghost', 'config.json')
    await expect(
      updateAccountConfig({ rootFile: f.rootFile, accountFile: missing, patch: { hideRest: true } }),
    ).rejects.toThrow()
    await expect(
      updateAccountConfig({ rootFile: f.rootFile, accountFile: missing, patch: { hideRest: true } }),
    ).rejects.toThrow()
    const result = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { hideRest: true },
    })
    expect(result.ok).toBe(true)
  })

  it('refuses an Ollama address that is not an absolute http(s) URL, and accepts a remote one', async () => {
    const f = files()
    for (const value of ['ftp://host:1', 'localhost:11434', 'nope', '/local/socket']) {
      const result = await updateAccountConfig({
        rootFile: f.rootFile,
        accountFile: f.accountFile,
        patch: { 'provider.ollama.baseUrl': value },
      })
      expect(!result.ok && result.error[0], value).toMatchObject({
        option: 'provider.ollama.baseUrl',
        code: 'invalidUrl',
      })
    }
    const lan = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { 'provider.ollama.baseUrl': 'https://ollama.lan:11434' },
    })
    expect(lan.ok).toBe(true)
  })

  it('an edit by hand that lands while the update is under way is not lost: it reads and patches again', async () => {
    const f = files()
    writeFileSync(f.accountFile, JSON.stringify({ hideRest: true }))
    const attempts: number[] = []
    const result = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { unreadOnly: true },
      beforeCommit: (attempt) => {
        attempts.push(attempt)
        // The user saves the file in their editor, once, between the read and the rename.
        if (attempt === 1)
          writeFileSync(f.accountFile, JSON.stringify({ hideRest: true, flagUnsaved: true, ownerName: 'Test' }))
      },
    })
    expect(result.ok).toBe(true)
    expect(attempts).toEqual([1, 2])
    expect(f.account()).toEqual({ hideRest: true, flagUnsaved: true, ownerName: 'Test', unreadOnly: true })
    expect(readdirSync(join(f.dir, 'accounts', 'alpha'))).toEqual(['config.json'])
  })

  it('gives up with concurrentEdit when the file keeps changing, writing nothing and leaving the hand edit', async () => {
    const f = files()
    writeFileSync(f.accountFile, JSON.stringify({ hideRest: true }))
    let n = 0
    const result = await updateAccountConfig({
      rootFile: f.rootFile,
      accountFile: f.accountFile,
      patch: { unreadOnly: true },
      beforeCommit: () => {
        n++
        writeFileSync(f.accountFile, JSON.stringify({ hideRest: true, ownerName: 'x'.repeat(n) }))
      },
    })
    expect(!result.ok && result.error).toEqual([{ option: '(config)', code: 'concurrentEdit', file: f.accountFile }])
    expect(f.account()).toEqual({ hideRest: true, ownerName: 'xx' })
    expect(readdirSync(join(f.dir, 'accounts', 'alpha'))).toEqual(['config.json'])
  })
})
