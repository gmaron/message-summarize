import { describe, expect, it } from 'vitest'
import { getCatalog } from '../../../../src/infrastructure/i18n/index.js'
import {
  describeConfigIssue,
  mergeConfigJson,
  parseConfig,
  usesGenericCli,
} from '../../../../src/main/config/config.js'

const parse = (input: Record<string, unknown>) => parseConfig(input, 'UTC')
const issues = (input: Record<string, unknown>) => {
  const result = parse(input)
  return result.ok ? [] : result.error
}

describe('CLI providers in the configuration (RF-47)', () => {
  it('accepts gemini-cli, codex-cli and generic-cli as the primary and the backup', () => {
    expect(parse({ provider: { primary: 'gemini-cli', backup: 'codex-cli' } }).ok).toBe(true)
    expect(
      parse({ provider: { primary: 'claude-cli', backup: 'generic-cli', genericCli: { command: ['tool'] } } }).ok,
    ).toBe(true)
  })

  it('has defaults: gemini and codex as commands, no command for the generic CLI, risk not acknowledged', () => {
    const result = parse({})
    if (!result.ok) throw new Error('invalid')
    expect(result.value.provider.geminiCli).toEqual({ command: 'gemini', model: null, timeoutMs: 180_000 })
    expect(result.value.provider.codexCli).toEqual({ command: 'codex', model: null, timeoutMs: 180_000 })
    expect(result.value.provider.genericCli).toEqual({ command: null, timeoutMs: 180_000, acknowledgeRisk: false })
  })

  it('reads the options of each CLI', () => {
    const result = parse({
      provider: {
        geminiCli: { command: '/opt/gemini', model: 'flash', timeoutMs: 1000 },
        codexCli: { command: '/opt/codex', timeoutMs: 2000 },
        genericCli: { command: ['my-llm', '--json', '{{prompt}}'], timeoutMs: 3000, acknowledgeRisk: true },
      },
    })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.value.provider.geminiCli).toEqual({ command: '/opt/gemini', model: 'flash', timeoutMs: 1000 })
    expect(result.value.provider.codexCli).toEqual({ command: '/opt/codex', model: null, timeoutMs: 2000 })
    expect(result.value.provider.genericCli).toEqual({
      command: ['my-llm', '--json', '{{prompt}}'],
      timeoutMs: 3000,
      acknowledgeRisk: true,
    })
  })

  it('the generic CLI has no default command: choosing it without one is an error', () => {
    expect(issues({ provider: { primary: 'generic-cli' } })).toEqual([
      { option: 'provider.genericCli.command', code: 'required' },
    ])
    expect(issues({ provider: { primary: 'claude-cli', backup: 'generic-cli' } })).toEqual([
      { option: 'provider.genericCli.command', code: 'required' },
    ])
  })

  it('not acknowledging the risk is not a configuration error: the CLI refuses to run and doctor says why', () => {
    expect(parse({ provider: { primary: 'generic-cli', genericCli: { command: ['tool'] } } }).ok).toBe(true)
  })

  it.each([
    [['{{prompt}}'], 'the placeholder as the program'],
    [['tool{{prompt}}'], 'the placeholder in the program'],
    [['tool', '--p={{prompt}}'], 'the placeholder inside a longer element'],
    [[], 'an empty command'],
  ])('rejects the command %j (%s)', (command) => {
    expect(issues({ provider: { genericCli: { command } } })).toEqual([
      { option: 'provider.genericCli.command', code: 'invalidCommandTemplate' },
    ])
  })

  it('rejects a command that is not a list of texts, and a risk that is not true or false', () => {
    expect(issues({ provider: { genericCli: { command: 'tool --json' } } })).toEqual([
      { option: 'provider.genericCli.command', code: 'notArray' },
    ])
    expect(issues({ provider: { genericCli: { command: ['tool', 5] } } })).toEqual([
      { option: 'provider.genericCli.command', code: 'notStringList' },
    ])
    expect(issues({ provider: { genericCli: { command: ['tool'], acknowledgeRisk: 'yes' } } })).toEqual([
      { option: 'provider.genericCli.acknowledgeRisk', code: 'notBoolean' },
    ])
    expect(issues({ provider: { genericCli: { shell: true } } })).toEqual([
      { option: 'provider.genericCli.shell', code: 'unknownOption' },
    ])
  })

  it('says it in English and Spanish', () => {
    const [issue] = issues({ provider: { genericCli: { command: ['{{prompt}}'] } } })
    expect(issue && describeConfigIssue(getCatalog('en'), issue)).toContain('never the program')
    expect(issue && describeConfigIssue(getCatalog('es'), issue)).toContain('nunca el programa')
  })

  it('merges per account key by key, and the account may bring its own command', () => {
    const merged = mergeConfigJson(
      { provider: { genericCli: { command: ['a'], timeoutMs: 1000, acknowledgeRisk: true } } },
      { provider: { genericCli: { command: ['b', '--x'] } } },
    )
    expect(merged.provider).toEqual({ genericCli: { command: ['b', '--x'], timeoutMs: 1000, acknowledgeRisk: true } })
  })

  it('knows when the generic CLI is in use', () => {
    const config = (provider: Record<string, unknown>) => {
      const result = parse({ provider: { genericCli: { command: ['t'] }, ...provider } })
      if (!result.ok) throw new Error('invalid')
      return result.value
    }
    expect(usesGenericCli(config({ primary: 'generic-cli' }))).toBe(true)
    expect(usesGenericCli(config({ primary: 'claude-cli', backup: 'generic-cli' }))).toBe(true)
    expect(usesGenericCli(config({ primary: 'claude-cli' }))).toBe(false)
  })
})
