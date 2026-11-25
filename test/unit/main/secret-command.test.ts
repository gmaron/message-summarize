import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCommandLine } from '../../../src/interfaces/cli/args.js'
import { runMain } from '../../../src/main/app.js'
import { secretCommand } from '../../../src/main/commands/secret.js'
import { disposeHarnesses, makeHarness } from '../../support/cli-harness.js'

afterEach(disposeHarnesses)

const KEY = 'sk-proj-ABCDEFGHIJKLMNOP1234'

const everythingPrinted = (h: { out: string[]; err: string[]; logs: string[] }) =>
  [...h.out, ...h.err, ...h.logs].join('\n')

describe('msum secret set (RNF-04)', () => {
  it('saves the key read from the input in <dataDir>/secrets.json with mode 0600, and never prints it', async () => {
    const h = await makeHarness({ secretInput: `${KEY}\n` })
    expect(await secretCommand(h.ctx, { name: 'secret', action: 'set', provider: 'openai', account: null })).toBe(0)
    expect(JSON.parse(readFileSync(h.layout.secretsFile, 'utf8'))).toEqual({ openai: KEY })
    if (process.platform !== 'win32') expect(statSync(h.layout.secretsFile).mode & 0o777).toBe(0o600)
    expect(everythingPrinted(h)).not.toContain(KEY)
    expect(everythingPrinted(h)).not.toContain('ABCDEFGH')
    expect(h.out.join('\n')).toContain(h.layout.secretsFile)
    expect(h.questions[0]).toContain('openai')
  })

  it('with --account it writes the file of that account, not the installation one', async () => {
    const h = await makeHarness({ secretInput: KEY, accounts: ['default', 'work'] })
    expect(await secretCommand(h.ctx, { name: 'secret', action: 'set', provider: 'gemini', account: 'work' })).toBe(0)
    const accountFile = h.accountOf('work').secretsFile
    expect(JSON.parse(readFileSync(accountFile, 'utf8'))).toEqual({ gemini: KEY })
    if (process.platform !== 'win32') expect(statSync(accountFile).mode & 0o777).toBe(0o600)
    expect(() => statSync(h.layout.secretsFile)).toThrow()
  })

  it('refuses an account that does not exist', async () => {
    const h = await makeHarness({ secretInput: KEY })
    expect(await secretCommand(h.ctx, { name: 'secret', action: 'set', provider: 'openai', account: 'nope' })).toBe(2)
    expect(h.err.join('\n')).toContain('nope')
    expect(everythingPrinted(h)).not.toContain(KEY)
  })

  it('saves nothing for an empty input or a key with spaces inside, and does not echo what it got', async () => {
    const empty = await makeHarness({ secretInput: '  \n' })
    expect(await secretCommand(empty.ctx, { name: 'secret', action: 'set', provider: 'openai', account: null })).toBe(1)
    expect(() => statSync(empty.layout.secretsFile)).toThrow()

    const spaced = await makeHarness({ secretInput: 'sk-one sk-two' })
    expect(await secretCommand(spaced.ctx, { name: 'secret', action: 'set', provider: 'openai', account: null })).toBe(
      1,
    )
    expect(() => statSync(spaced.layout.secretsFile)).toThrow()
    expect(everythingPrinted(spaced)).not.toContain('sk-one')
  })

  it('does not touch a secrets file that is not a JSON object', async () => {
    const h = await makeHarness({ secretInput: KEY })
    writeFileSync(h.layout.secretsFile, 'precious')
    expect(await secretCommand(h.ctx, { name: 'secret', action: 'set', provider: 'openai', account: null })).toBe(1)
    expect(readFileSync(h.layout.secretsFile, 'utf8')).toBe('precious')
    expect(everythingPrinted(h)).not.toContain(KEY)
  })

  it('warns when a variable of the environment will win over the saved key, without printing the variable', async () => {
    const h = await makeHarness({ secretInput: KEY, env: { ANTHROPIC_API_KEY: 'env-key-value-123' } })
    await secretCommand(h.ctx, { name: 'secret', action: 'set', provider: 'anthropic', account: null })
    expect(h.out.join('\n')).toContain('ANTHROPIC_API_KEY')
    expect(everythingPrinted(h)).not.toContain('env-key-value-123')
  })

  it.each(['', ' \n'])('does not warn about a variable with nothing but white space (%j)', async (blank) => {
    const h = await makeHarness({ secretInput: KEY, env: { ANTHROPIC_API_KEY: blank } })
    expect(await secretCommand(h.ctx, { name: 'secret', action: 'set', provider: 'anthropic', account: null })).toBe(0)
    expect(h.out.join('\n')).not.toContain('ANTHROPIC_API_KEY')
  })

  it('leaves only secrets.json in the data directory (the write is atomic: no temporary file stays)', async () => {
    const h = await makeHarness({ secretInput: KEY })
    await secretCommand(h.ctx, { name: 'secret', action: 'set', provider: 'openai', account: null })
    expect(readdirSync(h.layout.dataDir).filter((name) => name.includes('secrets'))).toEqual(['secrets.json'])
  })

  it('speaks Spanish when the configuration says so', async () => {
    const h = await makeHarness({ secretInput: KEY, config: { language: 'es' } })
    await secretCommand(h.ctx, { name: 'secret', action: 'set', provider: 'openai', account: null })
    expect(h.out.join('\n')).toContain('se guardó')
  })
})

describe('msum secret rm', () => {
  it('removes a key and says so, and says so when there was none', async () => {
    const h = await makeHarness({ secretInput: KEY })
    await secretCommand(h.ctx, { name: 'secret', action: 'set', provider: 'openai', account: null })
    h.out.length = 0
    expect(await secretCommand(h.ctx, { name: 'secret', action: 'rm', provider: 'openai', account: null })).toBe(0)
    expect(h.out.join('\n')).toContain('removed')
    expect(JSON.parse(readFileSync(h.layout.secretsFile, 'utf8'))).toEqual({})
    h.out.length = 0
    expect(await secretCommand(h.ctx, { name: 'secret', action: 'rm', provider: 'openai', account: null })).toBe(0)
    expect(h.out.join('\n')).toContain('no key')
  })
})

describe('msum secret ls', () => {
  it('shows which providers have a key and where it comes from, never a value or a part of it', async () => {
    const h = await makeHarness({
      secretInput: KEY,
      accounts: ['default', 'work'],
      env: { GEMINI_API_KEY: 'gemini-env-value-999' },
    })
    await secretCommand(h.ctx, { name: 'secret', action: 'set', provider: 'openai', account: null })
    await secretCommand(h.ctx, { name: 'secret', action: 'set', provider: 'anthropic', account: 'work' })
    h.out.length = 0

    expect(await secretCommand(h.ctx, { name: 'secret', action: 'ls', account: null })).toBe(0)
    const installation = h.out.join('\n')
    expect(installation).toMatch(/openai\s+file \(/)
    expect(installation).toMatch(/anthropic\s+no key/)
    expect(installation).toMatch(/gemini\s+environment \(GEMINI_API_KEY\)/)

    h.out.length = 0
    await secretCommand(h.ctx, { name: 'secret', action: 'ls', account: 'work' })
    const account = h.out.join('\n')
    expect(account).toMatch(/anthropic\s+account file \(/)
    expect(account).toMatch(/openai\s+file \(/)

    for (const printed of [installation, account, everythingPrinted(h)]) {
      expect(printed).not.toContain(KEY)
      expect(printed).not.toContain('ABCDEFGH')
      expect(printed).not.toContain('gemini-env')
    }
  })

  it('works with no file at all', async () => {
    const h = await makeHarness()
    expect(await secretCommand(h.ctx, { name: 'secret', action: 'ls', account: null })).toBe(0)
    expect(h.out.filter((line) => line.includes('no key'))).toHaveLength(4)
    for (const name of ['openai', 'openai-compatible', 'anthropic', 'gemini']) {
      expect(h.out.some((line) => line.trimStart().startsWith(name))).toBe(true)
    }
    expect(join(h.layout.dataDir)).toBeTruthy()
  })
})

describe('msum secret through the whole CLI', () => {
  it('a key typed as an argument is refused with exit 2 and nothing printed contains it', async () => {
    const h = await makeHarness()
    for (const argv of [
      ['secret', 'set', KEY],
      ['secret', 'set', 'openai', KEY],
      ['secret', `--api-key=${KEY}`],
    ]) {
      expect(await runMain(argv, h.ctx)).toBe(2)
    }
    expect(everythingPrinted(h)).not.toContain(KEY)
    expect(() => statSync(h.layout.secretsFile)).toThrow()
  })

  it('set, ls and rm work end to end, and the help lists them', async () => {
    const h = await makeHarness({ secretInput: KEY })
    expect(await runMain(['secret', 'set', 'anthropic'], h.ctx)).toBe(0)
    expect(await runMain(['secret', 'ls'], h.ctx)).toBe(0)
    expect(h.out.join('\n')).toMatch(/anthropic\s+file/)
    expect(await runMain(['secret', 'rm', 'anthropic'], h.ctx)).toBe(0)
    await runMain(['help'], h.ctx)
    expect(h.out.join('\n')).toContain('secret set <provider>')
    expect(everythingPrinted(h)).not.toContain(KEY)
  })
})

describe('msum secret: the arguments', () => {
  it('takes the provider, never the key', () => {
    expect(parseCommandLine(['secret', 'set', 'openai'])).toEqual({
      ok: true,
      value: { name: 'secret', action: 'set', provider: 'openai', account: null },
    })
    expect(parseCommandLine(['secret', 'rm', 'gemini', '--account', 'work'])).toEqual({
      ok: true,
      value: { name: 'secret', action: 'rm', provider: 'gemini', account: 'work' },
    })
    expect(parseCommandLine(['secret', 'ls'])).toEqual({
      ok: true,
      value: { name: 'secret', action: 'ls', account: null },
    })
    expect(parseCommandLine(['secret'])).toEqual({ ok: true, value: { name: 'secret', action: 'ls', account: null } })
  })

  it('a key typed as an argument is refused and never echoed back', () => {
    const asProvider = parseCommandLine(['secret', 'set', KEY])
    expect(asProvider).toEqual({ ok: false, error: { kind: 'unknownProvider' } })
    const asExtra = parseCommandLine(['secret', 'set', 'openai', KEY])
    expect(asExtra.ok).toBe(false)
    expect(JSON.stringify(asProvider)).not.toContain(KEY)
    expect(JSON.stringify(asExtra)).not.toContain(KEY)
  })

  it('rejects a missing provider, an unknown subcommand and --key style options', () => {
    expect(parseCommandLine(['secret', 'set'])).toEqual({
      ok: false,
      error: { kind: 'missingValue', value: '<provider>' },
    })
    expect(parseCommandLine(['secret', 'show']).ok).toBe(false)
    expect(parseCommandLine(['secret', 'set', 'openai', '--key']).ok).toBe(false)
    expect(parseCommandLine(['secret', 'ls', 'extra']).ok).toBe(false)
  })
})
