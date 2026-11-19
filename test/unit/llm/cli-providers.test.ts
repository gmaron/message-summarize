import { afterEach, describe, expect, it } from 'vitest'
import type { SummarizeRequest } from '../../../src/application/ports/summarizer.js'
import {
  ClaudeCliSummarizer,
  composeSummarizer,
  DisabledCliSummarizer,
  GENERIC_RISK_REFUSAL,
  GenericCliSummarizer,
  LOCAL_ONLY_UNAVAILABLE,
  OllamaSummarizer,
  verifyDisabledPreset,
} from '../../../src/infrastructure/llm/index.js'
import { type AppConfig, parseConfig } from '../../../src/main/config.js'
import { buildSummarizer } from '../../../src/main/providers.js'
import { VALID_SUMMARY } from '../../contract/summarizer.contract.js'
import { type FakeCli, installFakeCli } from '../../support/fake-cli.js'
import { isWindows } from '../../support/platform.js'

// On Windows the tests that run the fake CLI are skipped: it is a script with a shebang, and the adapters spawn without
// a shell (RF-49), so Windows cannot execute it (a .cmd wrapper would need `shell: true`, which the rule forbids).
// The behavior they check is cross-platform code; it is covered on Linux and macOS.

const created: FakeCli[] = []
const fake = (text = JSON.stringify(VALID_SUMMARY)): FakeCli => {
  const cli = installFakeCli({ steps: [{ kind: 'text', text }] })
  created.push(cli)
  return cli
}
afterEach(() => {
  for (const cli of created.splice(0)) cli.dispose()
})

const request = (name: string): SummarizeRequest => ({
  conversation: { id: `${name.toLowerCase().replace(/\W/g, '')}@s.whatsapp.net`, name, isGroup: false },
  systemPrompt: 'prompt',
  transcript: `Chat con: ${name}\n\n${name}: el PIN del banco es 0000`,
})

describe('the presets shipped disabled (RF-49)', () => {
  it.each(['gemini-cli', 'codex-cli'] as const)(
    '%s fails every call at once, saying it is disabled, and runs nothing',
    async (preset) => {
      // the subprocess guard of the tests would throw if anything were spawned
      const summarizer = new DisabledCliSummarizer(preset)
      const result = await summarizer.summarize()
      expect(result).toEqual({
        ok: false,
        error: `${preset} is disabled: its documentation offers no way to run it without tools (RF-49)`,
      })
      expect(verifyDisabledPreset()).toEqual({ ok: false, kind: 'disabled' })
    },
  )

  it('are wired by the configuration as disabled', async () => {
    const config = parseConfig({ provider: { primary: 'gemini-cli', backup: 'codex-cli' } }, 'UTC')
    if (!config.ok) throw new Error(JSON.stringify(config.error))
    const summarizer = buildSummarizer(config.value, {})
    const result = await summarizer?.summarize(request('Ana'))
    expect(result?.ok).toBe(false)
    if (result && !result.ok) {
      expect(result.error).toContain('gemini-cli is disabled')
      expect(result.error).toContain('codex-cli is disabled')
    }
  })
})

describe('the generic CLI through the configuration', () => {
  const config = (provider: Record<string, unknown>, extra: Record<string, unknown> = {}): AppConfig => {
    const parsed = parseConfig({ ...extra, provider }, 'UTC')
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
    return parsed.value
  }

  it.skipIf(isWindows)('runs the command of the configuration when the risk is acknowledged', async () => {
    const cli = fake()
    const summarizer = buildSummarizer(
      config({ primary: 'generic-cli', genericCli: { command: [cli.path, '-x'], acknowledgeRisk: true } }),
      { PATH: process.env.PATH },
    )
    // Built by the configuration, so the answer says who gave it (the history counts it, RF-74).
    expect(await summarizer?.summarize(request('Trabajo'))).toEqual({
      ok: true,
      value: VALID_SUMMARY,
      provider: 'generic-cli',
    })
    expect(cli.calls('run')[0]?.argv).toEqual(['-x'])
  })

  it('refuses without it, and runs nothing', async () => {
    const cli = fake()
    const summarizer = buildSummarizer(config({ primary: 'generic-cli', genericCli: { command: [cli.path] } }), {})
    expect(await summarizer?.summarize(request('Trabajo'))).toEqual({ ok: false, error: GENERIC_RISK_REFUSAL })
    expect(cli.calls()).toEqual([])
  })
})

describe('every CLI is external: a local-only conversation never reaches one (RF-43)', () => {
  const generic = (cli: FakeCli) => new GenericCliSummarizer({ command: [cli.path], acknowledgeRisk: true })
  const claude = (cli: FakeCli) =>
    new ClaudeCliSummarizer({ command: cli.path, model: 'sonnet', env: { PATH: process.env.PATH } })

  it.each([
    ['generic', generic],
    ['claude', claude],
  ])('%s: skipped and reported when Ollama is missing', async (_name, build) => {
    const cli = fake(JSON.stringify({ is_error: false, structured_output: VALID_SUMMARY }))
    const composed = composeSummarizer({ primary: build(cli), backup: build(cli), localOnlyPatterns: ['banco'] })
    expect(await composed.summarize(request('Banco Ana'))).toEqual({ ok: false, error: LOCAL_ONLY_UNAVAILABLE })
    expect(cli.calls()).toEqual([])
  })

  it.each([
    ['generic', generic],
    ['claude', claude],
  ])('%s: and not when Ollama is there and fails', async (_name, build) => {
    const cli = fake(JSON.stringify({ is_error: false, structured_output: VALID_SUMMARY }))
    const ollama = new OllamaSummarizer({ model: 'm', baseUrl: 'http://127.0.0.1:1' })
    const composed = composeSummarizer({
      primary: build(cli),
      backup: build(cli),
      local: ollama,
      localOnlyPatterns: ['banco'],
    })
    const result = await composed.summarize(request('Banco Ana'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/^could not reach ollama/)
    expect(cli.calls()).toEqual([])
  })

  it.skipIf(isWindows)(
    'with the generic CLI configured, a local-only chat goes to Ollama and an ordinary one to the CLI',
    async () => {
      const cli = fake()
      const parsed = parseConfig(
        {
          localOnlyPatterns: ['banco'],
          provider: {
            primary: 'generic-cli',
            genericCli: { command: [cli.path], acknowledgeRisk: true },
            ollama: { model: 'qwen', baseUrl: 'http://127.0.0.1:1' },
          },
        },
        'UTC',
      )
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
      const summarizer = buildSummarizer(parsed.value, { PATH: process.env.PATH })
      const local = await summarizer?.summarize(request('Banco Ana'))
      expect(local?.ok).toBe(false)
      if (local && !local.ok) expect(local.error).toMatch(/^could not reach ollama/)
      expect(cli.calls()).toEqual([])
      expect((await summarizer?.summarize(request('Trabajo')))?.ok).toBe(true)
      expect(cli.calls('run')).toHaveLength(1)
    },
  )
})
