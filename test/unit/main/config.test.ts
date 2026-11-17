import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  loadEffectiveConfig,
  mergeConfigJson,
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
      transcription: {
        enabled: false,
        whisperCommand: 'whisper-cli',
        ffmpegCommand: 'ffmpeg',
        model: null,
        language: 'auto',
        timeoutMs: 300_000,
        historyAudioDays: 14,
        maxMediaMb: 500,
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
      { option: 'provider.primary', code: 'notOneOf', allowed: ['claude-cli', 'ollama'] },
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
    expect(issuesOf({ transcription: { historyAudioDays: 0 } })).toEqual([
      { option: 'transcription.historyAudioDays', code: 'notPositive' },
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
    const absolute = setup('{"promptFile":"/srv/prompt.md"}')
    const kept = await loadEffectiveConfig(absolute.rootFile, absolute.accountFile, BA)
    expect(kept.ok && kept.value.promptFile).toBe('/srv/prompt.md')
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
