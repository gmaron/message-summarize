import { describe, expect, it } from 'vitest'
import {
  consentKeyFor,
  EXTERNAL_PROVIDERS,
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
