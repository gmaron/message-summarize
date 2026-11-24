import { chmodSync, existsSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative as relativePath } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHILD_ENV_NAMES,
  CLAUDE_REQUIRED_FLAGS,
  ClaudeCliSummarizer,
  CliSummarizer,
  clearVerificationCache,
  describeUnverified,
  helpListsFlag,
  readSummaryFromText,
  resolveExecutable,
  UNRUNNABLE_TTL_MS,
  verifyClaudeCli,
  verifyCli,
} from '../../../src/infrastructure/llm/index.js'
import { REQUEST, VALID_SUMMARY } from '../../contract/summarizer.contract.js'
import { CLAUDE_HELP, envNamesOf, type FakeCli, installFakeCli } from '../../support/fake-cli.js'
import { isWindows } from '../../support/platform.js'

// On Windows the tests that run the fake CLI are skipped: it is a script with a shebang, and the adapters spawn without
// a shell (RF-49), so Windows cannot execute it (a .cmd wrapper would need `shell: true`, which the rule forbids).
// The behavior they check is cross-platform code; it is covered on Linux and macOS.

// RF-49: a CLI is only used when we can verify at runtime that it runs without tools. `--help` and `--version` are run
// (never a model call), the flags the hardening passes must all be listed, and the answer is cached per binary.

const created: FakeCli[] = []
const fake = (options: Parameters<typeof installFakeCli>[0] = {}): FakeCli => {
  const cli = installFakeCli(options)
  created.push(cli)
  return cli
}
beforeEach(clearVerificationCache)
afterEach(() => {
  for (const cli of created.splice(0)) cli.dispose()
})

const spec = (cli: FakeCli, env: NodeJS.ProcessEnv = { PATH: process.env.PATH }) => ({
  command: cli.path,
  env,
  envNames: CHILD_ENV_NAMES,
  requiredFlags: CLAUDE_REQUIRED_FLAGS,
})

describe('helpListsFlag', () => {
  it('finds a flag as a whole word', () => {
    expect(helpListsFlag('  --tools <tools...>   the tools', '--tools')).toBe(true)
    expect(helpListsFlag('  -p, --print', '--print')).toBe(true)
  })

  it('does not take a longer flag for a shorter one', () => {
    expect(helpListsFlag('  --tools-extra', '--tools')).toBe(false)
    expect(helpListsFlag('  --no-tools', '--tools')).toBe(false)
    expect(helpListsFlag('  --safe-mode-x', '--safe-mode')).toBe(false)
  })
})

describe('verifyCli', () => {
  it.skipIf(isWindows)('passes when --help lists every flag, and reports the path and the version', async () => {
    const cli = fake({ help: CLAUDE_HELP, version: 'claude 9.9.9 (fake)' })
    expect(await verifyCli(spec(cli))).toEqual({ ok: true, path: cli.path, version: 'claude 9.9.9 (fake)' })
    expect(cli.calls().map((call) => [call.kind, call.argv])).toEqual([
      ['help', ['--help']],
      ['version', ['--version']],
    ])
  })

  it.skipIf(isWindows)('fails and names the flags when one the hardening relies on is missing', async () => {
    const cli = fake({
      help: CLAUDE_HELP.replace('  --safe-mode                          Start with all customizations disabled\n', ''),
    })
    const result = await verifyCli(spec(cli))
    expect(result).toEqual({ ok: false, kind: 'missingFlags', flags: ['--safe-mode'] })
    // no model was called, and --version is not asked for once it failed
    expect(cli.calls('run')).toEqual([])
  })

  it.skipIf(isWindows)('lists every missing flag', async () => {
    const cli = fake({ help: 'Usage: claude -p\n  --model <m>\n' })
    const result = await verifyCli(spec(cli))
    expect(result.ok).toBe(false)
    if (!result.ok && result.kind === 'missingFlags') {
      expect(result.flags).toEqual(CLAUDE_REQUIRED_FLAGS.filter((flag) => flag !== '--model'))
    }
  })

  it('says the version cannot run without tools, in the reason a failed call carries', () => {
    expect(describeUnverified('claude', { ok: false, kind: 'missingFlags', flags: ['--tools', '--safe-mode'] })).toBe(
      'this version of claude cannot be run without tools (RF-49): its --help does not list --tools, --safe-mode',
    )
    expect(describeUnverified('gemini-cli', { ok: false, kind: 'disabled' })).toContain('disabled')
  })

  it.skipIf(isWindows)('caches the answer for the binary: the same one is not run twice', async () => {
    const cli = fake({ help: CLAUDE_HELP })
    await verifyCli(spec(cli))
    await verifyCli(spec(cli))
    await verifyCli(spec(cli))
    expect(cli.calls('help')).toHaveLength(1)
    expect(cli.calls('version')).toHaveLength(1)
  })

  it.skipIf(isWindows)(
    'caches a failure too, and looks again when the binary changes (its modification time)',
    async () => {
      const cli = fake({ help: 'nothing useful' })
      expect((await verifyCli(spec(cli))).ok).toBe(false)
      expect((await verifyCli(spec(cli))).ok).toBe(false)
      expect(cli.calls('help')).toHaveLength(1)
      const later = new Date(Date.now() + 60_000)
      utimesSync(cli.path, later, later)
      expect((await verifyCli(spec(cli))).ok).toBe(false)
      expect(cli.calls('help')).toHaveLength(2)
    },
  )

  it.skipIf(isWindows)(
    'remembers a --help that failed to run for 60 seconds only: it may be a passing problem',
    async () => {
      const cli = fake({ help: CLAUDE_HELP, helpCode: 1 })
      let clock = 1_000_000
      const timed = { ...spec(cli), now: () => clock }
      expect(await verifyCli(timed)).toEqual({ ok: false, kind: 'unrunnable' })
      clock += UNRUNNABLE_TTL_MS - 1
      expect(await verifyCli(timed)).toEqual({ ok: false, kind: 'unrunnable' })
      expect(cli.calls('help')).toHaveLength(1)
      clock += 2
      expect(await verifyCli(timed)).toEqual({ ok: false, kind: 'unrunnable' })
      expect(cli.calls('help')).toHaveLength(2)
    },
  )

  it.skipIf(isWindows)('shares a verification that is running: concurrent first calls run --help once', async () => {
    const cli = fake({ help: CLAUDE_HELP })
    const results = await Promise.all([verifyCli(spec(cli)), verifyCli(spec(cli)), verifyCli(spec(cli))])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(cli.calls('help')).toHaveLength(1)
  })

  it.skipIf(isWindows)('the summarizer runs the path that was verified, not the bare name', async () => {
    const cli = fake({ help: CLAUDE_HELP, steps: [{ kind: 'text', text: JSON.stringify(VALID_SUMMARY) }] })
    const summarizer = new CliSummarizer({
      adapter: {
        label: 'x',
        command: 'a-name-that-resolves-to-nothing',
        envNames: ['PATH'],
        call: () => ({ args: [], stdin: 'hi' }),
        interpret: (output) => readSummaryFromText(output.stdout),
      },
      env: { PATH: process.env.PATH },
      verify: async () => ({ ok: true, path: cli.path, version: null }),
    })
    expect(await summarizer.summarize(REQUEST)).toEqual({ ok: true, value: VALID_SUMMARY })
    expect(cli.calls('run')).toHaveLength(1)
  })

  it.skipIf(isWindows)('says not found for a program that does not exist, without running anything', async () => {
    expect(await verifyCli({ ...spec(fake()), command: join(tmpdir(), 'no-such-cli-xyz') })).toEqual({
      ok: false,
      kind: 'notFound',
    })
    expect(await verifyCli({ ...spec(fake()), command: 'no-such-cli-xyz', env: { PATH: '/nonexistent' } })).toEqual({
      ok: false,
      kind: 'notFound',
    })
  })

  it.skipIf(isWindows)('finds a program on the PATH it was given', async () => {
    const cli = fake({ help: CLAUDE_HELP })
    const name = cli.path.split('/').pop() ?? ''
    expect(resolveExecutable(name, { PATH: cli.dir })).toBe(cli.path)
    expect(resolveExecutable(name, { PATH: '/nonexistent' })).toBeNull()
    expect(resolveExecutable(name, {})).toBeNull()
    // (the PATH also has node: the fake is a node script)
    const result = await verifyCli({ ...spec(cli), command: name, env: { PATH: `${cli.dir}:${process.env.PATH}` } })
    expect(result.ok).toBe(true)
  })

  it.skipIf(isWindows)(
    'runs --help with exactly the allowed environment, in an empty temporary directory that is removed after',
    async () => {
      const cli = fake({ help: CLAUDE_HELP })
      const env = {
        PATH: process.env.PATH,
        HOME: '/home/someone',
        ANTHROPIC_API_KEY: 'sk-secret',
        OPENAI_API_KEY: 'sk-other',
        HTTPS_PROXY: 'http://p',
      }
      await verifyCli(spec(cli, env))
      for (const call of cli.calls()) {
        expect(envNamesOf(call.env)).toEqual(['HOME', 'PATH'])
        expect(call.cwd.startsWith(realpathSync(tmpdir()))).toBe(true)
        expect(call.cwdEntries).toEqual([])
        expect(existsSync(call.cwd)).toBe(false)
      }
    },
  )
})

describe('ClaudeCliSummarizer with verification (RF-49)', () => {
  const VALID_STEP = {
    kind: 'text',
    text: JSON.stringify({ is_error: false, structured_output: VALID_SUMMARY }),
  } as const

  it.skipIf(isWindows)(
    'refuses to run a version that lacks a hardening flag, and says so; the model is never called',
    async () => {
      const cli = fake({ help: 'Usage: claude -p --model', steps: [VALID_STEP] })
      const summarizer = new ClaudeCliSummarizer({
        command: cli.path,
        model: 'sonnet',
        verify: true,
        env: { PATH: process.env.PATH },
      })
      const result = await summarizer.summarize(REQUEST)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('this version of claude cannot be run without tools')
        expect(result.error).toContain('--safe-mode')
        expect(result.error).not.toContain('SECRETO')
      }
      expect(cli.calls('run')).toEqual([])
    },
  )

  it.skipIf(isWindows)('runs a version that lists every flag, after verifying it once', async () => {
    const cli = fake({ help: CLAUDE_HELP, steps: [VALID_STEP] })
    const summarizer = new ClaudeCliSummarizer({
      command: cli.path,
      model: 'sonnet',
      verify: true,
      env: { PATH: process.env.PATH },
    })
    expect(await summarizer.summarize(REQUEST)).toEqual({ ok: true, value: VALID_SUMMARY, provider: 'claude-cli' })
    expect(await summarizer.summarize(REQUEST)).toEqual({ ok: true, value: VALID_SUMMARY, provider: 'claude-cli' })
    expect(cli.calls('help')).toHaveLength(1)
    expect(cli.calls('run')).toHaveLength(2)
  })

  it.skipIf(isWindows)('verifyClaudeCli is what doctor shows', async () => {
    const cli = fake({ help: CLAUDE_HELP })
    expect((await verifyClaudeCli(cli.path, { PATH: process.env.PATH })).ok).toBe(true)
  })

  it.skipIf(isWindows)('does not verify when not asked to (the adapter alone runs as configured)', async () => {
    const cli = fake({ help: 'nothing', steps: [VALID_STEP] })
    const summarizer = new ClaudeCliSummarizer({ command: cli.path, model: 'sonnet', env: { PATH: process.env.PATH } })
    expect((await summarizer.summarize(REQUEST)).ok).toBe(true)
    expect(cli.calls('help')).toEqual([])
  })
})

describe('verifyCli, the details that decide whether a CLI may run (RF-49)', () => {
  it.skipIf(isWindows)('only a regular, executable file counts as the program', () => {
    const cli = fake({ help: CLAUDE_HELP })
    const name = cli.path.split('/').pop() ?? ''
    const plain = join(cli.dir, 'plain-file')
    writeFileSync(plain, '#!/bin/sh\n')
    chmodSync(plain, 0o644)
    mkdirSync(join(cli.dir, 'a-directory'), { mode: 0o755 })
    expect(resolveExecutable('plain-file', { PATH: cli.dir })).toBeNull()
    expect(resolveExecutable(plain, {})).toBeNull()
    expect(resolveExecutable('a-directory', { PATH: cli.dir })).toBeNull()
    expect(resolveExecutable(join(cli.dir, 'a-directory'), {})).toBeNull()
    // a path with a directory is not looked up on the PATH, and an empty PATH entry is skipped
    expect(resolveExecutable(cli.path, {})).toBe(cli.path)
    expect(resolveExecutable(name, { PATH: `::${cli.dir}` })).toBe(cli.path)
    expect(resolveExecutable(`./${name}`, { PATH: cli.dir })).toBeNull()
  })

  it.skipIf(isWindows)('a relative path with a directory is resolved from the current directory', () => {
    const cli = fake({ help: CLAUDE_HELP })
    const relative = relativePath(process.cwd(), cli.path)
    expect(resolveExecutable(relative, {})).toBe(cli.path)
  })

  it.skipIf(isWindows)('a program that is not there is notFound, and is never run', async () => {
    expect(await verifyCli({ ...spec(fake()), command: '/nonexistent-dir-for-test/cli' })).toEqual({
      ok: false,
      kind: 'notFound',
    })
  })

  it.skipIf(isWindows)('a --help that does not finish within its time limit is unrunnable', async () => {
    // a limit so short that the program cannot even start
    const result = await verifyCli({ ...spec(fake({ help: CLAUDE_HELP })), timeoutMs: 1, killGraceMs: 50 })
    expect(result).toEqual({ ok: false, kind: 'unrunnable' })
  })

  it.skipIf(isWindows)('the version is the first non-blank line, trimmed, or null when it cannot be read', async () => {
    const spaced = fake({ help: CLAUDE_HELP, version: '\n  \n   claude 1.2.3   ' })
    expect(await verifyCli(spec(spaced))).toMatchObject({ ok: true, version: 'claude 1.2.3' })
    const blank = fake({ help: CLAUDE_HELP, version: '' })
    clearVerificationCache()
    expect(await verifyCli(spec(blank))).toMatchObject({ ok: true, version: null })
  })

  it.skipIf(isWindows)('a --version that fails still verifies, with no version', async () => {
    const cli = fake({ help: CLAUDE_HELP, version: '1.0', versionCode: 3 })
    expect(await verifyCli(spec(cli))).toEqual({ ok: true, path: cli.path, version: null })
  })

  it.skipIf(isWindows)('the verdict is per list of flags: a stricter list is not answered from the cache', async () => {
    const cli = fake({ help: CLAUDE_HELP })
    expect((await verifyCli(spec(cli))).ok).toBe(true)
    const stricter = { ...spec(cli), requiredFlags: [...CLAUDE_REQUIRED_FLAGS, '--no-such-flag'] }
    expect(await verifyCli(stricter)).toEqual({ ok: false, kind: 'missingFlags', flags: ['--no-such-flag'] })
  })

  it.skipIf(isWindows)('an unrunnable --help is looked at again exactly when the 60 seconds are over', async () => {
    const cli = fake({ help: CLAUDE_HELP, helpCode: 1 })
    let clock = 1_000_000
    const timed = { ...spec(cli), now: () => clock }
    await verifyCli(timed)
    clock += UNRUNNABLE_TTL_MS
    await verifyCli(timed)
    expect(cli.calls('help')).toHaveLength(2)
  })

  it.skipIf(isWindows)('a verdict about the flags is kept for good (only an unrunnable --help expires)', async () => {
    const cli = fake({ help: 'nothing useful' })
    let clock = 1_000_000
    const timed = { ...spec(cli), now: () => clock }
    await verifyCli(timed)
    clock += UNRUNNABLE_TTL_MS * 10
    await verifyCli(timed)
    expect(cli.calls('help')).toHaveLength(1)
    clearVerificationCache()
    await verifyCli(timed)
    expect(cli.calls('help')).toHaveLength(2)
  })
})

describe('the answer of ClaudeCliSummarizer with verification (RF-49)', () => {
  const ASK = { systemPrompt: 'S', input: 'Ana: texto-del-chat-de-prueba' }
  const ANSWER_STEP = { kind: 'text', text: JSON.stringify({ result: 'free text' }) } as const

  it.skipIf(isWindows)('refuses a version without a hardening flag: the answer is never run', async () => {
    const cli = fake({ help: 'Usage: claude -p --model', steps: [ANSWER_STEP] })
    const summarizer = new ClaudeCliSummarizer({
      command: cli.path,
      model: 'm',
      verify: true,
      env: { PATH: process.env.PATH },
    })
    const result = await summarizer.answer(ASK)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('cannot be run without tools')
    expect(cli.calls('run')).toEqual([])
  })

  it.skipIf(isWindows)('runs a verified version once, after one --help', async () => {
    const cli = fake({ help: CLAUDE_HELP, steps: [ANSWER_STEP] })
    const summarizer = new ClaudeCliSummarizer({
      command: cli.path,
      model: 'm',
      verify: true,
      env: { PATH: process.env.PATH },
    })
    expect(await summarizer.answer(ASK)).toEqual({ ok: true, text: 'free text', provider: 'claude-cli' })
    expect(cli.calls('help')).toHaveLength(1)
    expect(cli.calls('run')).toHaveLength(1)
  })
})
