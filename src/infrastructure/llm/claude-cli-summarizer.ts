import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SummarizeRequest, Summarizer } from '../../application/ports/summarizer.js'
import { err, ok, type Result } from '../../domain/result.js'
import { parseSummaryResponse } from '../../domain/summary.js'
import { excerpt, SUMMARY_JSON_SCHEMA_TEXT } from './summary-schema.js'

export interface ClaudeCliOptions {
  /** Executable to run. Default `claude`. */
  readonly command?: string
  readonly model: string
  /** Default 3 minutes. */
  readonly timeoutMs?: number
  /** Time between SIGTERM and SIGKILL when the timeout fires. Default 5 seconds. */
  readonly killGraceMs?: number
  /** Where the child environment is taken from. Default `process.env`. Only the names in CHILD_ENV_NAMES are used. */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * The only environment variables the CLI child receives (RF-49, RNF-04), and only when set: PATH to find the binary
 * and its runtime, HOME, USER, LOGNAME and CLAUDE_CONFIG_DIR to find the user's existing login, LANG and TZ for locale
 * and dates. Nothing else leaks: no API keys, no tokens, no other tools' variables. Proxy and CA variables
 * (HTTPS_PROXY, NODE_EXTRA_CA_CERTS, ...) are intentionally NOT passed: a user behind a proxy must configure it
 * where the CLI itself reads it, not through this process.
 */
export const CHILD_ENV_NAMES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'CLAUDE_CONFIG_DIR', 'LANG', 'TZ'] as const

/** Each of stdout and stderr is capped at about this many characters; past it the child is killed. */
const MAX_OUTPUT_CHARS = 1_000_000

/**
 * Exact arguments of every call (RF-47, RF-49). `--tools ''` is one empty-string argument. The transcript is never an
 * argument: it goes through stdin. The system prompt is ours, not third-party text.
 *
 * `--safe-mode` disables the user's customizations (CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands
 * and agents, output styles), so no hook receives the chat text. `--disable-slash-commands` is added on top. We do NOT
 * use `--bare`: it skips the OAuth/keychain login. A CLI too old to know these flags exits non-zero without JSON; that
 * is reported as an error, not retried, and the fallback (RF-42) takes over. This matches RF-49: the CLI is only used
 * when it can be verified to run this way.
 */
export function claudeArgs(model: string, systemPrompt: string): string[] {
  return [
    '-p',
    '--model',
    model,
    '--system-prompt',
    systemPrompt,
    '--json-schema',
    SUMMARY_JSON_SCHEMA_TEXT,
    '--output-format',
    'json',
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--safe-mode',
    '--disable-slash-commands',
  ]
}

type RunOutcome =
  | { readonly kind: 'exited'; readonly stdout: string; readonly stderr: string; readonly code: number | null }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'spawn-error'; readonly reason: string }

const CORRECTION =
  '\n\n---\nYour previous answer was not valid. Answer again with only the JSON object that matches the schema: ' +
  'resumen (string), pendientes (list of strings), necesita_respuesta (true or false), prioridad (alta, media or baja).'

/** Summarizes with Claude Code in headless mode, with no tools, in an empty temporary directory (RF-47..49). */
export class ClaudeCliSummarizer implements Summarizer {
  private readonly command: string
  private readonly timeoutMs: number
  private readonly killGraceMs: number

  constructor(private readonly options: ClaudeCliOptions) {
    this.command = options.command ?? 'claude'
    this.timeoutMs = options.timeoutMs ?? 3 * 60_000
    this.killGraceMs = options.killGraceMs ?? 5_000
  }

  async summarize(request: SummarizeRequest): Promise<Result<unknown, string>> {
    const first = await this.attempt(request, request.transcript)
    if (first.ok || !first.retryable) return first.ok ? ok(first.value) : err(first.error)
    // RF-48: the answer was unusable. Ask once to correct it.
    const second = await this.attempt(request, request.transcript + CORRECTION)
    return second.ok ? ok(second.value) : err(`${first.error}; retry: ${second.error}`)
  }

  private async attempt(
    request: SummarizeRequest,
    stdin: string,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string; retryable: boolean }> {
    const cwd = await mkdtemp(join(tmpdir(), 'message-summarize-llm-'))
    let outcome: RunOutcome
    try {
      outcome = await this.run(claudeArgs(this.options.model, request.systemPrompt), stdin, cwd)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
    if (outcome.kind === 'spawn-error') return { ok: false, error: outcome.reason, retryable: false }
    if (outcome.kind === 'timeout') {
      return { ok: false, error: `claude timed out after ${this.timeoutMs / 1000}s`, retryable: false }
    }
    if (outcome.kind === 'too-large') {
      return { ok: false, error: 'claude output exceeded the size limit', retryable: false }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(outcome.stdout)
    } catch {
      // Model output can echo chat text, so stdout is never quoted: only its length. Stderr is shown with any line of
      // the transcript removed.
      const detail = outcome.stderr.trim()
        ? excerpt(redact(outcome.stderr, stdin))
        : `stdout was ${outcome.stdout.length} chars`
      return {
        ok: false,
        error: `claude exited with code ${outcome.code}: ${detail}`,
        retryable: outcome.code === 0,
      }
    }
    const out = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
    if (out.is_error === true) {
      const reason = String(out.result ?? out.subtype ?? 'error')
      return { ok: false, error: `claude: ${excerpt(redact(reason, stdin))}`, retryable: false }
    }
    const structured = out.structured_output ?? parseJsonText(out.result)
    if (structured === undefined || structured === null) {
      return { ok: false, error: 'claude returned no structured output', retryable: true }
    }
    const valid = parseSummaryResponse(structured)
    if (!valid.ok) return { ok: false, error: `invalid summary: ${valid.error.join(', ')}`, retryable: true }
    return { ok: true, value: structured }
  }

  private run(args: string[], stdin: string, cwd: string): Promise<RunOutcome> {
    return new Promise((resolve) => {
      const source = this.options.env ?? process.env
      const env: NodeJS.ProcessEnv = {}
      for (const name of CHILD_ENV_NAMES) {
        const value = source[name]
        if (value !== undefined) env[name] = value
      }
      let settled = false
      let timedOut = false
      let stdout = ''
      let stderr = ''
      // detached: the child leads its own process group, so the whole tree (grandchildren included) can be killed.
      const child = spawn(this.command, args, {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid === undefined) return
          process.kill(-child.pid, signal)
        } catch {
          try {
            child.kill(signal)
          } catch {}
        }
      }
      const finish = (outcome: RunOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // The SIGKILL timer is never cleared on purpose: the group must still be killed after a timeout.
        resolve(outcome)
      }
      const abort = (outcome: RunOutcome) => {
        killGroup('SIGTERM')
        setTimeout(() => killGroup('SIGKILL'), this.killGraceMs).unref()
        child.stdout.destroy()
        child.stderr.destroy()
        finish(outcome)
      }
      const timer = setTimeout(() => {
        timedOut = true
        killGroup('SIGTERM')
        setTimeout(() => killGroup('SIGKILL'), this.killGraceMs).unref()
        // The child may already be gone with a grandchild holding the pipes open: do not wait for 'close'.
        if (child.exitCode !== null || child.signalCode !== null) {
          child.stdout.destroy()
          child.stderr.destroy()
          finish({ kind: 'timeout' })
        }
      }, this.timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        stdout += d
        if (stdout.length > MAX_OUTPUT_CHARS) abort({ kind: 'too-large' })
      })
      child.stderr.on('data', (d: string) => {
        stderr = (stderr + d).slice(-MAX_OUTPUT_CHARS) // only the tail matters
      })
      child.stdin.on('error', () => {}) // the child may exit before reading everything
      child.on('error', (e: NodeJS.ErrnoException) =>
        finish({ kind: 'spawn-error', reason: `could not run ${this.command}: ${e.code ?? 'error'}` }),
      )
      // After a timeout, resolve as soon as the child is gone (not when its pipes close).
      child.on('exit', () => {
        if (timedOut) {
          child.stdout.destroy()
          child.stderr.destroy()
          finish({ kind: 'timeout' })
        }
      })
      child.on('close', (code) => finish(timedOut ? { kind: 'timeout' } : { kind: 'exited', stdout, stderr, code }))
      child.stdin.end(stdin)
    })
  }
}

/** Replaces every meaningful line of the transcript found in `text`, so error reasons never quote chat content. */
function redact(text: string, transcript: string): string {
  let out = text
  for (const line of new Set(transcript.split('\n').map((l) => l.trim()))) {
    if (line.length >= 4) out = out.replaceAll(line, '[chat text]')
  }
  return out
}

function parseJsonText(text: unknown): unknown {
  if (typeof text !== 'string') return undefined
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}
