import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import {
  type ConfigIssue,
  defaultConfigJson,
  describeConfigIssue,
  languageHint,
  loadConfig,
  loadEffectiveConfig,
  mergeConfigJson,
  parseConfig,
  validateEffective,
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
      askHints: [],
      askPresets: [],
      promptFile: null,
      concurrency: 4,
      fullHistoryOnLink: false,
      schedules: [],
      provider: {
        primary: null,
        backup: null,
        claudeCli: { command: 'claude', model: 'sonnet', timeoutMs: 180_000 },
        ollama: { baseUrl: 'http://127.0.0.1:11434', model: null, numCtx: 16384, keepAlive: '1m', timeoutMs: 180_000 },
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          model: null,
          timeoutMs: 180_000,
          structuredOutput: 'json_schema',
        },
        anthropic: { model: null, timeoutMs: 180_000, maxTokens: 16_000, effort: null },
        gemini: { model: null, timeoutMs: 180_000 },
        retry: { maxRetries: 3, maxWaitMs: 120_000, maxTotalMs: 300_000 },
        geminiCli: { command: 'gemini', model: null, timeoutMs: 180_000 },
        codexCli: { command: 'codex', model: null, timeoutMs: 180_000 },
        genericCli: { command: null, timeoutMs: 180_000, acknowledgeRisk: false },
      },
      transcription: {
        enabled: false,
        whisperCommand: 'whisper-cli',
        ffmpegCommand: 'ffmpeg',
        model: null,
        language: 'auto',
        timeoutMs: 300_000,
        historyAudioDays: 14,
        maxMediaMb: 500,
        concurrency: 1,
        threads: 1,
        downloadConcurrency: 2,
      },
      web: { enabled: true, host: '127.0.0.1', port: 8787, allowedHosts: [] },
      logs: { maxBytes: 52_428_800 },
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
      // the times of the digests are set with `msum schedule add`: a new installation starts with none
      expect(result.value.schedules).toEqual([])
      expect(JSON.parse(defaultConfigJson(BA))).not.toHaveProperty('schedules')
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
      {
        option: 'provider.primary',
        code: 'notOneOf',
        allowed: ['claude-cli', 'gemini-cli', 'codex-cli', 'generic-cli', 'ollama', 'openai', 'anthropic', 'gemini'],
      },
    ])
  })

  it('reports a time zone that does not exist', () => {
    expect(issuesOf({ timezone: 'Mars/Olympus' })).toEqual([{ option: 'timezone', code: 'invalidTimezone' }])
    expect(issuesOf({ timezone: 3 })).toEqual([{ option: 'timezone', code: 'notString' }])
  })

  it('accepts any list of texts as schedules: it is only imported once, doctor lists what cannot be imported', () => {
    const result = parse({ schedules: ['0 7 * * *', 'every day', '99 * * * *', '*/5 * * * *'] })
    expect(result.ok && result.value.schedules).toEqual(['0 7 * * *', 'every day', '99 * * * *', '*/5 * * * *'])
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
    expect(issuesOf({ localOnlyPatterns: ['id:'] })).toContainEqual({
      option: 'localOnlyPatterns',
      code: 'emptyIdPattern',
    })
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

describe('transcription options (RF-15, RF-21, RF-23)', () => {
  const transcriptionOf = (input: unknown) => {
    const result = parse(input)
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    return result.value.transcription
  }

  it('is off by default, with whisper-cli and ffmpeg, automatic language and a five minute limit', () => {
    expect(transcriptionOf({})).toEqual({
      enabled: false,
      whisperCommand: 'whisper-cli',
      ffmpegCommand: 'ffmpeg',
      model: null,
      language: 'auto',
      timeoutMs: 300_000,
      historyAudioDays: 14,
      maxMediaMb: 500,
      concurrency: 1,
      threads: 1,
      downloadConcurrency: 2,
    })
  })

  it('takes every option, and the other options of the section keep their defaults', () => {
    expect(
      transcriptionOf({
        transcription: {
          enabled: true,
          whisperCommand: '/opt/whisper/bin/whisper-cli',
          ffmpegCommand: '/usr/local/bin/ffmpeg',
          model: 'small',
          language: 'es',
          timeoutMs: 60_000,
          historyAudioDays: 30,
          maxMediaMb: 100,
          concurrency: 10,
          threads: 2,
          downloadConcurrency: 6,
        },
      }),
    ).toEqual({
      enabled: true,
      whisperCommand: '/opt/whisper/bin/whisper-cli',
      ffmpegCommand: '/usr/local/bin/ffmpeg',
      model: 'small',
      language: 'es',
      timeoutMs: 60_000,
      historyAudioDays: 30,
      maxMediaMb: 100,
      concurrency: 10,
      threads: 2,
      downloadConcurrency: 6,
    })
    expect(transcriptionOf({ transcription: { enabled: true } })).toMatchObject({ enabled: true, language: 'auto' })
  })

  it('turning it on without a model is valid: the product works and doctor reports it (RF-21)', () => {
    expect(parse({ transcription: { enabled: true } }).ok).toBe(true)
  })

  it('accepts "auto" and language codes of two or three letters, and nothing else (RF-23)', () => {
    for (const language of ['auto', 'es', 'en', 'pt', 'haw']) {
      expect(parse({ transcription: { language } }).ok, language).toBe(true)
    }
    for (const language of ['Spanish', 'ES', 'e', '', 'es-AR', '-x', 'es;ls', 'autom']) {
      expect(issuesOf({ transcription: { language } })[0]?.option, language).toBe('transcription.language')
    }
    expect(issuesOf({ transcription: { language: 'Spanish' } })).toEqual([
      { option: 'transcription.language', code: 'invalidLanguage' },
    ])
    expect(issuesOf({ transcription: { language: 7 } })).toEqual([
      { option: 'transcription.language', code: 'notString' },
    ])
  })

  it('names the option and the reason for each invalid value', () => {
    expect(issuesOf({ transcription: 'yes' })).toEqual([{ option: 'transcription', code: 'notObject' }])
    expect(issuesOf({ transcription: { enabled: 'yes' } })).toEqual([
      { option: 'transcription.enabled', code: 'notBoolean' },
    ])
    expect(issuesOf({ transcription: { whisperCommand: '' } })).toEqual([
      { option: 'transcription.whisperCommand', code: 'emptyString' },
    ])
    expect(issuesOf({ transcription: { ffmpegCommand: 3 } })).toEqual([
      { option: 'transcription.ffmpegCommand', code: 'notString' },
    ])
    expect(issuesOf({ transcription: { model: '  ' } })).toEqual([
      { option: 'transcription.model', code: 'emptyString' },
    ])
    expect(issuesOf({ transcription: { timeoutMs: 0 } })).toEqual([
      { option: 'transcription.timeoutMs', code: 'notPositive' },
    ])
    expect(issuesOf({ transcription: { timeoutMs: 1.5 } })).toEqual([
      { option: 'transcription.timeoutMs', code: 'notInteger' },
    ])
    expect(issuesOf({ transcription: { historyAudioDays: -1 } })).toEqual([
      { option: 'transcription.historyAudioDays', code: 'notPositive' },
    ])
    expect(issuesOf({ transcription: { historyAudioDays: 2.5 } })).toEqual([
      { option: 'transcription.historyAudioDays', code: 'notInteger' },
    ])
    expect(issuesOf({ transcription: { historyAudioDays: 'many' } })).toEqual([
      { option: 'transcription.historyAudioDays', code: 'notNumber' },
    ])
    expect(issuesOf({ transcription: { maxMediaMb: -5 } })).toEqual([
      { option: 'transcription.maxMediaMb', code: 'notPositive' },
    ])
    expect(issuesOf({ transcription: { maxMediaMb: 1.5 } })).toEqual([
      { option: 'transcription.maxMediaMb', code: 'notInteger' },
    ])
    expect(issuesOf({ transcription: { enable: true } })).toEqual([
      { option: 'transcription.enable', code: 'unknownOption' },
    ])
  })

  it('historyAudioDays 0 means the whole history: it is accepted and kept as 0', () => {
    expect(transcriptionOf({ transcription: { historyAudioDays: 0 } }).historyAudioDays).toBe(0)
    expect(transcriptionOf({ transcription: { historyAudioDays: 3650 } }).historyAudioDays).toBe(3650)
  })

  describe('concurrency, threads and downloadConcurrency', () => {
    const limits = [
      ['concurrency', 1, 16],
      ['threads', 1, 64],
      ['downloadConcurrency', 1, 16],
    ] as const

    for (const [key, min, max] of limits) {
      it(`${key} takes whole numbers from ${min} to ${max}`, () => {
        expect(transcriptionOf({ transcription: { [key]: min } })[key]).toBe(min)
        expect(transcriptionOf({ transcription: { [key]: max } })[key]).toBe(max)
      })

      it(`${key} refuses what is out of range, not a whole number or not a number, naming the option`, () => {
        const option = `transcription.${key}`
        expect(issuesOf({ transcription: { [key]: 0 } })).toEqual([
          { option, code: 'outOfRange', allowed: [String(min), String(max)] },
        ])
        expect(issuesOf({ transcription: { [key]: max + 1 } })).toEqual([
          { option, code: 'outOfRange', allowed: [String(min), String(max)] },
        ])
        expect(issuesOf({ transcription: { [key]: -3 } })).toEqual([{ option, code: 'notPositive' }])
        expect(issuesOf({ transcription: { [key]: 1.5 } })).toEqual([{ option, code: 'notInteger' }])
        expect(issuesOf({ transcription: { [key]: '4' } })).toEqual([{ option, code: 'notNumber' }])
      })
    }

    it('explains an out-of-range value in both languages, with the limits', () => {
      const issue: ConfigIssue = {
        option: 'transcription.concurrency',
        code: 'outOfRange',
        allowed: ['1', '16'],
      }
      const en = describeConfigIssue(getCatalog('en'), issue)
      expect(en).toContain('transcription.concurrency')
      expect(en).toContain('between 1 and 16')
      const es = describeConfigIssue(getCatalog('es'), issue)
      expect(es).toContain('transcription.concurrency')
      expect(es).toContain('entre 1 y 16')
    })
  })

  it('explains an invalid language in both languages, naming the option', () => {
    const issue: ConfigIssue = { option: 'transcription.language', code: 'invalidLanguage' }
    expect(describeConfigIssue(getCatalog('en'), issue)).toContain('transcription.language')
    expect(describeConfigIssue(getCatalog('en'), issue)).toContain('"auto"')
    expect(describeConfigIssue(getCatalog('es'), issue)).toContain('detectar el idioma')
  })

  it('the account overrides the installation per key, so one account can have its own language (RF-23)', () => {
    expect(
      mergeConfigJson(
        { transcription: { enabled: true, model: 'base', language: 'es' } },
        { transcription: { language: 'en' } },
      ),
    ).toEqual({ transcription: { enabled: true, model: 'base', language: 'en' } })
    expect(mergeConfigJson({ transcription: { enabled: true } }, { transcription: { enabled: false } })).toEqual({
      transcription: { enabled: false },
    })
    // a value of the wrong shape is kept so the validation reports it
    expect(mergeConfigJson({ transcription: { enabled: true } }, { transcription: 'x' })).toEqual({
      transcription: 'x',
    })
  })
})

describe('the web section (RNF-03)', () => {
  it('is on, on 127.0.0.1:8787, unless the file says otherwise', () => {
    const result = parse({ web: { enabled: false, host: '0.0.0.0', port: 9000 } })
    expect(result.ok && result.value.web).toEqual({ enabled: false, host: '0.0.0.0', port: 9000, allowedHosts: [] })
    const partial = parse({ web: { port: 1 } })
    expect(partial.ok && partial.value.web).toEqual({ enabled: true, host: '127.0.0.1', port: 1, allowedHosts: [] })
  })

  it('reads web.allowedHosts as lowercase bare host names, and refuses anything else', () => {
    const result = parse({ web: { allowedHosts: [' Resumenes-Pao ', 'pao.tail57a9c5.ts.net'] } })
    expect(result.ok && result.value.web.allowedHosts).toEqual(['resumenes-pao', 'pao.tail57a9c5.ts.net'])
    expect(issuesOf({ web: { allowedHosts: 'resumenes-pao' } })).toEqual([
      { option: 'web.allowedHosts', code: 'notArray' },
    ])
    expect(issuesOf({ web: { allowedHosts: [1] } })).toEqual([{ option: 'web.allowedHosts', code: 'notStringList' }])
    for (const bad of ['https://resumenes-pao', 'resumenes-pao:8788', 'a/b', 'a b', '']) {
      expect(issuesOf({ web: { allowedHosts: [bad] } })).toEqual([
        { option: 'web.allowedHosts', code: 'invalidHostName' },
      ])
    }
  })

  it('refuses a port that is not an integer between 1 and 65535', () => {
    expect(issuesOf({ web: { port: 0 } })).toEqual([{ option: 'web.port', code: 'invalidPort' }])
    expect(issuesOf({ web: { port: 65536 } })).toEqual([{ option: 'web.port', code: 'invalidPort' }])
    expect(issuesOf({ web: { port: 80.5 } })).toEqual([{ option: 'web.port', code: 'notInteger' }])
    expect(issuesOf({ web: { port: '8787' } })).toEqual([{ option: 'web.port', code: 'notNumber' }])
    expect(parse({ web: { port: 65535 } }).ok).toBe(true)
  })

  it('refuses a host or a flag of the wrong type, an unknown key and a section that is not an object', () => {
    expect(issuesOf({ web: { host: 5 } })).toEqual([{ option: 'web.host', code: 'notString' }])
    expect(issuesOf({ web: { host: '' } })).toEqual([{ option: 'web.host', code: 'emptyString' }])
    expect(issuesOf({ web: { enabled: 'yes' } })).toEqual([{ option: 'web.enabled', code: 'notBoolean' }])
    expect(issuesOf({ web: { token: 'x' } })).toEqual([{ option: 'web.token', code: 'unknownOption' }])
    expect(issuesOf({ web: 'on' })).toEqual([{ option: 'web', code: 'notObject' }])
  })

  it('describes the new issues in both languages, naming the option', () => {
    for (const language of ['es', 'en'] as const) {
      const catalog = getCatalog(language)
      expect(describeConfigIssue(catalog, { option: 'web.port', code: 'invalidPort' })).toContain('web.port')
      expect(describeConfigIssue(catalog, { option: 'web', code: 'installationOnly' })).toContain('web')
    }
  })
})

describe('the logs section (RNF-12)', () => {
  it('is 50 MB by default and takes the number the file gives', () => {
    const none = parse({})
    expect(none.ok && none.value.logs).toEqual({ maxBytes: 52_428_800 })
    expect(parse({ logs: {} }).ok).toBe(true)
    const set = parse({ logs: { maxBytes: 10_485_760 } })
    expect(set.ok && set.value.logs).toEqual({ maxBytes: 10_485_760 })
    expect(parse({ logs: { maxBytes: 1_048_576 } }).ok).toBe(true)
  })

  it('refuses a maximum that is not an integer, or is under 1 MB', () => {
    expect(issuesOf({ logs: { maxBytes: 1_048_575 } })).toEqual([{ option: 'logs.maxBytes', code: 'belowMinimum' }])
    expect(issuesOf({ logs: { maxBytes: 0 } })).toEqual([{ option: 'logs.maxBytes', code: 'belowMinimum' }])
    expect(issuesOf({ logs: { maxBytes: -5 } })).toEqual([{ option: 'logs.maxBytes', code: 'belowMinimum' }])
    expect(issuesOf({ logs: { maxBytes: 2_000_000.5 } })).toEqual([{ option: 'logs.maxBytes', code: 'notInteger' }])
    expect(issuesOf({ logs: { maxBytes: '50MB' } })).toEqual([{ option: 'logs.maxBytes', code: 'notNumber' }])
    expect(issuesOf({ logs: { dir: '/tmp' } })).toEqual([{ option: 'logs.dir', code: 'unknownOption' }])
    expect(issuesOf({ logs: 5 })).toEqual([{ option: 'logs', code: 'notObject' }])
  })

  it('describes the new issue in both languages, naming the option', () => {
    for (const language of ['es', 'en'] as const) {
      const text = describeConfigIssue(getCatalog(language), { option: 'logs.maxBytes', code: 'belowMinimum' })
      expect(text).toContain('logs.maxBytes')
      expect(text).toContain('1048576')
    }
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

describe('mergeConfigJson', () => {
  it('replaces top-level options of the installation with those of the account', () => {
    expect(
      mergeConfigJson({ language: 'es', schedules: ['0 7 * * *'], concurrency: 2 }, { language: 'en', schedules: [] }),
    ).toEqual({ language: 'en', schedules: [], concurrency: 2 })
  })

  it('merges provider per key, and claudeCli and ollama per sub-key', () => {
    const base = {
      provider: {
        primary: 'claude-cli',
        backup: 'ollama',
        claudeCli: { command: 'claude', model: 'sonnet', timeoutMs: 1000 },
        ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'm1' },
      },
    }
    const overrides = { provider: { backup: null, claudeCli: { model: 'opus' }, ollama: { model: 'm2' } } }
    expect(mergeConfigJson(base, overrides)).toEqual({
      provider: {
        primary: 'claude-cli',
        backup: null,
        claudeCli: { command: 'claude', model: 'opus', timeoutMs: 1000 },
        ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'm2' },
      },
    })
  })

  it('keeps a value of the wrong shape so the validation reports it', () => {
    expect(mergeConfigJson({ provider: { primary: 'ollama' } }, { provider: 'x' })).toEqual({ provider: 'x' })
    expect(mergeConfigJson({ provider: 'x' }, { provider: { primary: 'ollama' } })).toEqual({
      provider: { primary: 'ollama' },
    })
  })

  it('unions the privacy lists with the installation, deduplicated, installation first', () => {
    expect(
      mergeConfigJson(
        { localOnlyPatterns: ['bank', 'tax'], excludePatterns: ['spam'] },
        { localOnlyPatterns: ['tax', 'clinic'], excludePatterns: ['ads'] },
      ),
    ).toEqual({ localOnlyPatterns: ['bank', 'tax', 'clinic'], excludePatterns: ['spam', 'ads'] })
  })

  it('never lets an account weaken a privacy list: an empty list or a missing one keeps the installation list', () => {
    expect(mergeConfigJson({ localOnlyPatterns: ['bank'] }, { localOnlyPatterns: [] })).toEqual({
      localOnlyPatterns: ['bank'],
    })
    expect(mergeConfigJson({ excludePatterns: ['spam'] }, {})).toEqual({ excludePatterns: ['spam'] })
    expect(mergeConfigJson({}, { excludePatterns: ['ads'] })).toEqual({ excludePatterns: ['ads'] })
    // a value of the wrong shape is not a way around it: it is kept so the validation rejects it
    expect(mergeConfigJson({ localOnlyPatterns: ['bank'] }, { localOnlyPatterns: null })).toEqual({
      localOnlyPatterns: null,
    })
  })

  it('changes neither input', () => {
    const base = { provider: { claudeCli: { model: 'a' } } }
    const overrides = { provider: { claudeCli: { model: 'b' } } }
    mergeConfigJson(base, overrides)
    expect(base).toEqual({ provider: { claudeCli: { model: 'a' } } })
    expect(overrides).toEqual({ provider: { claudeCli: { model: 'b' } } })
  })
})

describe('loadEffectiveConfig', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const setup = (root?: string, account?: string): { rootFile: string; accountFile: string; dir: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'msum-effective-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'accounts', 'work'), { recursive: true })
    const rootFile = join(dir, 'config.json')
    const accountFile = join(dir, 'accounts', 'work', 'config.json')
    if (root !== undefined) writeFileSync(rootFile, root)
    if (account !== undefined) writeFileSync(accountFile, account)
    return { rootFile, accountFile, dir }
  }

  it('is the installation config when the account has no file', async () => {
    const { rootFile, accountFile } = setup('{"language":"en","concurrency":3}')
    const result = await loadEffectiveConfig(rootFile, accountFile, BA)
    expect(result.ok && result.value.language === 'en' && result.value.concurrency === 3).toBe(true)
  })

  it('gives the defaults when neither file exists', async () => {
    const { rootFile, accountFile } = setup()
    const result = await loadEffectiveConfig(rootFile, accountFile, BA)
    expect(result.ok && result.value.language === 'es').toBe(true)
  })

  it('lets the account override the installation, per option', async () => {
    const { rootFile, accountFile } = setup(
      JSON.stringify({
        language: 'en',
        concurrency: 3,
        provider: { primary: 'claude-cli', claudeCli: { model: 'sonnet' } },
      }),
      JSON.stringify({ concurrency: 5, provider: { claudeCli: { model: 'opus' } } }),
    )
    const result = await loadEffectiveConfig(rootFile, accountFile, BA)
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.value.language).toBe('en')
    expect(result.value.concurrency).toBe(5)
    expect(result.value.provider.primary).toBe('claude-cli')
    expect(result.value.provider.claudeCli.model).toBe('opus')
    expect(result.value.provider.claudeCli.command).toBe('claude')
  })

  it('names the account file for an option it sets, and the installation file otherwise', async () => {
    const { rootFile, accountFile } = setup('{"hideRest":"yes"}', '{"concurrency":0,"nope":1}')
    const result = await loadEffectiveConfig(rootFile, accountFile, BA)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContainEqual({ option: 'hideRest', code: 'notBoolean', file: rootFile })
    expect(result.error).toContainEqual({ option: 'concurrency', code: 'notPositive', file: accountFile })
    expect(result.error).toContainEqual({ option: 'nope', code: 'unknownOption', file: accountFile })
    const line = describeConfigIssue(getCatalog('en'), {
      option: 'concurrency',
      code: 'notPositive',
      file: accountFile,
    })
    expect(line).toContain(accountFile)
    expect(line).toContain('concurrency')
    expect(
      describeConfigIssue(getCatalog('es'), { option: 'concurrency', code: 'notPositive', file: accountFile }),
    ).toContain(accountFile)
  })

  it('validates the merged result: a rule that spans both files is checked once, on the whole', async () => {
    // the account asks for local-only chats; the model Ollama needs is in neither file
    const { rootFile, accountFile } = setup('{}', '{"localOnlyPatterns":["bank"]}')
    const missing = await loadEffectiveConfig(rootFile, accountFile, BA)
    expect(missing.ok).toBe(false)
    // the installation provides the model: valid
    const { rootFile: root2, accountFile: account2 } = setup(
      '{"provider":{"ollama":{"model":"m"}}}',
      '{"localOnlyPatterns":["bank"]}',
    )
    expect((await loadEffectiveConfig(root2, account2, BA)).ok).toBe(true)
  })

  it('runs an account with the union of the privacy lists, and rejects an account that tries to null them', async () => {
    const { rootFile, accountFile } = setup(
      '{"localOnlyPatterns":["bank"],"excludePatterns":["spam"],"provider":{"ollama":{"model":"m"}}}',
      '{"localOnlyPatterns":["clinic"],"excludePatterns":[]}',
    )
    const result = await loadEffectiveConfig(rootFile, accountFile, BA)
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.value.localOnlyPatterns).toEqual(['bank', 'clinic'])
    expect(result.value.digest.excludePatterns).toEqual(['spam'])
    const weakening = setup('{"localOnlyPatterns":["bank"]}', '{"localOnlyPatterns":null}')
    const rejected = await loadEffectiveConfig(weakening.rootFile, weakening.accountFile, BA)
    expect(rejected.ok).toBe(false)
  })

  it('rejects a web section in an account file, naming that file, and accepts it in the installation one', async () => {
    const found = setup('{"web":{"port":9000}}', '{"web":{"port":9001}}')
    expect(await loadEffectiveConfig(found.rootFile, found.accountFile, BA)).toEqual({
      ok: false,
      error: [{ option: 'web', code: 'installationOnly', file: found.accountFile }],
    })
    const fine = setup('{"web":{"port":9000}}', '{"language":"en"}')
    const result = await loadEffectiveConfig(fine.rootFile, fine.accountFile, BA)
    expect(result.ok && result.value.web.port).toBe(9000)
    // without an account file, the installation's own web section is the one read
    expect((await loadEffectiveConfig(fine.rootFile, null, BA)).ok).toBe(true)
  })

  it('rejects a logs section in an account file, naming that file, and accepts it in the installation one', async () => {
    const found = setup('{"logs":{"maxBytes":2000000}}', '{"logs":{"maxBytes":3000000}}')
    expect(await loadEffectiveConfig(found.rootFile, found.accountFile, BA)).toEqual({
      ok: false,
      error: [{ option: 'logs', code: 'installationOnly', file: found.accountFile }],
    })
    const both = setup('{}', '{"web":{},"logs":{}}')
    const rejected = await loadEffectiveConfig(both.rootFile, both.accountFile, BA)
    expect(rejected.ok ? [] : rejected.error.map((issue) => issue.option)).toEqual(['web', 'logs'])
    const fine = setup('{"logs":{"maxBytes":2000000}}', '{"language":"en"}')
    const result = await loadEffectiveConfig(fine.rootFile, fine.accountFile, BA)
    expect(result.ok && result.value.logs.maxBytes).toBe(2_000_000)
  })

  it('reports a file that is not JSON, or not an object, with its name', async () => {
    const bad = setup('{"language":"en"}', '{oops')
    expect(await loadEffectiveConfig(bad.rootFile, bad.accountFile, BA)).toEqual({
      ok: false,
      error: [{ option: '(config)', code: 'invalidJson', file: bad.accountFile }],
    })
    const list = setup('[]', '{}')
    expect(await loadEffectiveConfig(list.rootFile, list.accountFile, BA)).toEqual({
      ok: false,
      error: [{ option: '(config)', code: 'notObject', file: list.rootFile }],
    })
  })

  it('resolves a relative promptFile against the directory of the file that set it', async () => {
    const both = setup('{"promptFile":"root.md"}', '{"promptFile":"mine.md"}')
    const fromAccount = await loadEffectiveConfig(both.rootFile, both.accountFile, BA)
    expect(fromAccount.ok && fromAccount.value.promptFile).toBe(join(both.dir, 'accounts', 'work', 'mine.md'))
    const onlyRoot = setup('{"promptFile":"prompts/root.md"}', '{}')
    const fromRoot = await loadEffectiveConfig(onlyRoot.rootFile, onlyRoot.accountFile, BA)
    expect(fromRoot.ok && fromRoot.value.promptFile).toBe(join(onlyRoot.dir, 'prompts', 'root.md'))
    // an absolute path is kept as it is (on Windows a path with no drive letter takes the drive of the config file, so the
    // test names the drive)
    const abs = process.platform === 'win32' ? 'C:\\srv\\prompt.md' : '/srv/prompt.md'
    const absolute = setup(JSON.stringify({ promptFile: abs }))
    const kept = await loadEffectiveConfig(absolute.rootFile, absolute.accountFile, BA)
    expect(kept.ok && kept.value.promptFile).toBe(resolve(abs))
  })

  it('takes the language to talk in from the account file first, then the installation, then the default', async () => {
    const one = setup('{"language":"en"}', '{"language":"es"}')
    expect(await languageHint(one.rootFile, one.accountFile)).toBe('es')
    const two = setup('{"language":"en"}', '{"concurrency":-1}')
    expect(await languageHint(two.rootFile, two.accountFile)).toBe('en')
    const three = setup('{nope', '{nope')
    expect(await languageHint(three.rootFile, three.accountFile)).toBe('es')
  })
})

describe('askPresets', () => {
  const preset = { name: 'Pedidos', text: 'Armá la lista de pedidos.' }

  it('defaults to none: the web then offers the defaults of the language', () => {
    const empty = parse({})
    expect(empty.ok && empty.value.askPresets).toEqual([])
    expect(JSON.parse(defaultConfigJson(BA)).askPresets).toEqual([])
  })

  it('reads a list of presets, trimming name and text', () => {
    const result = parse({ askPresets: [preset, { name: '  Turnos ', text: ' qué turnos hay \n' }] })
    expect(result.ok && result.value.askPresets).toEqual([preset, { name: 'Turnos', text: 'qué turnos hay' }])
  })

  it('accepts the limits exactly: 20 presets, a name of 60 and a text of 4000 characters', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `n${i}`, text: 't' }))
    expect(parse({ askPresets: many }).ok).toBe(true)
    expect(parse({ askPresets: [{ name: 'n'.repeat(60), text: 't'.repeat(4000) }] }).ok).toBe(true)
  })

  it.each([
    ['not a list', 'x', [{ option: 'askPresets', code: 'notArray' }]],
    ['too many', Array.from({ length: 21 }, () => preset), [{ option: 'askPresets', code: 'tooManyPresets' }]],
    ['an entry that is not an object', ['x'], [{ option: 'askPresets[0]', code: 'invalidPreset' }]],
    [
      'an extra key (a mode is not a preset field)',
      [{ ...preset, mode: 'x' }],
      [{ option: 'askPresets[0]', code: 'invalidPreset' }],
    ],
    ['a name that is not text', [{ name: 1, text: 't' }], [{ option: 'askPresets[0]', code: 'invalidPreset' }]],
    ['an empty name', [{ name: ' ', text: 't' }], [{ option: 'askPresets[0].name', code: 'emptyPresetName' }]],
    [
      'a long name',
      [{ name: 'n'.repeat(61), text: 't' }],
      [{ option: 'askPresets[0].name', code: 'presetNameTooLong' }],
    ],
    ['an empty text', [{ name: 'n', text: '' }], [{ option: 'askPresets[0].text', code: 'emptyPresetText' }]],
    [
      'a long text',
      [{ name: 'n', text: 't'.repeat(4001) }],
      [{ option: 'askPresets[0].text', code: 'presetTextTooLong' }],
    ],
    [
      'two bad entries, each named',
      [{ name: '', text: 't' }, preset, { name: 'n', text: '' }],
      [
        { option: 'askPresets[0].name', code: 'emptyPresetName' },
        { option: 'askPresets[2].text', code: 'emptyPresetText' },
      ],
    ],
  ])('rejects %s', (_name, askPresets, issues) => {
    const result = parse({ askPresets })
    expect(!result.ok && result.error).toEqual(issues)
  })

  it('the account replaces the installation (it does not add to it)', () => {
    const root = { askPresets: [{ name: 'Root', text: 'r' }] }
    const account = { askPresets: [{ name: 'Mine', text: 'm' }] }
    const merged = validateEffective(root, account, 'root.json', 'account.json')
    expect(merged.ok && merged.value.askPresets).toEqual([{ name: 'Mine', text: 'm' }])
    const inherited = validateEffective(root, {}, 'root.json', 'account.json')
    expect(inherited.ok && inherited.value.askPresets).toEqual([{ name: 'Root', text: 'r' }])
  })
})

describe('askHints', () => {
  const hint = { when: ['encargo', 'encargos'], text: 'An encargo is a custom cake order.' }

  it('is empty by default and accepts valid hints', () => {
    const empty = parse({})
    expect(empty.ok && empty.value.askHints).toEqual([])
    const result = parse({ askHints: [hint, { when: ['turno'], text: 'A turno is a pickup slot.' }] })
    expect(result.ok && result.value.askHints).toEqual([hint, { when: ['turno'], text: 'A turno is a pickup slot.' }])
  })

  it('is part of the written default config only as an empty list', () => {
    expect(JSON.parse(defaultConfigJson(BA)).askHints).toEqual([])
  })

  it.each([
    ['not a list', 'x', [{ option: 'askHints', code: 'notArray' }]],
    ['an entry that is not an object', ['x'], [{ option: 'askHints[0]', code: 'invalidHint' }]],
    ['an extra key', [{ ...hint, extra: 1 }], [{ option: 'askHints[0]', code: 'invalidHint' }]],
    ['when missing', [{ text: 'a' }], [{ option: 'askHints[0].when', code: 'notStringList' }]],
    ['when not texts', [{ when: [1], text: 'a' }], [{ option: 'askHints[0].when', code: 'notStringList' }]],
    ['when empty', [{ when: [], text: 'a' }], [{ option: 'askHints[0].when', code: 'emptyHintWhen' }]],
    ['an empty term', [{ when: ['a', ' '], text: 'a' }], [{ option: 'askHints[0].when', code: 'emptyHintWhen' }]],
    [
      'too many terms',
      [{ when: Array.from({ length: 21 }, (_, i) => `t${i}`), text: 'a' }],
      [{ option: 'askHints[0].when', code: 'tooManyHintTerms' }],
    ],
    ['text missing', [{ when: ['a'] }], [{ option: 'askHints[0].text', code: 'notString' }]],
    ['text empty', [{ when: ['a'], text: '  ' }], [{ option: 'askHints[0].text', code: 'emptyHintText' }]],
    [
      'text too long',
      [{ when: ['a'], text: 'x'.repeat(2001) }],
      [{ option: 'askHints[0].text', code: 'hintTextTooLong' }],
    ],
    ['too many hints', Array.from({ length: 21 }, () => hint), [{ option: 'askHints', code: 'tooManyHints' }]],
    [
      'the index of the bad entry',
      [hint, { when: [], text: 'a' }],
      [{ option: 'askHints[1].when', code: 'emptyHintWhen' }],
    ],
  ])('refuses %s', (_name, askHints, expected) => {
    expect(issuesOf({ askHints })).toEqual(expected)
  })

  it('accepts a text of exactly the limit and 20 hints and 20 terms', () => {
    const edge = { when: Array.from({ length: 20 }, (_, i) => `t${i}`), text: 'x'.repeat(2000) }
    expect(parse({ askHints: Array.from({ length: 20 }, () => edge) }).ok).toBe(true)
  })

  it('has messages in both languages that name the entry', () => {
    const issue: ConfigIssue = { option: 'askHints[2].when', code: 'emptyHintWhen' }
    expect(describeConfigIssue(getCatalog('es'), issue)).toContain('askHints[2].when')
    expect(describeConfigIssue(getCatalog('en'), issue)).toContain('askHints[2].when')
  })

  it('of an account replaces the installation hints instead of adding to them', () => {
    const base = { askHints: [hint] }
    const account = { askHints: [{ when: ['turno'], text: 'A turno is a pickup slot.' }] }
    expect(mergeConfigJson(base, account).askHints).toEqual(account.askHints)
    expect(mergeConfigJson(base, {}).askHints).toEqual(base.askHints)
    expect(mergeConfigJson(base, { askHints: [] }).askHints).toEqual([])
  })
})

describe('fullHistoryOnLink', () => {
  it('is false by default and can be turned on per account', () => {
    const off = parse({})
    const on = parse({ fullHistoryOnLink: true })
    expect(off.ok && off.value.fullHistoryOnLink).toBe(false)
    expect(on.ok && on.value.fullHistoryOnLink).toBe(true)
  })

  it('must be true or false, with the message in both languages', () => {
    const issues = issuesOf({ fullHistoryOnLink: 'yes' })
    expect(issues).toEqual([{ option: 'fullHistoryOnLink', code: 'notBoolean' }])
    const [issue] = issues
    if (issue === undefined) throw new Error('no issue')
    expect(describeConfigIssue(getCatalog('es'), issue)).toContain('fullHistoryOnLink')
    expect(describeConfigIssue(getCatalog('en'), issue)).toContain('fullHistoryOnLink')
    expect(describeConfigIssue(getCatalog('en'), issue)).toContain('true or false')
  })

  it('is written with its default by `msum init`', () => {
    expect(JSON.parse(defaultConfigJson(BA)).fullHistoryOnLink).toBe(false)
  })
})
