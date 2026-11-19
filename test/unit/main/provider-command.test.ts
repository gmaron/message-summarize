import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCommandLine } from '../../../src/interfaces/cli/args.js'
import { runMain } from '../../../src/main/app.js'
import { classifyFailure, TEST_CONTACT, TEST_OWNER } from '../../../src/main/commands/provider.js'
import { REQUEST, VALID_SUMMARY } from '../../contract/summarizer.contract.js'
import { disposeHarnesses, type Harness, makeHarness, seedMessages } from '../../support/cli-harness.js'
import { CLAUDE_HELP, type FakeCli, installFakeCli } from '../../support/fake-cli.js'
import { type FakeServer, startFakeServer } from '../../support/fake-http-server.js'
import { isWindows } from '../../support/platform.js'

// On Windows the tests that run the fake CLI are skipped: it is a script with a shebang, and the adapters spawn without
// a shell (RF-49), so Windows cannot execute it (a .cmd wrapper would need `shell: true`, which the rule forbids).
// The behavior they check is cross-platform code; it is covered on Linux and macOS.

const servers: FakeServer[] = []
const clis: FakeCli[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  disposeHarnesses()
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const cli of clis.splice(0)) cli.dispose()
})

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const text = (h: Harness) => h.out.join('\n')
const errors = (h: Harness) => h.err.join('\n')
const everything = (h: Harness) => `${text(h)}\n${errors(h)}`
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
const SENTINEL = 'SENTINEL-MENSAJE-PRIVADO-NO-ENVIAR'
const KEY = 'sk-test-ABCDEFGHIJ0123456789'

const serve = async (...replies: Parameters<FakeServer['script']>): Promise<FakeServer> => {
  const server = await startFakeServer()
  servers.push(server)
  server.script(...replies)
  return server
}
const openaiBody = (content: string) => JSON.stringify({ choices: [{ message: { content } }] })
const GOOD = JSON.stringify(VALID_SUMMARY)

describe('msum provider ls (RF-41, RF-81)', () => {
  it('lists every provider with what it costs, where the data goes, its policy and whether it is usable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: 'anthropic', anthropic: { model: 'claude-sonnet-5-5' } } },
      env: { ANTHROPIC_API_KEY: KEY },
    })
    expect(await run(h, 'provider', 'ls')).toBe(0)
    const out = text(h)
    for (const kind of [
      'claude-cli',
      'gemini-cli',
      'codex-cli',
      'generic-cli',
      'ollama',
      'openai',
      'openai-compatible',
      'anthropic',
      'gemini',
    ]) {
      expect(out).toContain(`\n${kind}: `)
    }
    expect(out).toContain('Connects to: api.openai.com')
    expect(out).toContain('Connects to: generativelanguage.googleapis.com')
    expect(out).toContain('Data policy: https://developers.openai.com/api/docs/guides/your-data')
    expect(out).toContain('Charge: it charges per use (API)')
    expect(out).toContain('Charge: it uses the plan you already have')
    expect(out).toContain('Data: your chats stay on your machine')
    expect(out).toContain('Data: the text of your chats leaves your machine')
    // anthropic is the primary, with its key found and the model set
    const anthropic = out.slice(out.indexOf('\nanthropic: '), out.indexOf('\ngemini: '))
    expect(anthropic).toContain('Here: primary. Key: "anthropic" from environment (ANTHROPIC_API_KEY). Usable now: yes')
    // never the value of a key, and no network
    expect(everything(h)).not.toContain(KEY)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('says why a provider is not usable: no key, no model, disabled, not verifiable', async () => {
    const h = await makeHarness({
      config: {
        language: 'en',
        provider: { primary: 'openai', openai: { model: 'gpt-x' }, ollama: { model: 'qwen3:4b' } },
      },
      probes: { verifyCli: async () => ({ ok: false, kind: 'missingFlags', flags: ['--safe-mode'] }) },
    })
    await run(h, 'provider', 'ls')
    const out = text(h)
    expect(out).toContain('Usable now: no: there is no "openai" key (msum secret set openai)')
    expect(out).toContain('Usable now: no: there is no model (provider.<name>.model)')
    expect(out).toContain('Usable now: no: disabled')
    expect(out).toContain('this version of claude-cli cannot be run without tools')
    expect(out).toContain('Usable now: no: there is no command (provider.genericCli.command)')
    expect(out).toContain('Usable now: not checked here')
  })

  it('knows an OpenAI-compatible server by its base URL, and that it may need no key', async () => {
    const h = await makeHarness({
      config: {
        language: 'en',
        provider: { primary: 'openai', openai: { model: 'local', baseUrl: 'http://localhost:1234/v1' } },
      },
    })
    await run(h, 'provider', 'ls')
    const out = text(h)
    const compatible = out.slice(out.indexOf('\nopenai-compatible: '), out.indexOf('\nanthropic: '))
    expect(compatible).toContain('Connects to: the server in provider.openai.baseUrl (localhost:1234)')
    expect(compatible).toContain('Here: primary.')
    expect(compatible).toContain('no "openai-compatible" key (this server may not need one)')
    expect(compatible).toContain('Usable now: yes')
    expect(out.slice(out.indexOf('\nopenai: '), out.indexOf('\nopenai-compatible: '))).toContain('Here: not configured')
  })

  it('speaks Spanish', async () => {
    const h = await makeHarness({ config: { language: 'es' } })
    await run(h, 'provider', 'ls')
    expect(text(h)).toContain('Costo: cobra por uso (API)')
    expect(text(h)).toContain('Datos: tus chats se quedan en tu máquina')
  })
})

describe('msum provider use (RF-41, RNF-02)', () => {
  const base = { language: 'en', ownerName: 'Alex Test', provider: { primary: 'claude-cli' } }

  it('always writes the config.json of the ACCOUNT, creating it, even with a single account: never the installation file', async () => {
    const h = await makeHarness({ config: base })
    const root = readFileSync(h.layout.configFile, 'utf8')
    expect(existsSync(h.account.configFile)).toBe(false)
    expect(await run(h, 'provider', 'use', 'anthropic', '--model', 'claude-sonnet-5-5', '--yes')).toBe(0)
    expect(readJson(h.account.configFile)).toEqual({
      provider: { primary: 'anthropic', anthropic: { model: 'claude-sonnet-5-5' } },
    })
    // the installation's file is as it was: an account linked later does not inherit the provider
    expect(readFileSync(h.layout.configFile, 'utf8')).toBe(root)
    expect(text(h)).toContain(`Written in ${h.account.configFile}`)
    expect(text(h)).toContain('anthropic is now the primary provider')
    // 2-space JSON, private, atomic (no temporary file left behind)
    expect(readFileSync(h.account.configFile, 'utf8')).toBe(
      `${JSON.stringify(readJson(h.account.configFile), null, 2)}\n`,
    )
    if (process.platform !== 'win32') expect(statSync(h.account.configFile).mode & 0o777).toBe(0o600)
    expect(readdirSync(dirname(h.account.configFile)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('an account linked later does not run the provider that another account chose', async () => {
    const h = await makeHarness({ config: base, accounts: ['default', 'later'] })
    await run(h, 'provider', 'use', 'gemini', '--model', 'gemini-x', '--yes')
    h.out.length = 0
    await run(h, 'provider', 'ls', '--account', 'later')
    const out = text(h)
    expect(out.slice(out.indexOf('\ngemini: '))).toContain('Here: not configured')
    expect(out.slice(out.indexOf('\nclaude-cli: '), out.indexOf('\ngemini-cli: '))).toContain('Here: primary')
  })

  it('does not write when the file changed while the user was being asked, and says so', async () => {
    const h = await makeHarness({ config: base })
    writeFileSync(h.account.configFile, JSON.stringify({ ownerName: 'Before' }))
    // the confirmation is where the user takes time: the file is edited meanwhile
    Object.assign(h.ctx, {
      confirm: async () => {
        writeFileSync(h.account.configFile, JSON.stringify({ ownerName: 'Edited meanwhile, and longer' }))
        return true
      },
    })
    expect(await run(h, 'provider', 'use', 'anthropic', '--model', 'm')).toBe(1)
    expect(errors(h)).toContain('changed while it was being edited, so nothing was written: run it again.')
    expect(readJson(h.account.configFile)).toEqual({ ownerName: 'Edited meanwhile, and longer' })
    expect(readdirSync(dirname(h.account.configFile)).filter((name) => name.includes('.tmp'))).toEqual([])
    expect(text(h)).not.toContain('is now the primary')
    // and nothing was recorded as accepted
    const { openInstallation } = await import('../../../src/main/accounts.js')
    const opened = await openInstallation({ layout: h.layout, clock: h.ctx.clock })
    if (!opened.ok) throw new Error('could not open')
    expect(opened.installation.setup.consents('default')).toEqual([])
    opened.installation.close()
  })

  it('does not write when the file appeared while the user was being asked', async () => {
    const h = await makeHarness({ config: base })
    expect(existsSync(h.account.configFile)).toBe(false)
    Object.assign(h.ctx, {
      confirm: async () => {
        writeFileSync(h.account.configFile, '{}')
        return true
      },
    })
    expect(await run(h, 'provider', 'use', 'anthropic', '--model', 'm')).toBe(1)
    expect(errors(h)).toContain('changed while it was being edited')
    expect(readFileSync(h.account.configFile, 'utf8')).toBe('{}')
  })

  it('writes the file of the account when it has one', async () => {
    const h = await makeHarness({ config: base })
    writeFileSync(h.account.configFile, JSON.stringify({ ownerName: 'Only Here' }))
    const root = readFileSync(h.layout.configFile, 'utf8')
    expect(await run(h, 'provider', 'use', 'ollama', '--model', 'qwen3:4b', '--yes')).toBe(0)
    expect(readJson(h.account.configFile)).toEqual({
      ownerName: 'Only Here',
      provider: { primary: 'ollama', ollama: { model: 'qwen3:4b' } },
    })
    expect(readFileSync(h.layout.configFile, 'utf8')).toBe(root)
    expect(text(h)).toContain(`Written in ${h.account.configFile}`)
  })

  it('with several accounts it creates the file of the account chosen, and leaves the installation alone', async () => {
    const h = await makeHarness({ config: base, accounts: ['default', 'work'] })
    const root = readFileSync(h.layout.configFile, 'utf8')
    expect(await run(h, 'provider', 'use', 'gemini', '--model', 'gemini-x', '--account', 'work', '--yes')).toBe(0)
    expect(readJson(h.accountOf('work').configFile)).toEqual({
      provider: { primary: 'gemini', gemini: { model: 'gemini-x' } },
    })
    expect(readFileSync(h.layout.configFile, 'utf8')).toBe(root)
    expect(existsSync(h.accountOf('default').configFile)).toBe(false)
  })

  it('sets the backup', async () => {
    const h = await makeHarness({ config: base })
    expect(await run(h, 'provider', 'use', 'gemini', '--backup', '--model', 'gemini-x', '--yes')).toBe(0)
    // the account's file holds what the account changed; the primary still comes from the installation's
    expect(readJson(h.account.configFile).provider).toEqual({ backup: 'gemini', gemini: { model: 'gemini-x' } })
    expect(text(h)).toContain('now the backup provider')
  })

  it('refuses a result that would not be valid, and writes nothing', async () => {
    const h = await makeHarness({ config: base })
    const before = readFileSync(h.layout.configFile, 'utf8')
    // no model: there is no default one
    expect(await run(h, 'provider', 'use', 'anthropic', '--yes')).toBe(2)
    expect(errors(h)).toContain('provider.anthropic.model')
    expect(errors(h)).toContain('--model')
    expect(errors(h)).toContain('Nothing was written')
    // a backup with no primary
    const none = await makeHarness({ config: { language: 'en' } })
    const beforeNone = readFileSync(none.layout.configFile, 'utf8')
    expect(await run(none, 'provider', 'use', 'ollama', '--backup', '--model', 'm', '--yes')).toBe(2)
    expect(errors(none)).toContain('provider.primary')
    expect(readFileSync(none.layout.configFile, 'utf8')).toBe(beforeNone)
    expect(readFileSync(h.layout.configFile, 'utf8')).toBe(before)
    expect(existsSync(h.account.configFile)).toBe(false)
    expect(existsSync(none.account.configFile)).toBe(false)
    expect(h.questions).toEqual([])
  })

  it('does not touch a file that is not JSON', async () => {
    const h = await makeHarness({ config: base })
    writeFileSync(h.account.configFile, 'not json {')
    // the configuration cannot even be loaded: it is reported, and the file is left as it is
    expect(await run(h, 'provider', 'use', 'ollama', '--model', 'm', '--yes')).toBe(2)
    expect(readFileSync(h.account.configFile, 'utf8')).toBe('not json {')
    expect(errors(h)).toContain('The file is not valid JSON')
  })

  describe('RNF-02: what leaves the machine, before a provider that sends it is activated', () => {
    it('says what is sent, to which hosts and where the policy is, then asks, and writes only when told yes', async () => {
      const h = await makeHarness({ config: base, confirm: true })
      expect(await run(h, 'provider', 'use', 'gemini', '--model', 'gemini-x')).toBe(0)
      const out = text(h)
      expect(out).toContain('Before activating gemini, this is what it receives:')
      expect(out).toContain('the names of the chats and of the contacts')
      expect(out).toContain('your name as the owner')
      expect(out).toContain('localOnlyPatterns')
      expect(out).toContain('It goes to: generativelanguage.googleapis.com')
      expect(out).toContain('https://aistudio.google.com/docs/logs-policy')
      expect(h.questions).toEqual(['Activate gemini? [y/N] '])
      expect(readJson(h.account.configFile).provider).toMatchObject({ primary: 'gemini' })
      // everything that goes out is listed, voice notes and numbers of unsaved contacts included
      expect(out).toContain('the phone numbers of the contacts you have not saved')
      expect(out).toContain('the transcripts of voice notes')
      // and the disclosure came BEFORE the question
      expect(out.indexOf('Before activating')).toBeLessThan(out.length)
    })

    it('writes nothing when the answer is no', async () => {
      const h = await makeHarness({ config: base, confirm: false })
      const before = readFileSync(h.layout.configFile, 'utf8')
      expect(await run(h, 'provider', 'use', 'openai', '--model', 'gpt-x')).toBe(1)
      expect(errors(h)).toContain('Cancelled. Nothing was written.')
      expect(readFileSync(h.layout.configFile, 'utf8')).toBe(before)
    })

    it('with --yes it still shows everything but does not ask', async () => {
      const h = await makeHarness({ config: base, confirm: false })
      expect(await run(h, 'provider', 'use', 'openai', '--model', 'gpt-x', '--yes')).toBe(0)
      expect(text(h)).toContain('It goes to: api.openai.com')
      expect(text(h)).toContain('https://developers.openai.com/api/docs/guides/your-data')
      expect(h.questions).toEqual([])
    })

    it('for Claude Code it names its hosts and the policy page', async () => {
      const h = await makeHarness({
        config: { language: 'en', provider: { primary: 'ollama', ollama: { model: 'm' } } },
      })
      await run(h, 'provider', 'use', 'claude-cli', '--yes')
      expect(text(h)).toContain('api.anthropic.com, claude.ai, claude.com')
      expect(text(h)).toContain('https://code.claude.com/docs/en/data-usage')
    })

    it('for a server of your own it names the host you gave', async () => {
      const h = await makeHarness({ config: base })
      expect(
        await run(
          h,
          'provider',
          'use',
          'openai-compatible',
          '--base-url',
          'https://openrouter.example/v1',
          '--model',
          'm',
          '--yes',
        ),
      ).toBe(0)
      expect(text(h)).toContain('the server in provider.openai.baseUrl (openrouter.example)')
      expect(text(h)).toContain('there is no vendor policy to link')
      expect(readJson(h.account.configFile).provider).toMatchObject({
        primary: 'openai',
        openai: { model: 'm', baseUrl: 'https://openrouter.example/v1' },
      })
    })

    it('says it in Spanish and takes "s" as yes', async () => {
      const h = await makeHarness({ config: { ...base, language: 'es' }, confirm: true })
      await run(h, 'provider', 'use', 'anthropic', '--model', 'claude-haiku-5-5')
      expect(text(h)).toContain('Antes de activar anthropic, esto es lo que recibe:')
      expect(h.questions).toEqual(['¿Activar anthropic? [s/N] '])
    })

    it('asks nothing for Ollama: the chats stay on the machine', async () => {
      const h = await makeHarness({ config: base })
      expect(await run(h, 'provider', 'use', 'ollama', '--model', 'qwen3:4b')).toBe(0)
      expect(text(h)).not.toContain('Before activating')
      expect(h.questions).toEqual([])
    })
  })

  describe('Ollama outside this machine', () => {
    const remote = {
      language: 'en',
      provider: { primary: 'claude-cli', ollama: { model: 'm', baseUrl: 'http://192.168.1.50:11434' } },
    }

    it('on a loopback address or the Docker host it asks nothing: the chats stay on this machine', async () => {
      for (const baseUrl of [
        'http://127.0.0.1:11434',
        'http://localhost:11434',
        'http://127.1.2.3:11434',
        'http://[::1]:11434',
        'http://host.docker.internal:11434',
      ]) {
        const h = await makeHarness({
          config: { language: 'en', provider: { primary: 'claude-cli', ollama: { model: 'm', baseUrl } } },
        })
        expect(await run(h, 'provider', 'use', 'ollama')).toBe(0)
        expect(text(h), baseUrl).not.toContain('Before activating')
        expect(h.questions).toEqual([])
      }
    })

    it('anywhere else the data leaves the machine: it shows the disclosure naming the origin and asks', async () => {
      const h = await makeHarness({ config: remote, confirm: true })
      expect(await run(h, 'provider', 'use', 'ollama')).toBe(0)
      expect(text(h)).toContain('Before activating ollama, this is what it receives:')
      expect(text(h)).toContain('It goes to: http://192.168.1.50:11434')
      expect(h.questions).toEqual(['Activate ollama? [y/N] '])
      const { openInstallation } = await import('../../../src/main/accounts.js')
      const opened = await openInstallation({ layout: h.layout, clock: h.ctx.clock })
      if (!opened.ok) throw new Error('could not open')
      expect(opened.installation.setup.consents('default').map((c) => [c.provider, c.hosts])).toEqual([
        ['ollama', 'http://192.168.1.50:11434'],
      ])
      opened.installation.close()
    })

    it('and writes nothing when the answer is no', async () => {
      const h = await makeHarness({ config: remote, confirm: false })
      expect(await run(h, 'provider', 'use', 'ollama')).toBe(1)
      expect(existsSync(h.account.configFile)).toBe(false)
    })

    it('provider ls says the chats go to that server, and what "local only" means', async () => {
      const h = await makeHarness({ config: remote })
      await run(h, 'provider', 'ls')
      const ollama = text(h).slice(text(h).indexOf('\nollama: '), text(h).indexOf('\nopenai: '))
      expect(ollama).toContain('Data: the text of your chats leaves your machine')
      expect(ollama).toContain('Your Ollama is at http://192.168.1.50:11434, which is NOT this machine')
      expect(ollama).toContain('"Local only" means "your Ollama server"')
    })
  })

  it('refuses the disabled presets, with the reason, and writes nothing', async () => {
    for (const kind of ['gemini-cli', 'codex-cli']) {
      const h = await makeHarness({ config: base })
      const before = readFileSync(h.layout.configFile, 'utf8')
      expect(await run(h, 'provider', 'use', kind, '--yes')).toBe(1)
      expect(errors(h)).toContain(`${kind} is disabled`)
      expect(readFileSync(h.layout.configFile, 'utf8')).toBe(before)
    }
  })

  it('explains acknowledgeRisk for the generic CLI and never sets it', async () => {
    const h = await makeHarness({
      config: {
        language: 'en',
        provider: { primary: 'ollama', ollama: { model: 'm' }, genericCli: { command: ['my-llm'] } },
      },
    })
    expect(await run(h, 'provider', 'use', 'generic-cli', '--yes')).toBe(0)
    expect(text(h)).toContain('acknowledgeRisk')
    expect(text(h)).toContain('this command never sets it')
    expect(text(h)).toContain('NOT acknowledged yet')
    // the disclosure shows the command that receives the chats, with the placeholder as written
    expect(text(h)).toContain('["my-llm"]')
    const provider = readJson(h.account.configFile).provider as Record<string, unknown>
    expect(provider.primary).toBe('generic-cli')
    expect(JSON.stringify(provider)).not.toContain('acknowledgeRisk')
    expect(JSON.stringify(readJson(h.layout.configFile))).not.toContain('acknowledgeRisk')
    // no command in the configuration: it cannot be activated
    const none = await makeHarness({ config: base })
    expect(await run(none, 'provider', 'use', 'generic-cli', '--yes')).toBe(2)
    expect(errors(none)).toContain('provider.genericCli.command')
  })

  it('checks the arguments that only make sense together', async () => {
    const h = await makeHarness({ config: base })
    expect(await run(h, 'provider', 'use', 'openai-compatible', '--model', 'm', '--yes')).toBe(2)
    expect(errors(h)).toContain('--base-url')
    expect(
      await run(
        h,
        'provider',
        'use',
        'openai-compatible',
        '--base-url',
        'https://api.openai.com/v1',
        '--model',
        'm',
        '--yes',
      ),
    ).toBe(2)
    expect(errors(h)).toContain('That is OpenAI itself')
    expect(await run(h, 'provider', 'use', 'openai', '--base-url', 'http://x', '--model', 'm', '--yes')).toBe(2)
    expect(await run(h, 'provider', 'use', 'generic-cli', '--model', 'm', '--yes')).toBe(2)
    expect(await run(h, 'provider', 'use', 'nonsense')).toBe(2)
    expect(errors(h)).toContain('"nonsense" is not a provider')
  })

  it('back to OpenAI itself drops the base URL of a server that was in use', async () => {
    const h = await makeHarness({
      config: {
        language: 'en',
        provider: { primary: 'openai', openai: { model: 'local', baseUrl: 'http://localhost:1234/v1' } },
      },
    })
    expect(await run(h, 'provider', 'use', 'openai', '--model', 'gpt-x', '--yes')).toBe(0)
    expect(readJson(h.account.configFile).provider).toEqual({
      primary: 'openai',
      openai: { model: 'gpt-x', baseUrl: 'https://api.openai.com/v1' },
    })
  })

  it('never touches the keys: it only reminds of "msum secret set" when one is missing', async () => {
    const missing = await makeHarness({ config: base })
    await run(missing, 'provider', 'use', 'anthropic', '--model', 'm', '--yes')
    expect(text(missing)).toContain('msum secret set anthropic')
    expect(existsSync(missing.layout.secretsFile)).toBe(false)
    const present = await makeHarness({ config: base, env: { ANTHROPIC_API_KEY: KEY } })
    await run(present, 'provider', 'use', 'anthropic', '--model', 'm', '--yes')
    expect(text(present)).not.toContain('msum secret set')
    expect(everything(present)).not.toContain(KEY)
    expect(text(present)).toContain('msum provider test')
  })
})

describe('msum provider test (RF-41: "test the connection")', () => {
  /** An account whose database holds a message nobody may ever send. */
  async function withSecretMessage(h: Harness) {
    const runtime = h.runtime()
    await seedMessages(runtime, [{ id: 'm1', text: SENTINEL }])
    runtime.close()
  }

  it('makes one real call with the made-up conversation, never the messages of the account, and reports the latency', async () => {
    const server = await serve({ body: openaiBody(GOOD) })
    const h = await makeHarness({
      config: {
        language: 'en',
        ownerName: 'Dueño Real Privado',
        provider: { primary: 'openai', openai: { model: 'gpt-x', baseUrl: `${server.baseUrl}/v1` } },
      },
    })
    await withSecretMessage(h)
    expect(await run(h, 'provider', 'test')).toBe(0)
    expect(server.seen).toHaveLength(1)
    const sent = server.seen[0]?.raw ?? ''
    expect(sent).toContain(TEST_CONTACT)
    expect(sent).toContain(TEST_OWNER)
    expect(sent).not.toContain(SENTINEL)
    expect(sent).not.toContain('Dueño Real Privado')
    expect(sent).not.toContain('Ana Test')
    expect(text(h)).toMatch(
      /OK: openai-compatible answered in \d+ ms with a valid summary \(needs a reply: yes; priority: medium\)/,
    )
    // the notice came first and says only the made-up conversation goes out
    expect(text(h)).toContain('with a made-up conversation (invented names). Nothing of yours is sent.')
    expect(text(h).indexOf('Nothing of yours is sent')).toBeLessThan(text(h).indexOf('OK:'))
  })

  it('tests Anthropic and Gemini against their fake servers, with the key in the header and not in the output', async () => {
    const anthropic = await serve({
      body: JSON.stringify({ content: [{ type: 'text', text: GOOD }], stop_reason: 'end_turn' }),
    })
    const gemini = await serve({ body: JSON.stringify({ candidates: [{ content: { parts: [{ text: GOOD }] } }] }) })
    const h = await makeHarness({
      config: {
        language: 'en',
        provider: {
          primary: 'anthropic',
          backup: 'gemini',
          anthropic: { model: 'claude-sonnet-5-5' },
          gemini: { model: 'gemini-x' },
        },
      },
      env: { ANTHROPIC_API_KEY: KEY, GEMINI_API_KEY: `${KEY}-g` },
    })
    Object.assign(h.ctx, { providerBaseUrls: { anthropic: anthropic.baseUrl, gemini: gemini.baseUrl } })
    await withSecretMessage(h)
    expect(await run(h, 'provider', 'test')).toBe(0)
    expect(await run(h, 'provider', 'test', '--backup')).toBe(0)
    expect(anthropic.seen[0]?.headers['x-api-key']).toBe(KEY)
    expect(gemini.seen[0]?.headers['x-goog-api-key']).toBe(`${KEY}-g`)
    for (const request of [anthropic.seen[0], gemini.seen[0]]) {
      expect(request?.raw).toContain(TEST_CONTACT)
      expect(request?.raw).not.toContain(SENTINEL)
    }
    expect(everything(h)).not.toContain(KEY)
  })

  it.skipIf(isWindows)('tests a CLI: Claude Code through a fake binary, verified first', async () => {
    const cli = installFakeCli({
      help: CLAUDE_HELP,
      steps: [{ kind: 'text', text: JSON.stringify({ is_error: false, structured_output: VALID_SUMMARY }) }],
    })
    clis.push(cli)
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: 'claude-cli', claudeCli: { command: cli.path } } },
      env: { PATH: process.env.PATH },
    })
    await withSecretMessage(h)
    expect(await run(h, 'provider', 'test')).toBe(0)
    const call = cli.calls('run')[0]
    expect(call?.stdin).toContain(TEST_CONTACT)
    expect(call?.stdin).not.toContain(SENTINEL)
    expect(text(h)).toContain('OK: claude-cli answered')
  })

  it('says it when there is nothing to test, or the model is missing', async () => {
    const h = await makeHarness({ config: { language: 'en' } })
    expect(await run(h, 'provider', 'test')).toBe(1)
    expect(errors(h)).toContain('There is no primary provider configured')
    expect(await run(h, 'provider', 'test', '--backup')).toBe(1)
    expect(errors(h)).toContain('There is no backup provider configured')
    expect(await run(h, 'provider', 'test', '--kind', 'openai')).toBe(1)
    expect(errors(h)).toContain('There is no model for openai')
  })

  describe('each failure comes with what to do about it', () => {
    const hintsOf = async (
      reply: Parameters<FakeServer['script']>[0],
      options: { openai?: Record<string, unknown>; retry?: Record<string, unknown> } = {},
    ) => {
      const server = await serve(reply)
      const h = await makeHarness({
        config: {
          language: 'en',
          provider: {
            primary: 'openai',
            openai: { model: 'gpt-x', baseUrl: `${server.baseUrl}/v1`, ...options.openai },
            retry: { maxRetries: 0, ...options.retry },
          },
        },
        env: { MSUM_OPENAI_API_KEY: KEY },
      })
      const code = await run(h, 'provider', 'test')
      return { h, code, server }
    }

    it('401: the key was refused', async () => {
      const { h, code } = await hintsOf({ status: 401, body: JSON.stringify({ error: { message: `bad key ${KEY}` } }) })
      expect(code).toBe(1)
      expect(errors(h)).toContain('FAILED: openai-compatible: openai answered 401')
      expect(errors(h)).toContain('refused the key')
      // the server echoed the key: it is not printed
      expect(everything(h)).not.toContain(KEY)
    })

    it('404: the model is unknown', async () => {
      const { h, code } = await hintsOf({
        status: 404,
        body: JSON.stringify({ error: { message: 'The model `gpt-x` does not exist' } }),
      })
      expect(code).toBe(1)
      expect(errors(h)).toContain('does not know that model')
    })

    it('429: a rate limit that did not clear', async () => {
      const { h, code } = await hintsOf({ status: 429, body: '{}' })
      expect(code).toBe(1)
      expect(errors(h)).toContain('too many requests')
    })

    it('no answer: a timeout', async () => {
      const { h, code } = await hintsOf({ hang: true }, { openai: { timeoutMs: 150 } })
      expect(code).toBe(1)
      expect(errors(h)).toContain('did not answer in time')
    })

    it('an answer that is not a summary', async () => {
      const { h, code } = await hintsOf({ body: openaiBody('this is not JSON') })
      expect(code).toBe(1)
      expect(errors(h)).toContain('FAILED')
      expect(errors(h)).toContain('See the message above')
    })

    it('a redirect is not followed', async () => {
      const { h, code, server } = await hintsOf({
        status: 307,
        headers: { location: 'http://127.0.0.1:1/x' },
        body: '',
      })
      expect(code).toBe(1)
      expect(errors(h)).toContain('redirect')
      expect(server.seen).toHaveLength(1)
    })

    it('no key', async () => {
      const h = await makeHarness({
        config: { language: 'en', provider: { primary: 'anthropic', anthropic: { model: 'm' } } },
      })
      expect(await run(h, 'provider', 'test')).toBe(1)
      expect(errors(h)).toContain('There is no API key. Save it with "msum secret set anthropic"')
    })

    it('a disabled preset: nothing is run and nothing is announced as sent', async () => {
      const h = await makeHarness({ config: { language: 'en', provider: { primary: 'gemini-cli' } } })
      expect(await run(h, 'provider', 'test')).toBe(1)
      expect(errors(h)).toContain('gemini-cli is disabled')
      expect(errors(h)).toContain('This provider is disabled')
      expect(text(h)).not.toContain('One call will be made')
    })

    it.skipIf(isWindows)('a CLI that cannot be verified', async () => {
      const cli = installFakeCli({ help: 'Usage: claude -p' })
      clis.push(cli)
      const h = await makeHarness({
        config: { language: 'en', provider: { primary: 'claude-cli', claudeCli: { command: cli.path } } },
        env: { PATH: process.env.PATH },
      })
      expect(await run(h, 'provider', 'test')).toBe(1)
      expect(errors(h)).toContain('cannot be run without tools')
      expect(errors(h)).toContain('could not be verified to run without tools')
      expect(cli.calls('run')).toEqual([])
    })

    it('Ollama that is not running, with the local notice', async () => {
      const h = await makeHarness({
        config: {
          language: 'en',
          provider: { primary: 'ollama', ollama: { model: 'm', baseUrl: 'http://127.0.0.1:1' } },
        },
      })
      expect(await run(h, 'provider', 'test')).toBe(1)
      expect(text(h)).toContain('(your machine)')
      expect(errors(h)).toContain('could not be reached')
    })

    it('Gemini refusing the shape of the request says so, asking to report it', async () => {
      const gemini = await serve({
        status: 400,
        body: JSON.stringify({
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message:
              'Invalid JSON payload received. Unknown name "responseJsonSchema" at generation_config: Cannot find field.',
          },
        }),
      })
      const h = await makeHarness({
        config: { language: 'en', provider: { primary: 'gemini', gemini: { model: 'g' }, retry: { maxRetries: 0 } } },
        env: { GEMINI_API_KEY: KEY },
      })
      Object.assign(h.ctx, { providerBaseUrls: { gemini: gemini.baseUrl } })
      expect(await run(h, 'provider', 'test')).toBe(1)
      expect(errors(h)).toContain('Gemini refused the shape of the request')
    })

    it('says it in Spanish', async () => {
      const server = await serve({ status: 401, body: '{}' })
      const h = await makeHarness({
        config: {
          language: 'es',
          provider: {
            primary: 'openai',
            openai: { model: 'm', baseUrl: `${server.baseUrl}/v1` },
            retry: { maxRetries: 0 },
          },
        },
        env: { MSUM_OPENAI_API_KEY: KEY },
      })
      await run(h, 'provider', 'test')
      expect(errors(h)).toContain('FALLÓ')
      expect(errors(h)).toContain('rechazó la clave')
    })
  })
})

describe('classifyFailure', () => {
  it.each([
    ['openai', 'no API key for openai: set it with "msum secret set openai"', 'missingKey'],
    ['gemini-cli', 'gemini-cli is disabled: its documentation offers no way', 'disabled'],
    [
      'claude-cli',
      'this version of claude cannot be run without tools (RF-49): its --help does not list --tools',
      'verifyFailed',
    ],
    ['claude-cli', 'claude was not found', 'verifyFailed'],
    ['openai', 'openai answered with a redirect, which is not followed', 'redirect'],
    ['anthropic', 'anthropic answered 401: invalid x-api-key', 'authFailed'],
    ['gemini', 'gemini answered 403: forbidden', 'authFailed'],
    ['gemini', 'gemini answered 400: API key not valid. Please pass a valid API key.', 'authFailed'],
    ['gemini', 'gemini answered 400: Unknown name "responseJsonSchema": Cannot find field', 'geminiSchemaShape'],
    ['openai', 'openai answered 400: Unknown name "response_format"', 'generic'],
    ['openai', 'openai answered 404: The model `x` does not exist', 'unknownModel'],
    ['ollama', 'ollama answered 404: model "x" not found', 'unknownModel'],
    ['openai', 'openai answered 429: slow (gave up after 3 retries)', 'rateLimit'],
    ['openai', 'openai answered 429: You have no credits remaining. Add credits to continue', 'noCredit'],
    ['openai', 'openai answered 429: {"error":{"code":"insufficient_quota"}}', 'noCredit'],
    ['anthropic', 'anthropic answered 529: overloaded', 'rateLimit'],
    ['openai', 'openai timed out after 3s', 'timeout'],
    ['openai', 'openai: the total time limit of the call was reached', 'timeout'],
    ['ollama', 'could not reach ollama: fetch failed', 'unreachable'],
    ['openai', 'something else entirely', 'generic'],
  ] as const)('%s: "%s" is %s', (kind, reason, hint) => {
    expect(classifyFailure(kind, reason)).toBe(hint)
  })
})

describe('the arguments of msum provider', () => {
  it('parses ls, use and test', () => {
    expect(parseCommandLine(['provider'])).toEqual({
      ok: true,
      value: { name: 'provider', action: 'ls', account: null },
    })
    expect(
      parseCommandLine(['provider', 'use', 'openai', '--model', 'm', '--backup', '--yes', '--account', 'work']),
    ).toEqual({
      ok: true,
      value: {
        name: 'provider',
        action: 'use',
        kind: 'openai',
        model: 'm',
        backup: true,
        yes: true,
        baseUrl: null,
        account: 'work',
      },
    })
    expect(parseCommandLine(['provider', 'test', '--kind', 'gemini'])).toEqual({
      ok: true,
      value: { name: 'provider', action: 'test', backup: false, kind: 'gemini', account: null },
    })
  })

  it('rejects what does not belong', () => {
    expect(parseCommandLine(['provider', 'use']).ok).toBe(false)
    expect(parseCommandLine(['provider', 'use', 'x']).ok).toBe(false)
    expect(parseCommandLine(['provider', 'ls', '--model', 'm']).ok).toBe(false)
    expect(parseCommandLine(['provider', 'test', '--model', 'm']).ok).toBe(false)
    expect(parseCommandLine(['provider', 'test', '--kind', 'openai', '--backup']).ok).toBe(false)
    expect(parseCommandLine(['provider', 'test', '--kind', 'nope']).ok).toBe(false)
    expect(parseCommandLine(['provider', 'use', 'openai', '--model', ' ']).ok).toBe(false)
    expect(parseCommandLine(['provider', 'rm']).ok).toBe(false)
  })
})

// keep the fixtures of the contract in use, so a change of its summary is noticed here too
void REQUEST
