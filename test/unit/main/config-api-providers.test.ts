import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import { describeConfigIssue, loadEffectiveConfig, mergeConfigJson, parseConfig } from '../../../src/main/config.js'

const parse = (input: Record<string, unknown>) => parseConfig(input, 'UTC')
const issues = (input: Record<string, unknown>) => {
  const result = parse(input)
  return result.ok ? [] : result.error
}

describe('API providers in the configuration (RF-40)', () => {
  it('accepts openai, anthropic and gemini as the primary and the backup', () => {
    for (const primary of ['openai', 'anthropic', 'gemini']) {
      const result = parse({ provider: { primary, backup: 'claude-cli', [primary]: { model: 'm' } } })
      expect(result.ok).toBe(true)
    }
  })

  it('has sensible defaults for everything but the model', () => {
    const result = parse({})
    if (!result.ok) throw new Error('invalid')
    expect(result.value.provider.openai).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      model: null,
      timeoutMs: 180_000,
      structuredOutput: 'json_schema',
    })
    expect(result.value.provider.anthropic).toEqual({
      model: null,
      timeoutMs: 180_000,
      maxTokens: 16_000,
      effort: null,
    })
    expect(result.value.provider.gemini).toEqual({ model: null, timeoutMs: 180_000 })
    expect(result.value.provider.retry).toEqual({
      maxRetries: 3,
      maxWaitMs: 120_000,
      maxTotalMs: 300_000,
    })
  })

  it('reads the options of each provider and the retry budget', () => {
    const result = parse({
      provider: {
        primary: 'openai',
        backup: 'anthropic',
        openai: { model: 'gpt', baseUrl: 'http://localhost:1234/v1', timeoutMs: 5000, structuredOutput: 'prompt' },
        anthropic: { model: 'claude', maxTokens: 999, timeoutMs: 7000, effort: 'low' },
        retry: { maxRetries: 0, maxWaitMs: 30_000, maxTotalMs: 60_000 },
      },
    })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.value.provider.openai).toEqual({
      baseUrl: 'http://localhost:1234/v1',
      model: 'gpt',
      timeoutMs: 5000,
      structuredOutput: 'prompt',
    })
    expect(result.value.provider.anthropic).toEqual({
      model: 'claude',
      timeoutMs: 7000,
      maxTokens: 999,
      effort: 'low',
    })
    expect(result.value.provider.retry).toEqual({ maxRetries: 0, maxWaitMs: 30_000, maxTotalMs: 60_000 })
  })

  it.each(['openai', 'anthropic', 'gemini'])(
    'there is no default model: choosing %s without one is an error',
    (kind) => {
      expect(issues({ provider: { primary: kind } })).toEqual([{ option: `provider.${kind}.model`, code: 'required' }])
      // as the backup too
      expect(issues({ provider: { primary: 'claude-cli', backup: kind } })).toEqual([
        { option: `provider.${kind}.model`, code: 'required' },
      ])
    },
  )

  it('does not ask for the model of a provider that is not used', () => {
    expect(parse({ provider: { primary: 'claude-cli', openai: { baseUrl: 'http://x' } } }).ok).toBe(true)
  })

  it('the missing-model error has a clear message in English and Spanish', () => {
    const [issue] = issues({ provider: { primary: 'gemini' } })
    expect(issue && describeConfigIssue(getCatalog('en'), issue)).toBe('The option "provider.gemini.model" is missing.')
    expect(issue && describeConfigIssue(getCatalog('es'), issue)).toBe('Falta la opción "provider.gemini.model".')
  })

  it.each(['apiKey', 'api_key', 'key', 'token', 'secret'])(
    'refuses a key in config.json (%s), and says where it goes',
    (name) => {
      const found = issues({ provider: { primary: 'openai', openai: { model: 'm', [name]: 'sk-whatever' } } })
      expect(found).toEqual([{ option: `provider.openai.${name}`, code: 'secretInConfig' }])
      const first = found[0]
      expect(first && describeConfigIssue(getCatalog('en'), first)).toContain('msum secret set')
      expect(first && describeConfigIssue(getCatalog('es'), first)).toContain('msum secret set')
      // the text never repeats the value
      expect(JSON.stringify(found)).not.toContain('sk-whatever')
    },
  )

  it('refuses a key in the section of each API provider', () => {
    for (const kind of ['openai', 'anthropic', 'gemini']) {
      expect(issues({ provider: { [kind]: { apiKey: 'x' } } })).toEqual([
        { option: `provider.${kind}.apiKey`, code: 'secretInConfig' },
      ])
    }
  })

  it('reports invalid values with the option that holds them', () => {
    expect(issues({ provider: { openai: { structuredOutput: 'magic' } } })).toEqual([
      {
        option: 'provider.openai.structuredOutput',
        code: 'notOneOf',
        allowed: ['json_schema', 'json_object', 'prompt'],
      },
    ])
    expect(issues({ provider: { anthropic: { effort: 'turbo' } } })).toEqual([
      {
        option: 'provider.anthropic.effort',
        code: 'notOneOf',
        allowed: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ])
    expect(issues({ provider: { anthropic: { maxTokens: 0 } } })).toEqual([
      { option: 'provider.anthropic.maxTokens', code: 'notPositive' },
    ])
    expect(issues({ provider: { retry: { maxRetries: -1 } } })).toEqual([
      { option: 'provider.retry.maxRetries', code: 'notPositive' },
    ])
    expect(issues({ provider: { gemini: { model: 5 } } })).toEqual([
      { option: 'provider.gemini.model', code: 'notString' },
    ])
    expect(issues({ provider: { gemini: { colour: 'red' } } })).toEqual([
      { option: 'provider.gemini.colour', code: 'unknownOption' },
    ])
    expect(issues({ provider: { primary: 'cohere' } })[0]?.code).toBe('notOneOf')
  })
})

describe('the options of an account over those of the installation', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('merges each API section key by key, so an account can change its model and keep the rest', () => {
    const merged = mergeConfigJson(
      {
        provider: {
          primary: 'openai',
          openai: { baseUrl: 'http://a/v1', model: 'm1', timeoutMs: 1000 },
          retry: { maxRetries: 5 },
        },
      },
      { provider: { openai: { model: 'm2' }, anthropic: { model: 'c' }, retry: { maxWaitMs: 9000 } } },
    )
    expect(merged.provider).toEqual({
      primary: 'openai',
      openai: { baseUrl: 'http://a/v1', model: 'm2', timeoutMs: 1000 },
      anthropic: { model: 'c' },
      retry: { maxRetries: 5, maxWaitMs: 9000 },
    })
  })

  it('an account can choose its own provider, and the model is still required', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'msum-cfg-'))
    dirs.push(dir)
    const root = join(dir, 'config.json')
    const account = join(dir, 'account.json')
    writeFileSync(root, JSON.stringify({ provider: { primary: 'claude-cli', gemini: { model: 'g1' } } }))
    writeFileSync(account, JSON.stringify({ provider: { primary: 'gemini' } }))
    const loaded = await loadEffectiveConfig(root, account, 'UTC')
    expect(loaded.ok && loaded.value.provider.gemini.model).toBe('g1')

    writeFileSync(account, JSON.stringify({ provider: { primary: 'anthropic' } }))
    const broken = await loadEffectiveConfig(root, account, 'UTC')
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.error[0]).toMatchObject({ option: 'provider.anthropic.model', code: 'required' })
  })
})
