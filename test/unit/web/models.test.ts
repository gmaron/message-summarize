import { describe, expect, it } from 'vitest'
import { webEn } from '../../../src/infrastructure/i18n/web-en.js'
import { webEs } from '../../../src/infrastructure/i18n/web-es.js'
import { createApi } from '../../../src/interfaces/web/lib/api.js'
import { MODEL_FIELDS, optionText, pickerState } from '../../../src/interfaces/web/lib/models.js'
import type { ModelsView } from '../../../src/interfaces/web/lib/types.js'
import { fakeFetch } from './support.js'

const live = (over: Partial<ModelsView> = {}): ModelsView => ({
  provider: 'anthropic',
  source: 'live',
  models: [{ id: 'claude-b', name: 'Claude B' }, { id: 'claude-a' }],
  ...over,
})

describe('the states of the model chooser', () => {
  it('waits while the list is not answered', () => {
    expect(pickerState('anthropic', null, '')).toMatchObject({ kind: 'loading', options: [] })
  })

  it('is disabled until a key is saved', () => {
    expect(pickerState('openai', live({ provider: 'openai', models: [], error: 'noKey' }), '')).toMatchObject({
      kind: 'needsKey',
      options: [],
    })
  })

  it('offers the list that was answered', () => {
    const state = pickerState('anthropic', live(), 'claude-a')
    expect(state).toMatchObject({ kind: 'select', fallback: false, foreign: false })
    expect(state.options.map((one) => one.id)).toEqual(['claude-b', 'claude-a'])
  })

  it('says it is the known models of Anthropic when its list failed, and why', () => {
    const state = pickerState(
      'anthropic',
      { provider: 'anthropic', source: 'fallback', models: [{ id: 'claude-sonnet-5-5' }], error: 'unreachable' },
      '',
    )
    expect(state).toMatchObject({ kind: 'select', fallback: true, reason: 'unreachable' })
    expect(state.options).toHaveLength(1)
  })

  it('shows the error and a way to look again for OpenAI and Gemini when there is no list (never a typing box)', () => {
    for (const provider of ['openai', 'gemini'] as const) {
      for (const error of ['unreachable', 'rejected', 'failed'] as const) {
        const state = pickerState(provider, { provider, source: 'live', models: [], error }, 'whatever')
        expect(state, `${provider} ${error}`).toMatchObject({ kind: 'failed', reason: error, options: [] })
      }
    }
  })

  it('keeps a model that was saved and is not in the list as the current one, with a warning', () => {
    const state = pickerState('anthropic', live(), 'claude-retired')
    expect(state.foreign).toBe(true)
    expect(state.options.map((one) => one.id)).toEqual(['claude-retired', 'claude-b', 'claude-a'])
    // Nothing chosen yet is not a foreign model.
    expect(pickerState('anthropic', live(), '').foreign).toBe(false)
  })

  it('has no text box for Ollama: with no models it is a message and a way to look again (also when it needs the agreement)', () => {
    expect(
      pickerState('ollama', { provider: 'ollama', source: 'live', models: [], error: 'consentRequired' }, ''),
    ).toMatchObject({ kind: 'empty', reason: 'consentRequired' })
    expect(pickerState('ollama', { provider: 'ollama', source: 'live', models: [], error: 'empty' }, '')).toMatchObject(
      { kind: 'empty', reason: 'empty', options: [] },
    )
    expect(
      pickerState('ollama', { provider: 'ollama', source: 'live', models: [], error: 'unreachable' }, ''),
    ).toMatchObject({ kind: 'empty', reason: 'unreachable' })
    expect(
      pickerState('ollama', { provider: 'ollama', source: 'live', models: [], error: 'invalidAddress' }, ''),
    ).toMatchObject({ kind: 'empty', reason: 'invalidAddress' })
  })

  it('knows that "llama3.2" is "llama3.2:latest" for Ollama only', () => {
    const view: ModelsView = { provider: 'ollama', source: 'live', models: [{ id: 'llama3.2:latest' }] }
    expect(pickerState('ollama', view, 'llama3.2').foreign).toBe(false)
    // The select shows the model of the list that the saved name stands for.
    expect(pickerState('ollama', view, 'llama3.2').selected).toBe('llama3.2:latest')
    expect(pickerState('ollama', view, 'llama3.2:latest').selected).toBe('llama3.2:latest')
    expect(pickerState('openai', { ...view, provider: 'openai' }, 'llama3.2').foreign).toBe(true)
  })

  it('lets a name be typed only for a compatible server that gives no list', () => {
    const view: ModelsView = { provider: 'openai', source: 'live', models: [], error: 'failed', typing: true }
    expect(pickerState('openai', view, 'local-model')).toMatchObject({ kind: 'typing', options: [] })
    // Any other failure is never a text box.
    expect(
      pickerState('openai', { ...view, typing: undefined, source: 'fallback', models: [{ id: 'gpt-4o' }] }, '').kind,
    ).toBe('select')
  })

  it('writes the friendly name first, and the id after it except for the aliases of Claude Code', () => {
    expect(optionText('anthropic', { id: 'claude-b', name: 'Claude B' })).toBe('Claude B (claude-b)')
    expect(optionText('anthropic', { id: 'claude-a' })).toBe('claude-a')
    expect(optionText('claude-cli', { id: 'sonnet', name: 'Sonnet' })).toBe('Sonnet')
  })

  it('covers every model option of the settings', () => {
    expect(Object.values(MODEL_FIELDS).sort()).toEqual(['anthropic', 'claude-cli', 'gemini', 'ollama', 'openai'])
  })
})

describe('the model list in the api client', () => {
  it('is a POST (it makes a request to another host): look again, the Ollama address on screen and its agreement go in the body', async () => {
    const { fetchFn, calls } = fakeFetch({
      'POST /api/accounts/alpha/models/anthropic': { body: live() },
      'POST /api/accounts/alpha/models/ollama': { body: { provider: 'ollama', source: 'live', models: [] } },
    })
    const api = createApi(fetchFn, () => undefined)
    expect((await api.models('alpha', 'anthropic')).models).toHaveLength(2)
    await api.models('alpha', 'anthropic', { refresh: true })
    await api.models('alpha', 'ollama', { baseUrl: ' http://10.0.0.5:11434 ', consent: 'ollama-remote' })
    // An empty address asks nothing: the daemon uses the one of the account.
    await api.models('alpha', 'ollama', { baseUrl: '  ' })
    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ['POST', '/api/accounts/alpha/models/anthropic', {}],
      ['POST', '/api/accounts/alpha/models/anthropic', { refresh: true }],
      ['POST', '/api/accounts/alpha/models/ollama', { baseUrl: 'http://10.0.0.5:11434', consent: 'ollama-remote' }],
      ['POST', '/api/accounts/alpha/models/ollama', {}],
    ])
  })
})

describe('the texts of the model chooser', () => {
  it.each([webEs, webEn])('are all there, and the foreign warning names the model', (texts) => {
    const m = texts.ui.models
    for (const text of Object.values(m)) expect(text).toBeTruthy()
    expect(m.foreign).toContain('{model}')
    expect(m.emptyOllama).toContain('ollama pull')
    expect(m.needsKey).toBeTruthy()
    // The way to enable the select is told in the words of the button that does it.
    expect(m.needsKey).toContain(texts.ui.disclosure.keys.save)
    expect(texts.errors.unknownModel).toBeTruthy()
  })
})
