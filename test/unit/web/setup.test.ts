import { afterEach, describe, expect, it } from 'vitest'
import { SETUP_STEPS } from '../../../src/domain/setup.js'
import { webEn } from '../../../src/infrastructure/i18n/web-en.js'
import { webEs } from '../../../src/infrastructure/i18n/web-es.js'
import { createApi } from '../../../src/interfaces/web/lib/api.js'
import { createController } from '../../../src/interfaces/web/lib/controller.js'
import { dayLabel } from '../../../src/interfaces/web/lib/schedules.js'
import {
  consentKeyOf,
  DEFAULT_OLLAMA_URL,
  emptyDraft,
  hostOf,
  nameBody,
  nameIssue,
  needsConsent,
  previousStep,
  providerBody,
  providerIssue,
  providerOptions,
  SUGGESTED_SCHEDULES,
  stepIndicator,
  testBody,
  WIZARD_PROVIDERS,
  type WizardDraft,
  withBaseUrl,
} from '../../../src/interfaces/web/lib/setup.js'
import { account, FakeEventSource, fakeFetch } from './support.js'

afterEach(() => {
  for (const source of FakeEventSource.all) source.close()
  FakeEventSource.all = []
})

const draft = (over: Partial<WizardDraft> = {}): WizardDraft => ({ ...emptyDraft('en'), ...over })

describe('the wizard logic', () => {
  it('lists every step numbered from 1 with what is behind, current and ahead', () => {
    const items = stepIndicator('provider')
    expect(items.map((item) => item.step)).toEqual([...SETUP_STEPS])
    expect(items.map((item) => item.number)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(items.map((item) => item.state)).toEqual(['done', 'done', 'current', 'todo', 'todo', 'todo', 'todo'])
  })

  it('goes back one step, and not before the first', () => {
    expect(previousStep('link')).toBe('transcription')
    expect(previousStep('language')).toBeNull()
  })

  it('checks the name as the daemon does', () => {
    expect(nameIssue(draft({ ownerName: '  ' }), false)).toBe('ownerBlank')
    expect(nameIssue(draft({ ownerName: 'x'.repeat(81) }), false)).toBe('ownerTooLong')
    expect(nameIssue(draft({ ownerName: 'Ana', accountId: 'Not Valid' }), false)).toBe('invalidAccountId')
    expect(nameIssue(draft({ ownerName: 'Ana', accountId: 'default' }), false)).toBeNull()
    // Once the account exists its id is not asked again.
    expect(nameIssue(draft({ ownerName: 'Ana', accountId: 'Not Valid' }), true)).toBeNull()
  })

  it('sends the id only while the account does not exist', () => {
    expect(nameBody(draft({ ownerName: ' Ana ', accountId: ' casa ' }), false)).toEqual({
      from: 'name',
      ownerName: 'Ana',
      accountId: 'casa',
    })
    expect(nameBody(draft({ ownerName: 'Ana' }), true)).toEqual({ from: 'name', ownerName: 'Ana' })
  })

  it('offers what exists today and says which needs the agreement', () => {
    expect(WIZARD_PROVIDERS).toEqual(['claude-cli', 'ollama'])
    expect(needsConsent('claude-cli')).toBe(true)
    expect(needsConsent('ollama')).toBe(false)
    expect(needsConsent('ollama-remote')).toBe(true)
  })

  it('needs a provider, the agreement for an external one and a model for Ollama', () => {
    expect(providerIssue(draft())).toBe('choose')
    expect(providerIssue(draft({ provider: 'claude-cli' }))).toBe('consent')
    expect(providerIssue(draft({ provider: 'claude-cli', consent: true }))).toBeNull()
    expect(providerIssue(draft({ provider: 'ollama' }))).toBe('ollamaModel')
    expect(providerIssue(draft({ provider: 'ollama', ollamaModel: 'qwen3:4b' }))).toBeNull()
  })

  it('asks for the agreement of a remote Ollama, and forgets one given for another recipient', () => {
    const remote = draft({ provider: 'ollama', ollamaModel: 'm', ollamaBaseUrl: 'http://10.0.0.5:11434' })
    expect(consentKeyOf(remote)).toBe('ollama-remote')
    expect(providerIssue(remote)).toBe('consent')
    expect(providerBody({ ...remote, consent: true })).toMatchObject({ consent: true })
    expect(hostOf(remote.ollamaBaseUrl)).toBe('10.0.0.5')
    expect(consentKeyOf(draft({ provider: 'ollama', ollamaModel: 'm' }))).toBeNull()
    const local = draft({ provider: 'ollama', ollamaModel: 'm', consent: true })
    expect(withBaseUrl(local, 'http://10.0.0.5:11434').consent).toBe(false)
    expect(withBaseUrl(local, 'http://127.0.0.1:9999').consent).toBe(true)
  })

  it('sends only what the user typed for the provider, and the agreement only when it is needed and given', () => {
    expect(providerOptions(draft({ provider: 'claude-cli', claudeModel: ' opus ' }))).toEqual({ model: 'opus' })
    expect(providerOptions(draft({ provider: 'claude-cli' }))).toEqual({})
    expect(providerOptions(draft({ provider: 'ollama', ollamaModel: 'm', ollamaBaseUrl: ' ' }))).toEqual({ model: 'm' })
    expect(providerBody(draft({ provider: 'claude-cli', consent: true }))).toEqual({
      from: 'provider',
      provider: 'claude-cli',
      options: {},
      consent: true,
    })
    expect(providerBody(draft({ provider: 'claude-cli' }))).not.toHaveProperty('consent')
    expect(providerBody(draft({ provider: 'ollama', ollamaModel: 'm', consent: true }))).toEqual({
      from: 'provider',
      provider: 'ollama',
      options: { baseUrl: DEFAULT_OLLAMA_URL, model: 'm' },
    })
    expect(testBody(draft({ provider: 'claude-cli', consent: true }))).toEqual({
      provider: 'claude-cli',
      options: {},
      consent: true,
    })
  })

  it('suggests 09:00 and 19:00 every day (RF-60)', () => {
    expect(SUGGESTED_SCHEDULES.map((one) => one.time)).toEqual(['09:00', '19:00'])
    for (const one of SUGGESTED_SCHEDULES) expect([...one.days]).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('says the days of a schedule in the language of the page', () => {
    expect(dayLabel([0, 1, 2, 3, 4, 5, 6], webEn)).toBe(webEn.ui.schedules.everyDay)
    expect(dayLabel([1, 2, 3, 4, 5], webEs)).toBe(webEs.ui.schedules.weekdays)
    expect(dayLabel([1, 3], webEn)).toMatch(/Mon.*Wed/)
  })
})

describe('the texts of the wizard and the disclosure (RF-41, RNF-02)', () => {
  for (const [name, texts] of [
    ['English', webEn],
    ['Spanish', webEs],
  ] as const) {
    it(`${name}: every step has a name, and every provider says cost, data, to whom and what it does`, () => {
      for (const step of SETUP_STEPS) expect(texts.ui.wizard.steps[step]).toBeTruthy()
      for (const provider of WIZARD_PROVIDERS) {
        const info = texts.ui.disclosure.providers[provider]
        for (const field of [info.name, info.cost, info.leaves, info.who, info.what]) expect(field).toBeTruthy()
      }
      // Claude runs without tools (RF-49) and says so; Ollama sends nothing out and says so.
      expect(texts.ui.disclosure.providers['claude-cli'].tools).toBeTruthy()
      expect(texts.ui.disclosure.providers.ollama.tools).toBeUndefined()
      expect(texts.ui.disclosure.consentCheckbox).toContain('{provider}')
      for (const code of ['notFound', 'timeout', 'invalidSummary', 'unreachable', 'failed'] as const) {
        expect(texts.ui.disclosure.test.errors[code]).toBeTruthy()
      }
      for (const code of ['consentRequired', 'notLinked', 'testRunning', 'setupCompleted', 'wrongStep'] as const) {
        expect(texts.errors[code]).toBeTruthy()
      }
    })
  }
})

type Answers = Parameters<typeof fakeFetch>[0]

const SETUP = { completed: false, step: 'name', account: null, linked: false, language: 'es', consents: [] }

function start(answers: Answers = {}) {
  const fake = fakeFetch({
    'GET /api/info': { body: { language: 'en' } },
    'GET /api/accounts': { body: { accounts: [account()] } },
    'GET /api/setup': { body: SETUP },
    ...answers,
  })
  const controller = createController({
    api: createApi(fake.fetchFn, () => controller.markUnauthorized()),
    createEventSource: () => new FakeEventSource(),
    browserLanguage: 'en-US',
    retryMs: 5,
  })
  return { ...fake, controller }
}

describe('the wizard in the controller', () => {
  it('knows nothing of the setup until the daemon says, then keeps what it says (resumable)', async () => {
    const { controller } = start()
    expect(controller.state.setup).toBeNull()
    await controller.start()
    expect(controller.state.setup).toEqual(SETUP)
  })

  it('never keeps the panel away: a daemon that cannot answer counts the setup as over', async () => {
    const { controller } = start({ 'GET /api/setup': { status: 500, body: { error: 'internal' } } })
    await controller.start()
    expect(controller.state.setup?.completed).toBe(true)
  })

  it('saves a step, keeps the answer, and asks for the accounts again when the step makes one', async () => {
    const next = { ...SETUP, step: 'provider', account: 'default' }
    const { controller, calls } = start({ 'PUT /api/setup': { body: next } })
    await controller.start()
    const before = calls.filter((c) => c.path === '/api/accounts').length
    expect(await controller.saveSetup({ from: 'name', ownerName: 'Ana' })).toEqual({ ok: true })
    expect(controller.state.setup).toEqual(next)
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ from: 'name', ownerName: 'Ana' })
    expect(calls.filter((c) => c.path === '/api/accounts').length).toBe(before + 1)
  })

  it('hands the refusal back with its code and the provider, and leaves the state as it was', async () => {
    const { controller } = start({
      'PUT /api/setup': { status: 409, body: { error: 'consentRequired', provider: 'claude-cli' } },
    })
    await controller.start()
    const result = await controller.saveSetup({ from: 'provider', provider: 'claude-cli' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error?.code).toBe('consentRequired')
      expect(result.error?.provider).toBe('claude-cli')
    }
    expect(controller.state.setup).toEqual(SETUP)
  })

  it('skips the wizard', async () => {
    const { controller } = start({ 'POST /api/setup/skip': { body: { ...SETUP, completed: true } } })
    await controller.start()
    expect(await controller.skipSetup()).toEqual({ ok: true })
    expect(controller.state.setup?.completed).toBe(true)
  })

  it('switches the language of the page at once', async () => {
    const { controller } = start()
    await controller.start()
    controller.setLanguage('es')
    expect(controller.state.language).toBe('es')
  })

  it('says it is not allowed on a 401 anywhere in the wizard', async () => {
    const { controller } = start({ 'PUT /api/setup': { status: 401, body: { error: 'unauthorized' } } })
    await controller.start()
    await controller.saveSetup({ from: 'language', language: 'es' })
    expect(controller.state.unauthorized).toBe(true)
  })
})

describe('the calls of the wizard', () => {
  it('make the real test and the consent only when asked', async () => {
    const { controller, calls } = start({
      'POST /api/setup/test-provider': { body: { ok: true, ms: 12 } },
      'POST /api/accounts/alpha/consents': { status: 201, body: { provider: 'claude-cli' } },
    })
    expect(calls.filter((c) => c.path.includes('test-provider'))).toEqual([])
    expect(await controller.api.testProvider({ provider: 'claude-cli', options: {}, consent: true })).toEqual({
      ok: true,
      ms: 12,
    })
    await controller.api.recordConsent('alpha', 'claude-cli')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/setup/test-provider',
      'POST /api/accounts/alpha/consents',
    ])
    expect(calls[0]?.body).toEqual({ provider: 'claude-cli', options: {}, consent: true })
    expect(calls[1]?.body).toEqual({ provider: 'claude-cli' })
  })
})
