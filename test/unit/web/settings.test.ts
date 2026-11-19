import { describe, expect, it } from 'vitest'
import { webEn } from '../../../src/infrastructure/i18n/web-en.js'
import { webEs } from '../../../src/infrastructure/i18n/web-es.js'
import { createApi } from '../../../src/interfaces/web/lib/api.js'
import {
  buildPatch,
  draftOf,
  FIELDS,
  groupIssues,
  isEmptyPatch,
  isRemoteUrl,
  issueReason,
  issuesOf,
  msFromSeconds,
  optionLabel,
  secondsFromMs,
  shownDraft,
  storedDraft,
  timeZoneChoices,
} from '../../../src/interfaces/web/lib/settings.js'
import type { SettingsView } from '../../../src/interfaces/web/lib/types.js'
import { fakeFetch } from './support.js'

const view = (over: Partial<SettingsView['values']> = {}): SettingsView => ({
  values: {
    language: 'en',
    timezone: 'UTC',
    ownerName: null,
    unreadOnly: false,
    flagUnsaved: false,
    hideRest: false,
    maxCharsPerConversation: 24000,
    defaultWindowHours: 24,
    concurrency: 4,
    provider: {
      primary: 'claude-cli',
      backup: null,
      claudeCli: { model: 'sonnet', timeoutMs: 180000 },
      ollama: { baseUrl: 'http://127.0.0.1:11434', model: null },
    },
    ...over,
  },
  sources: { unreadOnly: 'default', timezone: 'installation', language: 'account' },
  options: { providers: ['claude-cli', 'ollama'], languages: ['es', 'en'] },
})

describe('the settings form', () => {
  it('shows the current values: text for what has no value, a switch for the flags', () => {
    const draft = draftOf(view({ unreadOnly: true }))
    expect(draft.unreadOnly).toBe(true)
    expect(draft.hideRest).toBe(false)
    expect(draft.maxCharsPerConversation).toBe('24000')
    expect(draft.ownerName).toBe('')
    expect(draft['provider.backup']).toBe('')
    expect(draft['provider.primary']).toBe('claude-cli')
    expect(draft['provider.ollama.model']).toBe('')
    expect(Object.keys(draft).sort()).toEqual(FIELDS.map((f) => f.option).sort())
  })

  it('sends only what changed, nested as config.json is', () => {
    const base = view()
    expect(isEmptyPatch((buildPatch(base, draftOf(base)) as { patch: Record<string, unknown> }).patch)).toBe(true)
    const draft = {
      ...draftOf(base),
      unreadOnly: true,
      maxCharsPerConversation: ' 5000 ',
      language: 'es',
      'provider.claudeCli.model': 'opus',
      'provider.ollama.model': 'llama3',
    }
    expect(buildPatch(base, draft)).toEqual({
      ok: true,
      patch: {
        unreadOnly: true,
        maxCharsPerConversation: 5000,
        language: 'es',
        provider: { claudeCli: { model: 'opus' }, ollama: { model: 'llama3' } },
      },
    })
  })

  it('an emptied field is null: it gives the value back to the installation (or is "none" for a provider)', () => {
    const base = view({ ownerName: 'Ana Test' })
    const draft = { ...draftOf(base), ownerName: '', 'provider.primary': '', maxCharsPerConversation: '' }
    expect(buildPatch(base, draft)).toEqual({
      ok: true,
      patch: { ownerName: null, maxCharsPerConversation: null, provider: { primary: null } },
    })
  })

  it('a number input hands over a number, which counts as unchanged when it is the same', () => {
    const base = view()
    const draft = {
      ...draftOf(base),
      defaultWindowHours: 24 as unknown as string,
      maxCharsPerConversation: 1000 as unknown as string,
    }
    expect(buildPatch(base, draft)).toEqual({ ok: true, patch: { maxCharsPerConversation: 1000 } })
  })

  it('does not send a number that is not one, and says which option', () => {
    const base = view()
    expect(buildPatch(base, { ...draftOf(base), defaultWindowHours: 'abc' })).toEqual({
      ok: false,
      issue: { option: 'defaultWindowHours', code: 'notNumber' },
    })
  })
})

describe('the issues of a refused save', () => {
  it('has a text in both languages for every code, and for every field', () => {
    for (const texts of [webEn, webEs]) {
      for (const code of Object.keys(webEn.configIssues)) {
        expect(issueReason({ option: 'x', code: code as never, allowed: ['a', 'b'] }, texts).length).toBeGreaterThan(0)
      }
      for (const { option } of FIELDS) expect(optionLabel(option, texts)).not.toBe(option)
    }
    expect(Object.keys(webEs.configIssues).sort()).toEqual(Object.keys(webEn.configIssues).sort())
  })

  it('names the accepted values of a choice and falls back for a code it does not know', () => {
    expect(issueReason({ option: 'language', code: 'notOneOf', allowed: ['es', 'en'] }, webEn)).toBe(
      'Must be one of: es, en.',
    )
    expect(issueReason({ option: 'x', code: 'somethingNew' as never }, webEn)).toBe(webEn.errors.invalidConfig)
    expect(optionLabel('somethingNew', webEn)).toBe('somethingNew')
  })

  it('puts each issue next to its field, and the ones of no field in a general list', () => {
    const grouped = groupIssues([
      { option: 'timezone', code: 'invalidTimezone' },
      { option: 'timezone', code: 'notString' },
      { option: '(config)', code: 'invalidJson' },
      { option: 'web', code: 'installationOnly' },
    ])
    expect(grouped.byOption.timezone).toHaveLength(2)
    expect(grouped.general.map((issue) => issue.option)).toEqual(['(config)', 'web'])
  })

  it('the API carries them: a 422 invalidConfig is an ApiError with its issues', async () => {
    const issues = [{ option: 'timezone', code: 'invalidTimezone' }]
    const { fetchFn, calls } = fakeFetch({
      'GET /api/accounts/alpha/settings': { body: view() },
      'PUT /api/accounts/alpha/settings': { status: 422, body: { error: 'invalidConfig', issues } },
    })
    const api = createApi(fetchFn)
    expect((await api.settings('alpha')).options.languages).toEqual(['es', 'en'])
    const error = await api.saveSettings('alpha', { timezone: 'Mars/Olympus' }).catch((e: unknown) => e)
    expect(calls[1]).toEqual({
      method: 'PUT',
      path: '/api/accounts/alpha/settings',
      body: { timezone: 'Mars/Olympus' },
    })
    expect(issuesOf(error)).toEqual(issues)
    expect(issuesOf(new Error('x'))).toBeNull()
  })

  it('offers the time zones of the browser, or none where it cannot tell', () => {
    expect(timeZoneChoices()).toContain('Europe/Madrid')
  })

  it('knows an Ollama address that is not this machine', () => {
    for (const local of [
      'http://127.0.0.1:11434',
      'http://localhost:11434',
      'http://[::1]:11434',
      'http://127.1.2.3',
      'HTTP://LOCALHOST',
    ]) {
      expect(isRemoteUrl(local), local).toBe(false)
    }
    for (const remote of [
      'http://192.168.1.20:11434',
      'https://ollama.example.test',
      'http://10.0.0.5',
      'http://127.0.0.1.evil.test',
    ]) {
      expect(isRemoteUrl(remote), remote).toBe(true)
    }
    // Not an address at all: the server says what is wrong, the page does not warn.
    expect(isRemoteUrl('')).toBe(false)
    expect(isRemoteUrl('nope')).toBe(false)
  })
})

describe('the timeout in seconds', () => {
  it('shows the milliseconds of the daemon as seconds and keeps what is typed as it is until it is sent', () => {
    expect(secondsFromMs('180000')).toBe('180')
    expect(secondsFromMs('1500')).toBe('1.5')
    expect(secondsFromMs('')).toBe('')
    expect(secondsFromMs('abc')).toBe('abc')
    expect(msFromSeconds('180')).toBe('180000')
    expect(msFromSeconds('1.5')).toBe('1500')
    expect(msFromSeconds('')).toBe('')
    expect(msFromSeconds('abc')).toBe('abc')
  })

  it('a form that was not touched has nothing to save, and a change of seconds is saved as milliseconds', () => {
    const v = view()
    const shown = shownDraft(v)
    expect(shown['provider.claudeCli.timeoutMs']).toBe('180')
    const same = buildPatch(v, storedDraft(shown))
    expect(same.ok && isEmptyPatch(same.patch)).toBe(true)
    const changed = buildPatch(v, storedDraft({ ...shown, 'provider.claudeCli.timeoutMs': '90' }))
    expect(changed).toEqual({ ok: true, patch: { provider: { claudeCli: { timeoutMs: 90000 } } } })
    const broken = buildPatch(v, storedDraft({ ...shown, 'provider.claudeCli.timeoutMs': 'abc' }))
    expect(broken.ok).toBe(false)
  })
})
