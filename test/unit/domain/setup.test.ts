import { describe, expect, it } from 'vitest'
import {
  CONSENT_TEXT_VERSION,
  consentCovers,
  consentHostsKey,
  consentKeyFor,
  EXTERNAL_PROVIDERS,
  FIXED_HOSTS_KINDS,
  isEarlier,
  isLoopbackUrl,
  isSetupStep,
  nextStep,
  providerNeedsConsent,
  SETUP_STEPS,
  stepIndex,
} from '../../../src/domain/setup.js'

describe('the steps of the setup wizard (RF-70)', () => {
  it('go language, name, provider, transcription, link, schedule, done', () => {
    expect(SETUP_STEPS).toEqual(['language', 'name', 'provider', 'transcription', 'link', 'schedule', 'done'])
  })

  it('each one leads to the next, and the last to nothing', () => {
    expect(nextStep('language')).toBe('name')
    expect(nextStep('schedule')).toBe('done')
    expect(nextStep('done')).toBeNull()
  })

  it('knows what is a step and what comes before what', () => {
    expect(isSetupStep('link')).toBe(true)
    expect(isSetupStep('qr')).toBe(false)
    expect(isSetupStep(3)).toBe(false)
    expect(stepIndex('provider')).toBe(2)
    expect(isEarlier('name', 'provider')).toBe(true)
    expect(isEarlier('provider', 'provider')).toBe(false)
    expect(isEarlier('done', 'language')).toBe(false)
  })
})

describe('which providers need the consent (RNF-02)', () => {
  it('Claude Code does (the text of the chats goes to Anthropic) and Ollama does not (nothing leaves the machine)', () => {
    expect(providerNeedsConsent('claude-cli')).toBe(true)
    expect(providerNeedsConsent('ollama')).toBe(false)
    expect(providerNeedsConsent('anything-else')).toBe(false)
    expect(EXTERNAL_PROVIDERS).toEqual(['claude-cli', 'ollama-remote'])
    expect(providerNeedsConsent('ollama-remote')).toBe(true)
  })
})

describe('a remote Ollama is an external recipient (RNF-02)', () => {
  it.each([
    ['http://127.0.0.1:11434', true],
    ['http://127.1.2.3:11434', true],
    ['http://localhost:11434/', true],
    ['http://[::1]:11434', true],
    // the Docker host is this machine in the sandbox setup (the same rule as `isOnMachine` of the provider table)
    ['http://host.docker.internal:11434', true],
    ['http://192.168.1.20:11434', false],
    ['https://ollama.example.com', false],
    ['http://127.0.0.1.example.com', false],
    ['not a url', false],
  ])('%s is loopback: %s', (url, loopback) => {
    expect(isLoopbackUrl(url)).toBe(loopback)
  })

  it('asks for a consent key by who receives the text', () => {
    expect(consentKeyFor('claude-cli', 'http://127.0.0.1:11434')).toBe('claude-cli')
    expect(consentKeyFor('ollama', 'http://127.0.0.1:11434')).toBeNull()
    expect(consentKeyFor('ollama', 'http://10.0.0.5:11434')).toBe('ollama-remote')
    expect(consentKeyFor('other', 'http://10.0.0.5:11434')).toBeNull()
  })
})

describe('when a recorded consent covers the configuration (RNF-02)', () => {
  const V = CONSENT_TEXT_VERSION
  const given = (provider: string, hosts: string, textVersion = V) => ({ provider, hosts, textVersion })

  it('is keyed by the sorted, unique hosts', () => {
    expect(consentHostsKey(['b.example', 'a.example', 'a.example'])).toBe('a.example,b.example')
    expect(consentHostsKey([])).toBe('')
  })

  it('needs the same kind, the current text and the same hosts', () => {
    expect(consentCovers(given('openai', 'api.openai.com'), 'openai', 'api.openai.com')).toBe(true)
    expect(consentCovers(given('anthropic', 'api.openai.com'), 'openai', 'api.openai.com')).toBe(false)
    expect(consentCovers(given('openai', 'api.openai.com'), 'openai', 'other.example')).toBe(false)
    // new disclosure text, new consent: an older one does not count, and a newer one is not this program's
    expect(consentCovers(given('openai', 'api.openai.com', V - 1), 'openai', 'api.openai.com')).toBe(false)
    expect(consentCovers(given('openai', 'api.openai.com', V + 1), 'openai', 'api.openai.com')).toBe(false)
  })

  it('accepts a consent recorded with no hosts only for the kinds whose hosts are fixed', () => {
    expect(FIXED_HOSTS_KINDS).toEqual(['openai', 'anthropic', 'gemini', 'claude-cli'])
    for (const kind of FIXED_HOSTS_KINDS) expect(consentCovers(given(kind, ''), kind, 'any.example')).toBe(true)
    for (const kind of ['openai-compatible', 'generic-cli', 'ollama']) {
      expect(consentCovers(given(kind, ''), kind, 'https://one.example')).toBe(false)
      expect(consentCovers(given(kind, 'https://one.example'), kind, 'https://one.example')).toBe(true)
    }
  })

  it('the text that says what is sent is the version 2: unsaved numbers and voice notes were added to it', () => {
    expect(CONSENT_TEXT_VERSION).toBe(2)
  })
})
