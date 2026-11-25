import { afterEach, describe, expect, it, vi } from 'vitest'
import { runMain } from '../../../../src/main/app.js'
import { disposeHarnesses, type Harness, makeHarness } from '../../../support/cli-harness.js'

afterEach(() => {
  vi.restoreAllMocks()
  disposeHarnesses()
})

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const providerLines = (h: Harness) => h.out.filter((line) => line.includes('LLM provider')).join('\n')

describe('msum doctor with an API provider (no network call)', () => {
  it('fails when there is no key, and says how to set it', async () => {
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: 'anthropic', anthropic: { model: 'claude-x' } } },
    })
    expect(await run(h, 'doctor')).toBe(1)
    expect(providerLines(h)).toContain('[fail] LLM provider: no "anthropic" API key for anthropic')
    expect(h.out.join('\n')).toContain('msum secret set anthropic')
    expect(h.out.join('\n')).toContain('ANTHROPIC_API_KEY')
  })

  it('passes with a key from the environment, and says where it came from but never what it is', async () => {
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: 'gemini', gemini: { model: 'gemini-x' } } },
      env: { GEMINI_API_KEY: 'super-secret-gemini-value' },
    })
    await run(h, 'doctor')
    expect(providerLines(h)).toContain(
      '[ok]   LLM provider: gemini (model gemini-x; uses the "gemini" key, from environment (GEMINI_API_KEY))',
    )
    expect([...h.out, ...h.err].join('\n')).not.toContain('super-secret')
  })

  it('passes with a key saved with msum secret set, and the account one wins', async () => {
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: 'openai', openai: { model: 'gpt-x' } } },
      secretInput: 'saved-openai-key-123',
    })
    await run(h, 'secret', 'set', 'openai')
    await run(h, 'doctor')
    expect(providerLines(h)).toMatch(
      /\[ok\] {3}LLM provider: openai \(model gpt-x; uses the "openai" key, from file \(/,
    )
    expect(h.out.join('\n')).not.toContain('saved-openai-key')
  })

  it('does not require a key for an OpenAI-compatible server of its own', async () => {
    const h = await makeHarness({
      config: {
        language: 'en',
        provider: { primary: 'openai', openai: { model: 'local', baseUrl: 'http://localhost:1234/v1' } },
      },
    })
    await run(h, 'doctor')
    expect(providerLines(h)).toContain('[ok]   LLM provider: openai (model local; no "openai-compatible" key')
  })

  it('tells which stored key the configuration uses: openai-compatible for a custom baseUrl, never the openai one', async () => {
    const h = await makeHarness({
      config: {
        language: 'en',
        provider: { primary: 'openai', openai: { model: 'local', baseUrl: 'http://localhost:1234/v1' } },
      },
      secretInput: 'stored-openai-key-123',
    })
    await run(h, 'secret', 'set', 'openai')
    await run(h, 'doctor')
    expect(providerLines(h)).toContain('no "openai-compatible" key')
    h.out.length = 0
    await run(h, 'secret', 'set', 'openai-compatible')
    await run(h, 'doctor')
    expect(providerLines(h)).toContain('uses the "openai-compatible" key, from file')
  })

  it('fails when the file of API keys can be read by other users, and says how to fix it', async () => {
    const { chmodSync } = await import('node:fs')
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: 'gemini', gemini: { model: 'g' } } },
      secretInput: 'a-gemini-key-0000',
    })
    await run(h, 'secret', 'set', 'gemini')
    await run(h, 'secret', 'set', 'gemini', '--account', 'default')
    h.out.length = 0
    await run(h, 'doctor')
    expect(h.out.join('\n')).not.toContain('API keys file')

    if (process.platform === 'win32') return
    chmodSync(h.layout.secretsFile, 0o644)
    chmodSync(h.account.secretsFile, 0o640)
    h.out.length = 0
    await run(h, 'doctor')
    const text = h.out.join('\n')
    expect(text).toContain(`[fail] API keys file: ${h.layout.secretsFile} has permissions 644`)
    expect(text).toContain(`[fail] API keys file: ${h.account.secretsFile} has permissions 640`)
    expect(text).toContain(`chmod 600 ${h.layout.secretsFile}`)
    expect(text).not.toContain('a-gemini-key')
  })

  it('does not take OPENAI_API_KEY for a server that is not OpenAI, and says which variable would work', async () => {
    const h = await makeHarness({
      config: {
        language: 'en',
        provider: { primary: 'openai', openai: { model: 'local', baseUrl: 'http://localhost:1234/v1' } },
      },
      env: { OPENAI_API_KEY: 'my-openai-key-0000' },
    })
    await run(h, 'doctor')
    expect(providerLines(h)).toContain('no "openai-compatible" key')
    expect(providerLines(h)).not.toContain('OPENAI_API_KEY')
  })

  it('requires the key for api.openai.com itself', async () => {
    const h = await makeHarness({
      config: { language: 'es', provider: { primary: 'openai', openai: { model: 'gpt-x' } } },
    })
    expect(await run(h, 'doctor')).toBe(1)
    expect(h.out.join('\n')).toContain('no hay clave de API "openai" para openai')
  })

  it('reports the missing model as a configuration error', async () => {
    const h = await makeHarness({ config: { language: 'en', provider: { primary: 'openai' } } })
    expect(await run(h, 'doctor')).toBe(1)
    expect(h.out.join('\n')).toContain('"provider.openai.model" is missing')
  })

  it('never calls a provider, a CLI or an Ollama server', async () => {
    const calls: string[] = []
    const h = await makeHarness({
      config: {
        language: 'en',
        provider: { primary: 'gemini', backup: 'anthropic', gemini: { model: 'g' }, anthropic: { model: 'a' } },
      },
      env: { GEMINI_API_KEY: 'k-gemini-0000000', ANTHROPIC_API_KEY: 'k-anthropic-00000' },
      probes: {
        commandVersion: async () => {
          calls.push('cli')
          return null
        },
        ollamaReachable: async () => {
          calls.push('ollama')
          return false
        },
      },
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await run(h, 'doctor')
    expect(calls).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(providerLines(h)).toContain('gemini')
    expect(providerLines(h)).toContain('anthropic')
  })
})
