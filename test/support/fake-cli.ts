import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allowSubprocess } from './network-guard.js'

// Fake CLI executables for the tests of the CLI summarizers: node scripts that record what they were run with and answer
// from a script. Like the fake whisper, they never touch the network. The guard of subprocesses only lets the paths
// declared here be spawned.

export type FakeStep =
  | { kind: 'text'; text: string; code?: number; stderr?: string }
  | { kind: 'hang' }
  | { kind: 'grandchild' }
  | { kind: 'flood'; chars?: number }
  | { kind: 'echo' }

export interface FakeCall {
  /** `help`, `version` or `run`. */
  kind: 'help' | 'version' | 'run'
  argv: string[]
  cwd: string
  cwdEntries: string[]
  env: Record<string, string>
  stdin: string
  pid: number
}

export interface FakeCli {
  /** The absolute path of the executable. */
  readonly path: string
  readonly dir: string
  /** Every call so far: `--help`, `--version` and runs. */
  calls(kind?: FakeCall['kind']): FakeCall[]
  readonly record: string
  dispose(): void
}

export interface FakeCliOptions {
  /** What each run prints, in order (the last repeats). */
  readonly steps?: readonly FakeStep[]
  /** What `--help` prints. Default: nothing useful. */
  readonly help?: string
  /** Exit code of `--help`. Default 0. */
  readonly helpCode?: number
  readonly version?: string
  /** Exit code of `--version`. Default 0. */
  readonly versionCode?: number
}

let seq = 0

export function installFakeCli(options: FakeCliOptions = {}): FakeCli {
  seq += 1
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fake-cli-test-')))
  const path = join(dir, `cli-${seq}`)
  const record = join(dir, 'calls.jsonl')
  writeFileSync(record, '')
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const steps = ${JSON.stringify(options.steps ?? [{ kind: 'text', text: '' }])}
const help = ${JSON.stringify(options.help ?? '')}
const helpCode = ${JSON.stringify(options.helpCode ?? 0)}
const version = ${JSON.stringify(options.version ?? 'fake-cli 1.2.3')}
const versionCode = ${JSON.stringify(options.versionCode ?? 0)}
const record = ${JSON.stringify(record)}
const argv = process.argv.slice(2)
const kind = argv[0] === '--help' ? 'help' : argv[0] === '--version' ? 'version' : 'run'
const runs = fs.readFileSync(record, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.kind === 'run').length
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (stdin += d))
process.stdin.on('end', () => {
  fs.appendFileSync(record, JSON.stringify({
    kind, argv, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), env: process.env, stdin, pid: process.pid,
  }) + '\\n')
  if (kind === 'help') { process.stdout.write(help); process.exitCode = helpCode; return }
  if (kind === 'version') { process.stdout.write(version + '\\n'); process.exitCode = versionCode; return }
  const step = steps[Math.min(runs, steps.length - 1)]
  if (step.kind === 'hang') { setInterval(() => {}, 1000); return }
  if (step.kind === 'grandchild') {
    const g = require('node:child_process').spawn('sleep', ['8'], { stdio: ['ignore', 'inherit', 'ignore'] })
    g.unref()
    fs.writeFileSync(record + '.gpid', String(g.pid))
    return
  }
  if (step.kind === 'flood') { process.stdout.write('x'.repeat(step.chars ?? 3000000)); setInterval(() => {}, 1000); return }
  if (step.kind === 'echo') {
    process.stdout.write('not json: ' + stdin)
    process.stderr.write('failure while reading: ' + stdin)
    return
  }
  if (step.stderr) process.stderr.write(step.stderr)
  process.stdout.write(step.text)
  process.exitCode = step.code ?? 0
})
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  const revoke = allowSubprocess(path)
  return {
    path,
    dir,
    record,
    calls: (kind) =>
      readFileSync(record, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeCall)
        .filter((call) => kind === undefined || call.kind === kind),
    dispose: () => {
      revoke()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The environment variable names a call saw, sorted, without the one macOS adds to every process. */
export const envNamesOf = (env: Record<string, string> | undefined): string[] =>
  Object.keys(env ?? {})
    .filter((name) => name !== '__CF_USER_TEXT_ENCODING')
    .sort()

/** The flags `claudeArgs` passes, as a `--help` would list them. */
export const CLAUDE_HELP = `Usage: claude [options]

Options:
  -p, --print                          Print response and exit
  --model <model>                      Model for the current session
  --system-prompt <prompt>             System prompt
  --json-schema <schema>               JSON Schema for structured output
  --output-format <format>             Output format
  --tools <tools...>                   Specify the list of available tools
  --strict-mcp-config                  Only use MCP servers from --mcp-config
  --no-session-persistence             Disable session persistence
  --safe-mode                          Start with all customizations disabled
  --disable-slash-commands             Disable all skills and commands
`
