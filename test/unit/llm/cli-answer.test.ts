import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { AnswerRequest } from '../../../src/application/ports/answerer.js'
import { redactSent } from '../../../src/infrastructure/llm/cli/cli-summarizer.js'
import { runProcess } from '../../../src/infrastructure/llm/cli/run-process.js'
import {
  ClaudeCliSummarizer,
  type CliAdapter,
  CliSummarizer,
  type CliVerification,
  describeUnverified,
  GenericCliSummarizer,
  MAX_ARGUMENT_BYTES,
  PROMPT_PLACEHOLDER,
} from '../../../src/infrastructure/llm/index.js'
import { REQUEST as SUMMARY_REQUEST } from '../../contract/summarizer.contract.js'
import { envNamesOf, type FakeCli, type FakeStep, installFakeCli } from '../../support/fake-cli.js'
import { allowSubprocess } from '../../support/network-guard.js'
import { isWindows } from '../../support/platform.js'

// RF-49 for the free-text answer (the "Ask" tab): verified before it runs, contained like a summary, never retried.
// The CLIs are fake executables; nothing leaves the machine.

const created: FakeCli[] = []
const revokes: (() => void)[] = []
const fake = (steps: FakeStep[]): FakeCli => {
  const cli = installFakeCli({ steps })
  created.push(cli)
  return cli
}
afterEach(() => {
  for (const cli of created.splice(0)) cli.dispose()
  for (const revoke of revokes.splice(0)) revoke()
})

const REQUEST: AnswerRequest = { systemPrompt: 'SYSTEM-PROMPT', input: 'Ana: texto-del-chat-de-prueba' }
const TEXT: FakeStep = { kind: 'text', text: '  the answer  ' }

const adapterFor = (command: string, extra: Partial<CliAdapter> = {}): CliAdapter => ({
  label: 'fakecli',
  command,
  envNames: ['PATH'],
  call: () => ({ args: [], stdin: '' }),
  interpret: () => ({ ok: false, error: 'not used', retryable: false }),
  answer: {
    call: (request) => ({ args: ['--ask'], stdin: request.input }),
    interpret: (output) =>
      output.code === 0 ? { ok: true, text: output.stdout.trim() } : { ok: false, error: `exit ${output.code}` },
  },
  ...extra,
})

const VERIFIED = (path: string): CliVerification => ({ ok: true, path, version: null })

describe.skipIf(isWindows)('CliSummarizer.answer', () => {
  it('RF-49: when verification says no, the CLI is never run, whatever the reason', async () => {
    const kinds: Exclude<CliVerification, { ok: true }>[] = [
      { ok: false, kind: 'notFound' },
      { ok: false, kind: 'unrunnable' },
      { ok: false, kind: 'missingFlags', flags: ['--tools'] },
      { ok: false, kind: 'disabled' },
    ]
    for (const verdict of kinds) {
      const cli = fake([TEXT])
      let asked = 0
      const summarizer = new CliSummarizer({
        adapter: adapterFor(cli.path),
        verify: async () => {
          asked++
          return verdict
        },
      })
      const result = await summarizer.answer(REQUEST)
      expect(result).toEqual({ ok: false, error: describeUnverified('fakecli', verdict) })
      expect(asked).toBe(1)
      expect(cli.calls(), verdict.kind).toEqual([])
    }
  })

  it('RF-49: when verification says yes, it runs the verified path, not the name of the adapter', async () => {
    const cli = fake([TEXT])
    const summarizer = new CliSummarizer({
      adapter: adapterFor('/nonexistent/never-run'),
      verify: async () => VERIFIED(cli.path),
    })
    expect(await summarizer.answer(REQUEST)).toEqual({ ok: true, value: 'the answer' })
    const runs = cli.calls('run')
    expect(runs).toHaveLength(1)
    expect(runs[0]?.argv).toEqual(['--ask'])
    expect(runs[0]?.stdin).toBe(REQUEST.input)
  })

  it('without a verify it runs the command as configured', async () => {
    const cli = fake([TEXT])
    const result = await new CliSummarizer({ adapter: adapterFor(cli.path) }).answer(REQUEST)
    expect(result).toEqual({ ok: true, value: 'the answer' })
    expect(cli.calls('run')).toHaveLength(1)
  })

  it('an unavailable CLI fails every call with its reason, without verifying or running anything', async () => {
    const cli = fake([TEXT])
    let asked = 0
    const summarizer = new CliSummarizer({
      adapter: adapterFor(cli.path),
      unavailable: 'not acknowledged',
      verify: async () => {
        asked++
        return VERIFIED(cli.path)
      },
    })
    expect(await summarizer.answer(REQUEST)).toEqual({ ok: false, error: 'not acknowledged' })
    expect(asked).toBe(0)
    expect(cli.calls()).toEqual([])
  })

  it('an adapter without a free-text answer fails without running anything', async () => {
    const cli = fake([TEXT])
    const { answer: _answer, ...noAnswer } = adapterFor(cli.path)
    const result = await new CliSummarizer({ adapter: noAnswer }).answer(REQUEST)
    expect(result).toEqual({ ok: false, error: 'fakecli cannot give a free-text answer' })
    expect(cli.calls()).toEqual([])
  })

  it('a timeout is an error that names the limit, and the temporary directory is gone', async () => {
    const cli = fake([{ kind: 'hang' }])
    const result = await new CliSummarizer({
      adapter: adapterFor(cli.path),
      answerTimeoutMs: 3_000,
      killGraceMs: 100,
    }).answer(REQUEST)
    expect(result).toEqual({ ok: false, error: 'fakecli timed out after 3s' })
    const cwd = cli.calls('run')[0]?.cwd ?? ''
    expect(cwd).not.toBe('')
    expect(existsSync(cwd)).toBe(false)
  }, 15_000)

  it('output over the cap is an error', async () => {
    const cli = fake([{ kind: 'flood' }])
    const result = await new CliSummarizer({
      adapter: adapterFor(cli.path),
      maxOutputChars: 1_000,
      killGraceMs: 100,
    }).answer(REQUEST)
    expect(result).toEqual({ ok: false, error: 'fakecli output exceeded the size limit' })
  })

  it('a program that cannot be started is an error with the reason', async () => {
    const missing = '/nonexistent-dir-for-test/cli'
    revokes.push(allowSubprocess(missing))
    const result = await new CliSummarizer({ adapter: adapterFor(missing) }).answer(REQUEST)
    expect(result).toEqual({ ok: false, error: `could not run ${missing}: ENOENT` })
  })

  it('runs once in an empty temporary directory of its own, removed afterwards, with only the named variables', async () => {
    const cli = fake([TEXT])
    const summarizer = new CliSummarizer({
      adapter: adapterFor(cli.path, { envNames: ['PATH', 'KEPT_VAR'] }),
      env: { PATH: process.env.PATH, KEPT_VAR: 'yes', SECRET_TOKEN: 'must-not-reach-the-child' },
    })
    await summarizer.answer(REQUEST)
    const [run, ...rest] = cli.calls('run')
    expect(rest).toEqual([])
    expect(run?.cwdEntries).toEqual([])
    expect(run?.cwd.startsWith(realpathSync(tmpdir()))).toBe(true)
    expect(existsSync(run?.cwd ?? '')).toBe(false)
    expect(run?.env.KEPT_VAR).toBe('yes')
    expect(run?.env.SECRET_TOKEN).toBeUndefined()
  })

  it('a failed answer is not retried', async () => {
    const cli = fake([{ kind: 'text', text: '', code: 3 }])
    const result = await new CliSummarizer({ adapter: adapterFor(cli.path) }).answer(REQUEST)
    expect(result).toEqual({ ok: false, error: 'exit 3' })
    expect(cli.calls('run')).toHaveLength(1)
  })
})

describe.skipIf(isWindows)('the answer of the Claude CLI adapter (RF-49)', () => {
  const claude = (cli: FakeCli) =>
    new ClaudeCliSummarizer({ command: cli.path, model: 'm', env: { PATH: process.env.PATH }, killGraceMs: 100 })
  const json = (body: unknown): FakeStep => ({ kind: 'text', text: JSON.stringify(body) })

  it('is run without the JSON schema, with every flag that removes the tools, and the chat on stdin only', async () => {
    const cli = fake([json({ result: 'free text' })])
    expect(await claude(cli).answer(REQUEST)).toEqual({ ok: true, text: 'free text', provider: 'claude-cli' })
    const run = cli.calls('run')[0]
    expect(run?.argv).toEqual([
      '-p',
      '--model',
      'm',
      '--system-prompt',
      'SYSTEM-PROMPT',
      '--output-format',
      'json',
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--safe-mode',
      '--disable-slash-commands',
    ])
    expect(run?.argv.join('\n')).not.toContain('texto-del-chat-de-prueba')
    expect(run?.stdin).toBe(REQUEST.input)
  })

  it('is_error is a failure, and no line of the chat is quoted in the reason', async () => {
    const cli = fake([json({ is_error: true, result: 'cannot read: Ana: texto-del-chat-de-prueba' })])
    const result = await claude(cli).answer(REQUEST)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('claude: ')
      expect(result.error).not.toContain('texto-del-chat-de-prueba')
      expect(result.error).toContain('[chat text]')
    }
  })

  it('is_error falls back to the subtype, then to "error"', async () => {
    const bySubtype = await claude(fake([json({ is_error: true, subtype: 'error_max_turns' })])).answer(REQUEST)
    expect(bySubtype).toEqual({ ok: false, error: 'claude: error_max_turns' })
    const bare = await claude(fake([json({ is_error: true })])).answer(REQUEST)
    expect(bare).toEqual({ ok: false, error: 'claude: error' })
  })

  it('stderr of a failed run is shown without the lines of the chat', async () => {
    const cli = fake([{ kind: 'echo' }])
    const result = await claude(cli).answer(REQUEST)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toContain('texto-del-chat-de-prueba')
      expect(result.error).toContain('[chat text]')
    }
  })

  it('a missing or blank result is an error', async () => {
    expect(await claude(fake([json({ result: '   ' })])).answer(REQUEST)).toEqual({
      ok: false,
      error: 'claude returned no text',
    })
    expect(await claude(fake([json({ result: 5 })])).answer(REQUEST)).toEqual({
      ok: false,
      error: 'claude returned no text',
    })
  })
})

describe.skipIf(isWindows)('the summary of the Claude CLI adapter hides what the chat said (RNF-04)', () => {
  const claude = (cli: FakeCli) =>
    new ClaudeCliSummarizer({ command: cli.path, model: 'm', env: { PATH: process.env.PATH }, killGraceMs: 100 })
  const chat = { ...SUMMARY_REQUEST, systemPrompt: 'S', transcript: 'Chat con: Ana\n\nAna: texto-del-chat-de-prueba' }

  it('is_error: the reason has no line of the chat, is not retried, and falls back to subtype then "error"', async () => {
    const cli = fake([
      { kind: 'text', text: JSON.stringify({ is_error: true, result: 'cannot read: Ana: texto-del-chat-de-prueba' }) },
    ])
    const result = await claude(cli).summarize(chat)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('claude: ')
      expect(result.error).not.toContain('texto-del-chat-de-prueba')
    }
    expect(cli.calls('run')).toHaveLength(1)
    const bySubtype = await claude(
      fake([{ kind: 'text', text: JSON.stringify({ is_error: true, subtype: 'boom' }) }]),
    ).summarize(chat)
    expect(bySubtype).toEqual({ ok: false, error: 'claude: boom' })
    const bare = await claude(fake([{ kind: 'text', text: JSON.stringify({ is_error: true }) }])).summarize(chat)
    expect(bare).toEqual({ ok: false, error: 'claude: error' })
  })

  it('a non-JSON exit shows stderr without the chat, or only the length of stdout', async () => {
    const echo = await claude(fake([{ kind: 'echo' }])).summarize(chat)
    expect(echo.ok).toBe(false)
    if (!echo.ok) expect(echo.error).not.toContain('texto-del-chat-de-prueba')
    const quiet = await claude(fake([{ kind: 'text', text: 'oops', code: 2 }])).summarize(chat)
    expect(quiet).toEqual({ ok: false, error: 'claude exited with code 2: stdout was 4 chars' })
  })
})

describe.skipIf(isWindows)('the answer of the generic CLI adapter (RF-49)', () => {
  const generic = (cli: FakeCli, extra: { acknowledgeRisk?: boolean; viaArgument?: boolean } = {}) =>
    new GenericCliSummarizer({
      command: extra.viaArgument ? [cli.path, '{{prompt}}'] : [cli.path],
      acknowledgeRisk: extra.acknowledgeRisk ?? true,
      timeoutMs: 5_000,
      killGraceMs: 100,
      env: { PATH: process.env.PATH },
    })

  it('without acknowledgeRisk it never runs', async () => {
    const cli = fake([TEXT])
    const result = await generic(cli, { acknowledgeRisk: false }).answer(REQUEST)
    expect(result.ok).toBe(false)
    expect(cli.calls()).toEqual([])
  })

  it('passes the prompt on stdin, or as one argument, and returns the trimmed text', async () => {
    const onStdin = fake([TEXT])
    expect(await generic(onStdin).answer(REQUEST)).toEqual({ ok: true, text: 'the answer', provider: 'generic-cli' })
    expect(onStdin.calls('run')[0]?.stdin).toBe(`${REQUEST.systemPrompt}\n\n---\n${REQUEST.input}`)

    const viaArgument = fake([TEXT])
    await generic(viaArgument, { viaArgument: true }).answer(REQUEST)
    const run = viaArgument.calls('run')[0]
    expect(run?.argv).toEqual([`${REQUEST.systemPrompt}\n\n---\n${REQUEST.input}`])
    expect(run?.stdin).toBe('')
  })

  it('a failed exit hides the lines of the prompt that stderr echoes, an empty answer is an error', async () => {
    const echo = await generic(fake([{ kind: 'text', text: '', code: 1, stderr: `bad ${REQUEST.input}` }])).answer(
      REQUEST,
    )
    expect(echo.ok).toBe(false)
    if (!echo.ok) {
      expect(echo.error).toContain('generic exited with code')
      expect(echo.error).not.toContain('texto-del-chat-de-prueba')
    }
    const viaArgEcho = await generic(fake([{ kind: 'text', text: '', code: 1, stderr: `bad ${REQUEST.input}` }]), {
      viaArgument: true,
    }).answer(REQUEST)
    expect(viaArgEcho.ok).toBe(false)
    if (!viaArgEcho.ok) expect(viaArgEcho.error).not.toContain('texto-del-chat-de-prueba')
    const empty = await generic(fake([{ kind: 'text', text: '  \n' }])).answer(REQUEST)
    expect(empty).toEqual({ ok: false, error: 'generic returned no text' })
    const quiet = await generic(fake([{ kind: 'text', text: 'abc', code: 4 }])).answer(REQUEST)
    expect(quiet).toEqual({ ok: false, error: 'generic exited with code 4: stdout was 3 chars' })
  })

  it('the summary of a failed exit hides what stderr echoes of the prompt', async () => {
    const cli = fake([{ kind: 'text', text: '', code: 1, stderr: 'bad Ana: texto-del-chat-de-prueba' }])
    const result = await generic(cli).summarize({
      ...SUMMARY_REQUEST,
      systemPrompt: 'S',
      transcript: 'Ana: texto-del-chat-de-prueba',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).not.toContain('texto-del-chat-de-prueba')
    // an exit with an error is not retried
    expect(cli.calls('run')).toHaveLength(1)
  })
})

describe.skipIf(isWindows)('the generic CLI, containment details (RF-49)', () => {
  const run = (command: string[], env: NodeJS.ProcessEnv = { PATH: process.env.PATH }) =>
    new GenericCliSummarizer({ command, acknowledgeRisk: true, timeoutMs: 5_000, killGraceMs: 100, env })

  it('the prompt as an argument is accepted up to exactly the byte limit, and refused one byte over, without running', async () => {
    // 'S' + the separator is 7 bytes
    const atLimit = fake([TEXT])
    const summarizer = run([atLimit.path, PROMPT_PLACEHOLDER])
    expect((await summarizer.answer({ systemPrompt: 'S', input: 'y'.repeat(MAX_ARGUMENT_BYTES - 7) })).ok).toBe(true)
    expect(atLimit.calls('run')).toHaveLength(1)
    const over = fake([TEXT])
    const refused = await run([over.path, PROMPT_PLACEHOLDER]).answer({
      systemPrompt: 'S',
      input: 'y'.repeat(MAX_ARGUMENT_BYTES - 6),
    })
    expect(refused.ok).toBe(false)
    expect(over.calls()).toEqual([])
  })

  it('the program is not part of its own arguments, and the other elements reach it as they are', async () => {
    const cli = fake([TEXT])
    await run([cli.path, '--quiet', '--flag=$(touch pwned)']).answer(REQUEST)
    expect(cli.calls('run')[0]?.argv).toEqual(['--quiet', '--flag=$(touch pwned)'])
    // the same for a summary (what it prints does not matter here)
    const forSummary = fake([TEXT])
    await run([forSummary.path, '--quiet']).summarize({
      ...SUMMARY_REQUEST,
      systemPrompt: 'S',
      transcript: 'Ana: hola',
    })
    expect(forSummary.calls('run')[0]?.argv).toEqual(['--quiet'])
  })

  it('only the allowed variables reach it, and none of ours', async () => {
    const cli = fake([TEXT])
    const env = {
      PATH: process.env.PATH,
      HOME: '/home/someone',
      CLAUDE_CONFIG_DIR: '/not-for-generic',
      OPENAI_API_KEY: 'plain-secret-value',
    }
    await run([cli.path], env).answer(REQUEST)
    expect(envNamesOf(cli.calls('run')[0]?.env)).toEqual(['HOME', 'PATH'])
  })
})

describe.skipIf(isWindows)('runProcess', () => {
  const base = {
    args: [] as string[],
    stdin: '',
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
    maxOutputChars: 1_000_000,
  }

  it('keeps only the tail of stderr when it is over the cap', async () => {
    const cli = fake([{ kind: 'text', text: 'ok', stderr: `${'a'.repeat(50)}THE-TAIL` }])
    const outcome = await runProcess({
      ...base,
      command: cli.path,
      timeoutMs: 5_000,
      killGraceMs: 100,
      maxOutputChars: 20,
    })
    expect(outcome.kind).toBe('exited')
    if (outcome.kind === 'exited') {
      expect(outcome.stderr.length).toBeLessThanOrEqual(20)
      expect(outcome.stderr.endsWith('THE-TAIL')).toBe(true)
    }
  })

  it('a child that exits reports stdout, stderr and the exit code, and gets the stdin', async () => {
    const cli = fake([{ kind: 'text', text: 'out', stderr: 'err', code: 7 }])
    const outcome = await runProcess({ ...base, command: cli.path, timeoutMs: 5_000, killGraceMs: 100, stdin: 'in' })
    expect(outcome).toEqual({ kind: 'exited', stdout: 'out', stderr: 'err', code: 7 })
    expect(cli.calls('run')[0]?.stdin).toBe('in')
  })

  it('stdout of exactly the cap is accepted, one more is not', async () => {
    const cli = fake([{ kind: 'text', text: 'x'.repeat(100) }])
    const exact = await runProcess({
      ...base,
      command: cli.path,
      timeoutMs: 5_000,
      killGraceMs: 100,
      maxOutputChars: 100,
    })
    expect(exact.kind).toBe('exited')
    const over = await runProcess({
      ...base,
      command: cli.path,
      timeoutMs: 5_000,
      killGraceMs: 100,
      maxOutputChars: 99,
    })
    expect(over.kind).toBe('too-large')
  })
})

describe('redactSent, what keeps the chat out of an error reason (RNF-04)', () => {
  const sent = 'Chat con: Ana\n  Ana: hola mama  \nok\nabc\nxxxx\n\n'

  it('replaces every occurrence of every meaningful line of what was sent, ignoring the spaces around the lines', () => {
    expect(redactSent('a: Ana: hola mama / again Ana: hola mama / Chat con: Ana', sent)).toBe(
      'a: [chat text] / again [chat text] / [chat text]',
    )
  })

  it('a line of exactly 4 characters is replaced, a shorter one is not', () => {
    expect(redactSent('it said xxxx, then abc and ok', sent)).toBe('it said [chat text], then abc and ok')
  })

  it('leaves a text with nothing of the chat as it is, and does nothing for an empty prompt', () => {
    expect(redactSent('exit code 1', sent)).toBe('exit code 1')
    expect(redactSent('exit code 1', '')).toBe('exit code 1')
  })
})
