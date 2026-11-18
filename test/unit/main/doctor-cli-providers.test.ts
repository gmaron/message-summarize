import { afterEach, describe, expect, it, vi } from 'vitest'
import { runMain } from '../../../src/main/app.js'
import { disposeHarnesses, type Harness, makeHarness } from '../../support/cli-harness.js'
import { type FakeCli, installFakeCli } from '../../support/fake-cli.js'

const created: FakeCli[] = []
afterEach(() => {
  vi.restoreAllMocks()
  disposeHarnesses()
  for (const cli of created.splice(0)) cli.dispose()
})

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const providerText = (h: Harness) => h.out.filter((line) => /LLM provider|Proveedor/.test(line)).join('\n')

describe('msum doctor with the Claude CLI (RF-49)', () => {
  const base = { language: 'en', provider: { primary: 'claude-cli' } }

  it('says it was found, with its version, and that the version can be run without tools', async () => {
    const h = await makeHarness({ config: base })
    await run(h, 'doctor')
    expect(providerText(h)).toContain('[ok]   LLM provider: claude-cli (1.0.0 (fake))')
    expect(providerText(h)).toContain('its --help lists every flag that turns the tools off')
  })

  it('fails with the flags that are missing, and says how to fix it', async () => {
    const h = await makeHarness({
      config: base,
      probes: { verifyCli: async () => ({ ok: false, kind: 'missingFlags', flags: ['--safe-mode', '--tools'] }) },
    })
    expect(await run(h, 'doctor')).toBe(1)
    expect(providerText(h)).toContain(
      '[fail] LLM provider: this version of claude-cli cannot be run without tools: its --help does not list --safe-mode, --tools',
    )
    expect(h.out.join('\n')).toContain('update claude-cli to a version that has those flags')
  })

  it('says so in Spanish', async () => {
    const h = await makeHarness({
      config: { ...base, language: 'es' },
      probes: { verifyCli: async () => ({ ok: false, kind: 'missingFlags', flags: ['--tools'] }) },
    })
    await run(h, 'doctor')
    expect(h.out.join('\n')).toContain('no se puede ejecutar sin herramientas')
  })

  it('fails when --help does not run', async () => {
    const h = await makeHarness({
      config: base,
      probes: { verifyCli: async () => ({ ok: false, kind: 'unrunnable' }) },
    })
    expect(await run(h, 'doctor')).toBe(1)
    expect(h.out.join('\n')).toContain('could not check claude-cli')
  })
})

describe('msum doctor with the presets shipped disabled', () => {
  it.each(['gemini-cli', 'codex-cli'])('%s: fails, says it is disabled, and runs nothing', async (kind) => {
    const calls: string[] = []
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: kind } },
      probes: {
        commandVersion: async () => {
          calls.push('version')
          return '1'
        },
        verifyCli: async () => {
          calls.push('verify')
          return { ok: true, path: '/x', version: null }
        },
      },
    })
    expect(await run(h, 'doctor')).toBe(1)
    expect(providerText(h)).toContain(`${kind} is disabled: its documentation offers no way to run it without tools`)
    expect(h.out.join('\n')).toContain('generic-cli')
    expect(calls).toEqual([])
  })
})

describe('msum doctor with the generic CLI', () => {
  it('fails, with the warning, when the risk is not acknowledged', async () => {
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: 'generic-cli', genericCli: { command: ['some-tool'] } } },
    })
    expect(await run(h, 'doctor')).toBe(1)
    expect(providerText(h)).toContain('[fail] LLM provider: generic-cli is refused: its command may use tools')
    expect(h.out.join('\n')).toContain('acknowledgeRisk')
  })

  it('warns every time when it is acknowledged, and fails when the program is not there', async () => {
    const h = await makeHarness({
      config: {
        language: 'en',
        provider: { primary: 'generic-cli', genericCli: { command: ['no-such-tool-xyz'], acknowledgeRisk: true } },
      },
    })
    expect(await run(h, 'doctor')).toBe(1)
    const text = providerText(h)
    expect(text).toContain(
      '[warn] LLM provider: running "no-such-tool-xyz": it may use tools on chat text written by third parties',
    )
    expect(text).toContain('could not run "no-such-tool-xyz"')
  })

  it('only warns when the program is there', async () => {
    const cli = installFakeCli()
    created.push(cli)
    const h = await makeHarness({
      config: {
        language: 'en',
        provider: { primary: 'generic-cli', genericCli: { command: [cli.path], acknowledgeRisk: true } },
      },
    })
    await run(h, 'doctor')
    expect(providerText(h)).toContain('[warn] LLM provider: running')
    expect(providerText(h)).not.toContain('could not run')
    expect(providerText(h)).not.toContain('{{prompt}}')
    expect(cli.calls()).toEqual([])
  })

  it.each([
    [
      'en',
      'the command uses {{prompt}}: the chat goes in the arguments, where other users of this machine can read it',
    ],
    [
      'es',
      'el comando usa {{prompt}}: el chat va en los argumentos, donde otros usuarios de esta máquina pueden leerlo',
    ],
  ])('warns that {{prompt}} in the arguments exposes the chat (%s)', async (language, text) => {
    const cli = installFakeCli()
    created.push(cli)
    const h = await makeHarness({
      config: {
        language,
        provider: { primary: 'generic-cli', genericCli: { command: [cli.path, '{{prompt}}'], acknowledgeRisk: true } },
      },
    })
    await run(h, 'doctor')
    expect(h.out.join('\n')).toContain(text)
    expect(h.out.join('\n')).toContain('stdin')
  })
})

describe('the startup warning of the generic CLI', () => {
  it('msum digest says it before running, in the language of the configuration', async () => {
    const cli = installFakeCli({ steps: [{ kind: 'text', text: '{}' }] })
    created.push(cli)
    const config = (language: string, acknowledgeRisk: boolean) => ({
      language,
      timezone: 'UTC',
      provider: { primary: 'generic-cli', genericCli: { command: [cli.path], acknowledgeRisk } },
    })
    const en = await makeHarness({ config: config('en', true), summarizer: undefined })
    delete (en.ctx as { summarizer?: unknown }).summarizer
    await run(en, 'digest', '--dry-run')
    expect(en.err.join('\n')).toContain('You accepted this risk')

    const es = await makeHarness({ config: config('es', false), summarizer: undefined })
    delete (es.ctx as { summarizer?: unknown }).summarizer
    await run(es, 'digest', '--dry-run')
    expect(es.err.join('\n')).toContain('NO se ejecuta')
  })

  it('is not said when another provider is in use', async () => {
    const h = await makeHarness({ config: { language: 'en', provider: { primary: 'claude-cli' } } })
    await run(h, 'digest', '--dry-run')
    expect(h.err.join('\n')).not.toContain('generic CLI')
  })
})
