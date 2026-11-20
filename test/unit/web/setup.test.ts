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
  ollamaUrlOf,
  previousStep,
  providerBody,
  providerIssue,
  providerOptions,
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
    expect(items.map((item) => item.step)).toEqual(['you', 'provider', 'link'])
    expect(items.map((item) => item.number)).toEqual([1, 2, 3])
    expect(items.map((item) => item.state)).toEqual(['done', 'current', 'todo'])
    // The closing screen is not a step of its own: every step shown is behind.
    expect(stepIndicator('done').map((item) => item.state)).toEqual(['done', 'done', 'done'])
  })

  it('goes back one step, and not before the first', () => {
    expect(previousStep('link')).toBe('provider')
    expect(previousStep('you')).toBeNull()
  })

  it('checks the name as the daemon does', () => {
    expect(nameIssue(draft({ ownerName: '  ' }), false)).toBe('ownerBlank')
    expect(nameIssue(draft({ ownerName: 'x'.repeat(81) }), false)).toBe('ownerTooLong')
    // Anyone may write the name as they like: it fails only when nothing valid is left once it is an id.
    expect(nameIssue(draft({ ownerName: 'Ana', accountId: 'Not Valid' }), false)).toBeNull()
    expect(nameIssue(draft({ ownerName: 'Ana', accountId: 'Mi trabajo' }), false)).toBeNull()
    expect(nameIssue(draft({ ownerName: 'Ana', accountId: '🙂 !!' }), false)).toBe('invalidAccountId')
    expect(nameIssue(draft({ ownerName: 'Ana', accountId: '   ' }), false)).toBe('invalidAccountId')
    // No account name is suggested: an empty one is not valid, a typed one is.
    expect(draft().accountId).toBe('')
    expect(nameIssue(draft({ ownerName: 'Ana' }), false)).toBe('invalidAccountId')
    expect(nameIssue(draft({ ownerName: 'Ana', accountId: 'personal' }), false)).toBeNull()
    // Once the account exists its id is not asked again.
    expect(nameIssue(draft({ ownerName: 'Ana', accountId: 'Not Valid' }), true)).toBeNull()
  })

  it('never assumes the local Ollama: an emptied field means the address the daemon says (here, not on this machine)', () => {
    const remote = draft({ provider: 'ollama', ollamaBaseUrl: '', ollamaInherited: 'http://192.0.2.7:11434' })
    expect(ollamaUrlOf(remote)).toBe('http://192.0.2.7:11434')
    // The agreement is asked for that server, so the box shows and what is sent names its key.
    expect(consentKeyOf(remote)).toBe('ollama-remote')
    expect(providerBody({ ...remote, consent: true })).toMatchObject({ consent: 'ollama-remote' })
    // A local address inherited asks nothing; a typed one wins over the inherited one.
    const local = draft({ provider: 'ollama', ollamaBaseUrl: '', ollamaInherited: 'http://127.0.0.1:11434' })
    expect(consentKeyOf(local)).toBeNull()
    expect(consentKeyOf({ ...local, ollamaBaseUrl: 'http://192.0.2.9:11434' })).toBe('ollama-remote')
    expect(ollamaUrlOf({ ...remote, ollamaBaseUrl: 'http://127.0.0.1:11434' })).toBe('http://127.0.0.1:11434')
  })

  it('says in both languages that an existing unlinked account is used, with the id in the text', () => {
    for (const texts of [webEs, webEn]) {
      expect(texts.ui.addAccount.idPreview).toContain('{id}')
      expect(texts.ui.addAccount.idPreviewExisting).toContain('{id}')
      expect(texts.ui.addAccount.idPreviewExisting).not.toBe(texts.ui.addAccount.idPreview)
    }
    expect(webEs.ui.addAccount.idPreviewExisting).toContain('ya existe, se va a usar')
    expect(webEn.ui.addAccount.idPreviewExisting).toContain('already exists, it will be used')
  })

  it('sends the time zone of the browser with the first step, when there is one', () => {
    expect(
      nameBody(draft({ ownerName: 'Ana', accountId: 'casa' }), false, 'America/Argentina/Buenos_Aires'),
    ).toMatchObject({
      timezone: 'America/Argentina/Buenos_Aires',
    })
    expect(nameBody(draft({ ownerName: 'Ana', accountId: 'casa' }), false)).not.toHaveProperty('timezone')
  })

  it('sends the id only while the account does not exist', () => {
    // The id sent is the name turned into one (the daemon keeps its strict check).
    expect(nameBody(draft({ ownerName: 'Ana', accountId: 'Corporativo Ñandú' }), false)).toMatchObject({
      accountId: 'corporativo-nandu',
    })
    expect(nameBody(draft({ ownerName: ' Ana ', accountId: ' casa ', language: 'en' }), false)).toEqual({
      from: 'you',
      language: 'en',
      ownerName: 'Ana',
      accountId: 'casa',
    })
    expect(nameBody(draft({ ownerName: 'Ana', language: 'es' }), true)).toEqual({
      from: 'you',
      language: 'es',
      ownerName: 'Ana',
    })
  })

  it('offers what exists today and says which needs the agreement', () => {
    expect(WIZARD_PROVIDERS).toEqual(['claude-cli', 'ollama', 'openai', 'anthropic', 'gemini'])
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
    expect(providerBody({ ...remote, consent: true })).toMatchObject({ consent: 'ollama-remote' })
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
      consent: 'claude-cli',
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
      consent: 'claude-cli',
    })
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

const SETUP = {
  completed: false,
  step: 'you',
  account: null,
  linked: false,
  language: 'es',
  freshInstall: false,
  consents: [],
}

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

/** A controller whose browser asks for `languages`, whose daemon says `installation` and whose setup is `setup`. */
function inBrowser(languages: string[], installation: string, setup: Record<string, unknown> = {}) {
  const fake = fakeFetch({
    'GET /api/info': { body: { language: installation } },
    'GET /api/accounts': { body: { accounts: [account()] } },
    'GET /api/setup': { body: { ...SETUP, ...setup } },
  })
  const controller = createController({
    api: createApi(fake.fetchFn, () => controller.markUnauthorized()),
    createEventSource: () => new FakeEventSource(),
    browserLanguage: languages[0],
    browserLanguages: languages,
    retryMs: 5,
  })
  return { ...fake, controller }
}

describe('the language of the page (Spanish first)', () => {
  it('is Spanish from the very first render, whatever the browser says, until the daemon answers', () => {
    expect(inBrowser(['en-US'], 'es').controller.state.language).toBe('es')
    expect(inBrowser(['fr-FR'], 'es').controller.state.language).toBe('es')
  })

  it('follows an English browser on a fresh install (the daemon says so), even if the installation says Spanish', async () => {
    const { controller } = inBrowser(['en-US', 'es-AR'], 'es', { freshInstall: true })
    await controller.start()
    expect(controller.state.language).toBe('en')
  })

  it('takes the FIRST Spanish or English language of the browser: a Spanish one before an English one is Spanish', async () => {
    const { controller } = inBrowser(['fr-FR', 'es-AR', 'en-US'], 'es', { freshInstall: true })
    await controller.start()
    expect(controller.state.language).toBe('es')
  })

  it('stays Spanish for a browser language that is neither Spanish nor English', async () => {
    const { controller } = inBrowser(['fr-FR', 'ja'], 'es', { freshInstall: true })
    await controller.start()
    expect(controller.state.language).toBe('es')
  })

  it('keeps the installation language when it is not a fresh install, whatever the browser says', async () => {
    const spanish = inBrowser(['en-US'], 'es')
    await spanish.controller.start()
    expect(spanish.controller.state.language).toBe('es')
    const english = inBrowser(['es-AR'], 'en')
    await english.controller.start()
    expect(english.controller.state.language).toBe('en')
  })

  it('keeps the installation language once the wizard is over, fresh flag or not', async () => {
    const { controller } = inBrowser(['en-US'], 'es', { completed: true, freshInstall: true })
    await controller.start()
    expect(controller.state.language).toBe('es')
  })

  it('does not take a language the daemon does not know: Spanish', async () => {
    const { controller } = inBrowser(['en-US'], 'fr')
    await controller.start()
    expect(controller.state.language).toBe('es')
  })

  it('a language chosen with the switch is kept: the browser does not take it back', async () => {
    const { controller } = inBrowser(['en-US'], 'es', { freshInstall: true })
    await controller.start()
    expect(controller.state.language).toBe('en')
    controller.setLanguage('es')
    expect(controller.state.language).toBe('es')
    await controller.loadSetup()
    expect(controller.state.language).toBe('es')
  })

  it('the first step writes the language that is shown (the switch changes it before)', async () => {
    const { controller, calls } = inBrowser(['en-US'], 'es', { freshInstall: true })
    await controller.start()
    controller.setLanguage('es')
    const body = nameBody(draft({ ownerName: 'Ana', accountId: 'casa', language: controller.state.language }), false)
    expect(body).toMatchObject({ from: 'you', language: 'es' })
    controller.setLanguage('en')
    expect(
      nameBody(draft({ ownerName: 'Ana', accountId: 'casa', language: controller.state.language }), false),
    ).toMatchObject({ language: 'en' })
    expect(calls.some((call) => call.method === 'PUT')).toBe(false)
  })

  it('the page that has no access follows the browser (Spanish for another language), and keeps a chosen one', async () => {
    const english = inBrowser(['en-GB'], 'es')
    english.controller.markUnauthorized()
    expect(english.controller.state).toMatchObject({ unauthorized: true, language: 'en' })
    const other = inBrowser(['fr-FR'], 'en')
    other.controller.markUnauthorized()
    expect(other.controller.state.language).toBe('es')
    const chosen = inBrowser(['en-GB'], 'es')
    chosen.controller.setLanguage('es')
    chosen.controller.markUnauthorized()
    expect(chosen.controller.state.language).toBe('es')
  })
})

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
    expect(await controller.saveSetup({ from: 'you', ownerName: 'Ana' })).toEqual({ ok: true })
    expect(controller.state.setup).toEqual(next)
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ from: 'you', ownerName: 'Ana' })
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
    await controller.saveSetup({ from: 'you', ownerName: 'Ana' })
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
    expect(await controller.api.testProvider({ provider: 'claude-cli', options: {}, consent: 'claude-cli' })).toEqual({
      ok: true,
      ms: 12,
    })
    await controller.api.recordConsent('alpha', 'claude-cli')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/setup/test-provider',
      'POST /api/accounts/alpha/consents',
    ])
    expect(calls[0]?.body).toEqual({ provider: 'claude-cli', options: {}, consent: 'claude-cli' })
    expect(calls[1]?.body).toEqual({ provider: 'claude-cli' })
  })
})
