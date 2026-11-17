import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import {
  type ConfigIssue,
  defaultConfigJson,
  describeConfigIssue,
  languageHint,
  loadConfig,
  parseConfig,
} from '../../../src/main/config.js'

const BA = 'America/Argentina/Buenos_Aires'
const parse = (input: unknown) => parseConfig(input, BA)
const issuesOf = (input: unknown): ConfigIssue[] => {
  const result = parse(input)
  if (result.ok) throw new Error('expected issues')
  return result.error
}

describe('parseConfig defaults', () => {
  it('gives every option its default for an empty file', () => {
    const result = parse({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      language: 'es',
      timezone: BA,
      digest: {
        ownerName: null,
        excludePatterns: [],
        defaultWindowHours: 24,
        maxCharsPerConversation: 24000,
        unreadOnly: false,
        flagUnsaved: false,
        hideRest: false,
      },
      localOnlyPatterns: [],
      promptFile: null,
      concurrency: 4,
      schedules: [],
      provider: {
        primary: null,
        backup: null,
        claudeCli: { command: 'claude', model: 'sonnet', timeoutMs: 180_000 },
        ollama: { baseUrl: 'http://127.0.0.1:11434', model: null, numCtx: 16384, keepAlive: '1m', timeoutMs: 180_000 },
      },
    })
  })

  it('uses the system time zone when none is given', () => {
    const result = parseConfig({})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  it('accepts a complete configuration', () => {
    const result = parse({
      language: 'en',
      timezone: 'Europe/Madrid',
      ownerName: 'Sam',
      excludePatterns: ['family'],
      defaultWindowHours: 12,
      localOnlyPatterns: ['bank'],
      promptFile: '/tmp/prompt.md',
      concurrency: 2,
      schedules: ['0 7 * * *', '30 19 * * 1-5'],
      provider: {
        primary: 'claude-cli',
        backup: 'ollama',
        claudeCli: { command: '/usr/local/bin/claude', model: 'opus', timeoutMs: 60_000 },
        ollama: {
          baseUrl: 'http://localhost:11434',
          model: 'qwen3:4b',
          numCtx: 8192,
          keepAlive: '5m',
          timeoutMs: 90_000,
        },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.language).toBe('en')
    expect(result.value.digest.ownerName).toBe('Sam')
    expect(result.value.provider.backup).toBe('ollama')
    expect(result.value.provider.ollama.model).toBe('qwen3:4b')
    expect(result.value.schedules).toEqual(['0 7 * * *', '30 19 * * 1-5'])
  })

  it('accepts the file that `init` writes', () => {
    const result = parse(JSON.parse(defaultConfigJson(BA)))
    expect(result.ok).toBe(true)
    if (result.ok) {
      // RF-41: no default provider, `init` leaves the choice to the user
      expect(result.value.provider.primary).toBeNull()
      expect(result.value.provider.backup).toBeNull()
      expect(result.value.schedules).toEqual(['0 7 * * *', '0 19 * * *'])
    }
  })
})

describe('parseConfig errors name the option and the reason (RF-73)', () => {
  it('rejects a config that is not an object', () => {
    expect(issuesOf([])).toEqual([{ option: '(config)', code: 'notObject' }])
    expect(issuesOf('x')).toEqual([{ option: '(config)', code: 'notObject' }])
  })

  it('reports digest settings through the domain validation', () => {
    expect(issuesOf({ defaultWindowHours: -1, hideRest: 'yes' })).toEqual([
      { option: 'defaultWindowHours', code: 'notPositive' },
      { option: 'hideRest', code: 'notBoolean' },
    ])
  })

  it('reports an unknown option, at the top level and inside provider', () => {
    expect(issuesOf({ langauge: 'en', provider: { primery: 'ollama', claudeCli: { modle: 'x' } } })).toEqual([
      { option: 'langauge', code: 'unknownOption' },
      { option: 'provider.primery', code: 'unknownOption' },
      { option: 'provider.claudeCli.modle', code: 'unknownOption' },
    ])
  })

  it('reports a language and a provider that are not in the list, with the accepted values', () => {
    expect(issuesOf({ language: 'fr', provider: { primary: 'gpt' } })).toEqual([
      { option: 'language', code: 'notOneOf', allowed: ['es', 'en'] },
      { option: 'provider.primary', code: 'notOneOf', allowed: ['claude-cli', 'ollama'] },
    ])
  })

  it('reports a time zone that does not exist', () => {
    expect(issuesOf({ timezone: 'Mars/Olympus' })).toEqual([{ option: 'timezone', code: 'invalidTimezone' }])
    expect(issuesOf({ timezone: 3 })).toEqual([{ option: 'timezone', code: 'notString' }])
  })

  it('reports each invalid cron expression with its position', () => {
    expect(issuesOf({ schedules: ['0 7 * * *', 'every day', '99 * * * *'] })).toEqual([
      { option: 'schedules[1]', code: 'invalidCron' },
      { option: 'schedules[2]', code: 'invalidCron' },
    ])
    expect(issuesOf({ schedules: 'daily' })).toEqual([{ option: 'schedules', code: 'notArray' }])
    expect(issuesOf({ schedules: [7] })).toEqual([{ option: 'schedules', code: 'notStringList' }])
  })

  it('validates the numbers of concurrency and of the providers', () => {
    expect(
      issuesOf({
        concurrency: 0,
        provider: { claudeCli: { timeoutMs: 1.5 }, ollama: { numCtx: 'big' } },
      }),
    ).toEqual([
      { option: 'concurrency', code: 'notPositive' },
      { option: 'provider.claudeCli.timeoutMs', code: 'notInteger' },
      { option: 'provider.ollama.numCtx', code: 'notNumber' },
    ])
  })

  it('validates strings: an empty command or prompt path is refused', () => {
    expect(issuesOf({ promptFile: '', provider: { claudeCli: { command: ' ' } } })).toEqual([
      { option: 'promptFile', code: 'emptyString' },
      { option: 'provider.claudeCli.command', code: 'emptyString' },
    ])
    expect(issuesOf({ localOnlyPatterns: [''] })).toContainEqual({ option: 'localOnlyPatterns', code: 'emptyPattern' })
    expect(issuesOf({ provider: 5 })).toEqual([{ option: 'provider', code: 'notObject' }])
  })

  it('requires the Ollama model when Ollama is used, as provider, backup or for local-only chats', () => {
    const required = [{ option: 'provider.ollama.model', code: 'required' }]
    expect(issuesOf({ provider: { primary: 'ollama' } })).toEqual(required)
    expect(issuesOf({ provider: { primary: 'claude-cli', backup: 'ollama' } })).toEqual(required)
    expect(issuesOf({ localOnlyPatterns: ['bank'] })).toEqual(required)
    expect(parse({ provider: { primary: 'ollama', ollama: { model: 'm' } } }).ok).toBe(true)
  })

  it('requires a primary provider when there is a backup', () => {
    expect(issuesOf({ provider: { backup: 'claude-cli' } })).toEqual([{ option: 'provider.primary', code: 'required' }])
  })

  it('reports every problem at once', () => {
    expect(issuesOf({ language: 'x', timezone: 'nowhere', concurrency: 'many' }).map((i) => i.option)).toEqual([
      'language',
      'timezone',
      'concurrency',
    ])
  })
})

describe('describeConfigIssue', () => {
  it('translates every kind of issue, naming the option, in both languages', () => {
    const issues: ConfigIssue[] = [
      { option: '(config)', code: 'invalidJson' },
      { option: 'foo', code: 'unknownOption' },
      { option: 'language', code: 'notOneOf', allowed: ['es', 'en'] },
      { option: 'provider.primary', code: 'required' },
      { option: 'timezone', code: 'invalidTimezone' },
      { option: 'schedules[0]', code: 'invalidCron' },
      { option: 'concurrency', code: 'notPositive' },
    ]
    for (const language of ['es', 'en'] as const) {
      const catalog = getCatalog(language)
      for (const issue of issues) {
        const text = describeConfigIssue(catalog, issue)
        if (issue.code !== 'invalidJson') expect(text).toContain(issue.option)
      }
    }
    expect(describeConfigIssue(getCatalog('en'), issues[2] as ConfigIssue)).toContain('es, en')
    expect(describeConfigIssue(getCatalog('es'), { option: 'concurrency', code: 'notPositive' })).toContain(
      'mayor que cero',
    )
  })
})

describe('loadConfig', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const fileWith = (content?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'msum-config-'))
    dirs.push(dir)
    const file = join(dir, 'config.json')
    if (content !== undefined) writeFileSync(file, content)
    return file
  }

  it('gives the defaults when the file does not exist', async () => {
    const result = await loadConfig(fileWith(), BA)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.language).toBe('es')
  })

  it('reads and validates the file', async () => {
    const result = await loadConfig(fileWith('{"language":"en","concurrency":2}'), BA)
    expect(result.ok && result.value.language === 'en' && result.value.concurrency === 2).toBe(true)
    const bad = await loadConfig(fileWith('{"concurrency":-1}'), BA)
    expect(bad).toEqual({ ok: false, error: [{ option: 'concurrency', code: 'notPositive' }] })
  })

  it('reports a file that is not JSON', async () => {
    expect(await loadConfig(fileWith('{nope'), BA)).toEqual({
      ok: false,
      error: [{ option: '(config)', code: 'invalidJson' }],
    })
  })

  it('finds the language to speak even when the rest is invalid', async () => {
    expect(await languageHint(fileWith('{"language":"en","concurrency":-1}'))).toBe('en')
    expect(await languageHint(fileWith('{nope'))).toBe('es')
    expect(await languageHint(fileWith('{"language":"fr"}'))).toBe('es')
    expect(await languageHint(fileWith())).toBe('es')
  })
})
