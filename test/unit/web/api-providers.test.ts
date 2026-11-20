import { describe, expect, it } from 'vitest'
import { webEn } from '../../../src/infrastructure/i18n/web-en.js'
import { webEs } from '../../../src/infrastructure/i18n/web-es.js'
import { PROVIDER_INFO } from '../../../src/infrastructure/llm/index.js'
import { ApiError, createApi } from '../../../src/interfaces/web/lib/api.js'
import {
  API_PROVIDERS,
  consentAddress,
  destinationId,
  destinationOf,
  disclosureOf,
  displayHostOf,
  isHttpUrl,
  isOpenAiUrl,
  keyNameOf,
  OPENAI_ORIGIN,
  openaiTarget,
  providerOfConsentKey,
  withTypedKey,
} from '../../../src/interfaces/web/lib/api-providers.js'
import { inheritsWhenEmpty } from '../../../src/interfaces/web/lib/settings.js'
import {
  consentKeyOf,
  emptyDraft,
  openaiAddressInvalid,
  openaiUrlOf,
  providerBody,
  providerIssue,
  providerOptions,
  recipientOf,
  shownOriginOf,
  testBody,
  type WizardDraft,
  withBaseUrl,
  withOpenAiBaseUrl,
} from '../../../src/interfaces/web/lib/setup.js'
import { fakeFetch } from './support.js'

const draft = (over: Partial<WizardDraft> = {}): WizardDraft => ({ ...emptyDraft('en'), ...over })
const openai = (over: Partial<WizardDraft> = {}): WizardDraft =>
  draft({ provider: 'openai', openaiModel: 'gpt-test', ...over })

describe('who gets the text and the key (OpenAI, Anthropic, Gemini)', () => {
  it('tells OpenAI itself from any other server by origin, and an empty address is OpenAI', () => {
    expect(isOpenAiUrl('')).toBe(true)
    expect(isOpenAiUrl('https://api.openai.com/v1')).toBe(true)
    expect(isOpenAiUrl('https://api.openai.com')).toBe(true)
    expect(isOpenAiUrl('http://localhost:1234/v1')).toBe(false)
    expect(isOpenAiUrl('https://api.openai.com.evil.example/v1')).toBe(false)
    expect(isOpenAiUrl('not a url')).toBe(false)
  })

  it('names the key by the address: openai for OpenAI itself, openai-compatible for any other, even on this machine', () => {
    expect(keyNameOf('openai', '')).toBe('openai')
    expect(keyNameOf('openai', 'https://api.openai.com/v1')).toBe('openai')
    expect(keyNameOf('openai', 'http://127.0.0.1:1234/v1')).toBe('openai-compatible')
    expect(keyNameOf('anthropic', 'http://127.0.0.1:1234/v1')).toBe('anthropic')
    expect(keyNameOf('gemini', '')).toBe('gemini')
    expect(API_PROVIDERS).toEqual(['openai', 'anthropic', 'gemini'])
  })

  it('asks for the agreement of OpenAI itself with the key openai and of a compatible server with openai-compatible', () => {
    expect(consentKeyOf(openai())).toBe('openai')
    expect(consentKeyOf(openai({ openaiBaseUrl: 'https://api.openai.com/v1' }))).toBe('openai')
    expect(consentKeyOf(openai({ openaiBaseUrl: 'http://localhost:1234/v1' }))).toBe('openai-compatible')
    expect(consentKeyOf(draft({ provider: 'anthropic', anthropicModel: 'm' }))).toBe('anthropic')
    expect(consentKeyOf(draft({ provider: 'gemini', geminiModel: 'm' }))).toBe('gemini')
  })

  it('counts the address in force when the field is empty (a server set in the installation is still external)', () => {
    const inherited = openai({ openaiInherited: 'http://10.0.0.7:8000/v1' })
    expect(openaiUrlOf(inherited)).toBe('http://10.0.0.7:8000/v1')
    expect(consentKeyOf(inherited)).toBe('openai-compatible')
    expect(consentKeyOf({ ...inherited, openaiBaseUrl: 'https://api.openai.com/v1' })).toBe('openai')
  })

  it('maps a consent key back to the provider whose notice applies', () => {
    expect(providerOfConsentKey('openai-compatible')).toBe('openai')
    expect(providerOfConsentKey('ollama-remote')).toBe('ollama')
    expect(providerOfConsentKey('gemini')).toBe('gemini')
    expect(providerOfConsentKey('nope')).toBeNull()
    expect(disclosureOf('openai-compatible')).toEqual({ provider: 'openai', compatible: true })
    expect(disclosureOf('anthropic')).toEqual({ provider: 'anthropic', compatible: false })
  })

  it('is another recipient when the server changes, even with the same key, and then forgets the agreement', () => {
    const a = openai({ openaiBaseUrl: 'http://localhost:1234/v1', consent: true })
    expect(recipientOf('openai', '', 'http://localhost:1234/v1')).toBe('openai-compatible|http://localhost:1234')
    expect(withOpenAiBaseUrl(a, 'http://localhost:1234/other/path').consent).toBe(true)
    expect(withOpenAiBaseUrl(a, 'http://localhost:9999/v1').consent).toBe(false)
    expect(withOpenAiBaseUrl(a, 'https://openrouter.example/v1').consent).toBe(false)
    // From a server back to OpenAI itself: another recipient too.
    expect(withOpenAiBaseUrl(a, '').consent).toBe(false)
    // A remote Ollama behaves the same.
    const remote = draft({
      provider: 'ollama',
      ollamaModel: 'm',
      ollamaBaseUrl: 'http://10.0.0.5:11434',
      consent: true,
    })
    expect(withBaseUrl(remote, 'http://10.0.0.6:11434').consent).toBe(false)
  })
})

describe('the bodies the wizard sends for an API provider', () => {
  it('needs a model, and sends the agreement as the key of the recipient the user saw', () => {
    expect(providerIssue(openai({ openaiModel: ' ', consent: true }))).toBe('apiModel')
    expect(providerIssue(openai())).toBe('consent')
    expect(providerIssue(openai({ consent: true }))).toBeNull()
    expect(providerBody(openai({ consent: true }))).toEqual({
      from: 'provider',
      provider: 'openai',
      options: { model: 'gpt-test' },
      consent: 'openai',
    })
    expect(providerBody(openai({ openaiBaseUrl: ' http://localhost:1234/v1 ', consent: true }))).toEqual({
      from: 'provider',
      provider: 'openai',
      options: { baseUrl: 'http://localhost:1234/v1', model: 'gpt-test' },
      consent: 'openai-compatible',
    })
    expect(providerBody(openai())).not.toHaveProperty('consent')
  })

  it('sends a baseUrl only for OpenAI: Anthropic and Gemini have a fixed host', () => {
    const typedElsewhere = { openaiBaseUrl: 'http://localhost:1234/v1' }
    expect(providerOptions(draft({ provider: 'anthropic', anthropicModel: 'claude-test', ...typedElsewhere }))).toEqual(
      {
        model: 'claude-test',
      },
    )
    expect(providerOptions(draft({ provider: 'gemini', geminiModel: 'gemini-test', ...typedElsewhere }))).toEqual({
      model: 'gemini-test',
    })
  })

  it('never puts a key in the body that saves the step, and tests with the key of the recipient it is for', () => {
    const base = testBody(openai({ consent: true }))
    expect(base).toEqual({ provider: 'openai', options: { model: 'gpt-test' }, consent: 'openai' })
    expect(JSON.stringify(providerBody(openai({ consent: true })))).not.toContain('key')

    const official = destinationOf('openai', openaiUrlOf(openai()))
    expect(withTypedKey(base, 'openai', official, ' sk-test-123 ')).toEqual({
      ...base,
      key: 'sk-test-123',
      keyProvider: 'openai',
    })
    const compat = openai({ openaiBaseUrl: 'http://localhost:1234/v1', consent: true })
    expect(withTypedKey(testBody(compat), 'openai', destinationOf('openai', openaiUrlOf(compat)), 'k1')).toMatchObject({
      key: 'k1',
      keyProvider: 'openai-compatible',
    })
    // Anthropic and Gemini have one key each: no keyProvider.
    const anthropic = draft({ provider: 'anthropic', anthropicModel: 'm', consent: true })
    const sent = withTypedKey(testBody(anthropic), 'anthropic', destinationOf('anthropic', ''), 'k2')
    expect(sent).toMatchObject({ key: 'k2' })
    expect(sent).not.toHaveProperty('keyProvider')
    // Nothing typed, nothing sent.
    expect(withTypedKey(base, 'openai', official, '   ')).toBe(base)
  })

  it('tells when the recipient of a typed key changed, so the page empties it instead of sending it elsewhere', () => {
    const a = destinationId(destinationOf('openai', 'http://localhost:1234/v1'))
    expect(destinationId(destinationOf('openai', 'http://localhost:1234/other'))).toBe(a)
    expect(destinationId(destinationOf('openai', 'http://localhost:9999/v1'))).not.toBe(a)
    expect(destinationId(destinationOf('openai', ''))).not.toBe(a)
    expect(destinationId(destinationOf('gemini', ''))).not.toBe(destinationId(destinationOf('anthropic', '')))
  })
})

describe('the calls for the keys and the test', () => {
  const keys = {
    openai: { present: false },
    'openai-compatible': { present: false },
    anthropic: { present: false },
    gemini: { present: false },
  }

  it('send the key only in the body of the call that stores it, never in the address', async () => {
    const { fetchFn, calls } = fakeFetch({
      'GET /api/accounts/alpha/keys': { body: { keys } },
      'PUT /api/accounts/alpha/keys/openai-compatible': {
        body: { stored: true, key: { present: true, source: 'env', name: 'MSUM_OPENAI_API_KEY' }, overriddenBy: 'env' },
      },
      'DELETE /api/accounts/alpha/keys/gemini': { body: { removed: true, key: { present: false } } },
    })
    const api = createApi(fetchFn)
    expect(await api.keys('alpha')).toEqual(keys)
    const stored = await api.saveKey('alpha', 'openai-compatible', 'sk-secret-xyz')
    expect(stored.overriddenBy).toBe('env')
    expect(await api.removeKey('alpha', 'gemini')).toEqual({ removed: true, key: { present: false } })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/accounts/alpha/keys',
      'PUT /api/accounts/alpha/keys/openai-compatible',
      'DELETE /api/accounts/alpha/keys/gemini',
    ])
    expect(calls[1]?.body).toEqual({ key: 'sk-secret-xyz' })
    expect(calls.some((c) => c.path.includes('sk-secret'))).toBe(false)
    expect(calls[0]?.body).toBeUndefined()
  })

  it('say why a key was refused, by code', async () => {
    const { fetchFn } = fakeFetch({
      'PUT /api/accounts/alpha/keys/openai': { status: 400, body: { error: 'invalidKey' } },
      'PUT /api/accounts/alpha/keys/gemini': { status: 409, body: { error: 'invalidSecretsFile' } },
    })
    const api = createApi(fetchFn)
    await expect(api.saveKey('alpha', 'openai', 'a b')).rejects.toMatchObject({ status: 400, code: 'invalidKey' })
    await expect(api.saveKey('alpha', 'gemini', 'k')).rejects.toBeInstanceOf(ApiError)
    for (const texts of [webEn, webEs]) {
      expect(texts.errors.invalidKey).toBeTruthy()
      expect(texts.errors.invalidSecretsFile).toBeTruthy()
    }
  })

  it('keeps the recipient the daemon names when it refuses with 409 consentRequired', async () => {
    const { fetchFn } = fakeFetch({
      'PUT /api/setup': {
        status: 409,
        body: { error: 'consentRequired', provider: 'openai-compatible', origin: 'https://openrouter.example' },
      },
    })
    const error = await createApi(fetchFn)
      .saveSetup({ from: 'provider' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 409,
      code: 'consentRequired',
      provider: 'openai-compatible',
      origin: 'https://openrouter.example',
    })
  })

  it('send the typed key and its keyProvider to the test, and hand back each way it can fail', async () => {
    const results = [
      { ok: true, ms: 40 },
      { ok: false, error: 'noKey' },
      { ok: false, error: 'rejected' },
      { ok: false, error: 'apiUnreachable' },
    ]
    let n = 0
    const { fetchFn, calls } = fakeFetch({
      'POST /api/setup/test-provider': () => ({ body: results[n++] }),
    })
    const api = createApi(fetchFn)
    const body = {
      provider: 'openai',
      options: { model: 'm' },
      consent: 'openai',
      key: 'sk-test',
      keyProvider: 'openai',
    }
    expect(await api.testProvider(body)).toEqual({ ok: true, ms: 40 })
    expect(await api.testProvider(body)).toEqual({ ok: false, error: 'noKey' })
    expect(await api.testProvider(body)).toEqual({ ok: false, error: 'rejected' })
    expect(await api.testProvider(body)).toEqual({ ok: false, error: 'apiUnreachable' })
    expect(calls[0]?.body).toEqual(body)
  })
})

describe('the texts of the API providers (RF-41, RNF-02)', () => {
  for (const [name, texts] of [
    ['English', webEn],
    ['Spanish', webEs],
  ] as const) {
    it(`${name}: every API recipient says cost, data, to whom and what it does; Gemini adds the free-tier caution`, () => {
      const d = texts.ui.disclosure
      for (const kind of ['openai', 'openai-compatible', 'anthropic', 'gemini'] as const) {
        const info = d.providers[kind]
        for (const field of [info.name, info.cost, info.leaves, info.who, info.what]) expect(field).toBeTruthy()
      }
      expect(d.providers['openai-compatible'].leaves).toContain('{host}')
      expect(d.providers['openai-compatible'].who).toContain('{host}')
      expect(d.providers.gemini.warning).toMatch(/Google/)
      expect(d.providers.openai.warning).toBeUndefined()
      expect(d.apiLocalOnly).toMatch(/local/i)
      expect(d.consentChanged).toContain('{provider}')
      expect(d.keys.hint).toContain('{destination}')
      expect(d.keys.destinations.compatible).toContain('{host}')
      expect(d.keys.status.env).toContain('{name}')
      expect(d.keys.overriddenEnv).toContain('{name}')
    })

    it(`${name}: the settings and the test have text for each new provider and each way a test fails`, () => {
      for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
        expect(texts.ui.settings.providerNames[provider]).toBeTruthy()
      }
      expect(texts.ui.settings.privacySummary.openaiCompatible).toContain('{host}')
      for (const key of ['openaiModel', 'openaiBaseUrl', 'anthropicModel', 'geminiModel'] as const) {
        expect(texts.ui.settings.fields[key].label).toBeTruthy()
      }
      for (const code of ['noKey', 'rejected', 'apiUnreachable'] as const) {
        expect(texts.ui.disclosure.test.errors[code]).toBeTruthy()
      }
    })

    it(`${name}: the data policies named are the ones of the provider table`, () => {
      const d = texts.ui.disclosure.providers
      const bare = (url: string | null): string => (url ?? '').replace(/^https:\/\//, '')
      expect(d.openai.what).toContain(bare(PROVIDER_INFO.openai.policyUrl))
      expect(d.anthropic.what).toContain(bare(PROVIDER_INFO.anthropic.policyUrl))
      expect(d.gemini.what).toContain(bare(PROVIDER_INFO.gemini.policyUrl))
      expect(d.openai.who).toContain(PROVIDER_INFO.openai.hosts[0])
      expect(d.anthropic.who).toContain(PROVIDER_INFO.anthropic.hosts[0])
      expect(d.gemini.who).toContain(PROVIDER_INFO.gemini.hosts[0])
    })
  }
})

describe('the agreement is for what was shown, also with an empty address (RNF-02)', () => {
  const ROUTER = 'https://openrouter.example/api/v1'

  it('records a server by the origin the daemon named, never by what the field says; OpenAI by its own origin', () => {
    expect(consentAddress('openai-compatible', 'https://openrouter.example')).toBe('https://openrouter.example')
    expect(consentAddress('ollama-remote', 'http://10.0.0.5:11434')).toBe('http://10.0.0.5:11434')
    // Without the origin there is nothing to record: the daemon refuses it too, and the page does not invent one.
    expect(consentAddress('openai-compatible', undefined)).toBeUndefined()
    expect(consentAddress('openai', undefined)).toBe(OPENAI_ORIGIN)
    expect(consentAddress('openai', 'https://openrouter.example')).toBe(OPENAI_ORIGIN)
    expect(consentAddress('gemini', 'https://x.example')).toBeUndefined()
    expect(consentAddress('claude-cli', undefined)).toBeUndefined()
  })

  it('names the host with its port, so two servers on this machine are told apart', () => {
    expect(displayHostOf('http://localhost:1234/v1')).toBe('localhost:1234')
    expect(displayHostOf('http://localhost:9999/v1')).toBe('localhost:9999')
    expect(displayHostOf('nope')).toBeNull()
  })

  it('in the settings, an empty address is the installation one: seen when the account had none, unknown when it had its own', () => {
    // Typed: that one.
    expect(openaiTarget(' http://localhost:1234/v1 ', ROUTER, 'account')).toEqual({
      address: 'http://localhost:1234/v1',
      compatible: true,
    })
    expect(openaiTarget('https://api.openai.com/v1', ROUTER, 'account')).toEqual({
      address: 'https://api.openai.com/v1',
      compatible: false,
    })
    // Empty, and the value in force comes from the installation or the default: it stays (inherited compatible server).
    expect(openaiTarget('', ROUTER, 'installation')).toEqual({ address: ROUTER, compatible: true })
    expect(openaiTarget('', 'https://api.openai.com/v1', 'default')).toEqual({
      address: 'https://api.openai.com/v1',
      compatible: false,
    })
    // Empty, and the account had its own: removing it brings back one the page cannot see. No notice is made up for it.
    expect(openaiTarget('', 'http://localhost:1234/v1', 'account')).toEqual({ address: null, compatible: false })
  })

  it('says whether an empty field means "use the installation one": a model is required, an address explains itself', () => {
    expect(inheritsWhenEmpty('provider.openai.model')).toBe(false)
    expect(inheritsWhenEmpty('provider.anthropic.model')).toBe(false)
    expect(inheritsWhenEmpty('provider.gemini.model')).toBe(false)
    expect(inheritsWhenEmpty('provider.openai.baseUrl')).toBe(false)
    expect(inheritsWhenEmpty('provider.claudeCli.model')).toBe(true)
  })

  it('in the wizard, an address that is not a web address shows no recipient and does not let the step go on or be tested', () => {
    expect(isHttpUrl('http://localhost:1234/v1')).toBe(true)
    expect(isHttpUrl('ftp://example.com')).toBe(false)
    expect(isHttpUrl('localhost:1234')).toBe(false)
    expect(isHttpUrl('')).toBe(false)
    const bad = openai({ openaiBaseUrl: 'lm-studio', consent: true })
    expect(openaiAddressInvalid(bad)).toBe(true)
    expect(providerIssue(bad)).toBe('openaiAddress')
    expect(openaiAddressInvalid(openai({ openaiBaseUrl: 'http://localhost:1234/v1' }))).toBe(false)
    // Empty uses the address in force, which is a web address.
    expect(openaiAddressInvalid(openai())).toBe(false)
    expect(providerIssue(openai({ consent: true }))).toBeNull()
  })

  it('knows the origin shown, to tell a 409 that names another one', () => {
    expect(shownOriginOf(openai({ openaiBaseUrl: 'http://localhost:1234/v1' }))).toBe('http://localhost:1234')
    expect(shownOriginOf(openai({ openaiInherited: ROUTER }))).toBe('https://openrouter.example')
    expect(shownOriginOf(openai())).toBeNull()
    expect(shownOriginOf(draft({ provider: 'ollama', ollamaBaseUrl: 'http://10.0.0.5:11434' }))).toBe(
      'http://10.0.0.5:11434',
    )
    expect(shownOriginOf(draft({ provider: 'gemini' }))).toBeNull()
  })

  for (const [name, texts] of [
    ['English', webEn],
    ['Spanish', webEs],
  ] as const) {
    it(`${name}: the hints do not promise OpenAI for an empty address, and the neutral states have text`, () => {
      const hint = texts.ui.settings.fields.openaiBaseUrl.hint ?? ''
      const wizard = texts.ui.wizard.provider.openaiBaseUrlHint
      for (const text of [hint, wizard]) expect(text).toMatch(/instal/i)
      expect(texts.ui.wizard.provider.openaiBaseUrlInvalid).toMatch(/http/)
      expect(texts.ui.settings.privacySummary.openaiInherited).toBeTruthy()
      expect(texts.ui.settings.fields.openaiModel.hint).not.toMatch(/instal/i)
    })
  }
})
