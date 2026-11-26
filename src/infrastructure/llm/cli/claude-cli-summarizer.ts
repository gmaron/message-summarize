import type { SummarizeRequest, SummarizeResult, Summarizer } from '../../../application/ports/summarizer.js'
import type { Result } from '../../../domain/result.js'
import { parseSummaryResponse } from '../../../domain/summary.js'
import { excerpt, SUMMARY_JSON_SCHEMA_TEXT } from '../summary-schema.js'
import { type AttemptResult, type CliAdapter, CliSummarizer, parseJsonText, redactSent } from './cli-summarizer.js'
import { type CliVerification, verifyCli } from './verify.js'

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
  /**
   * RF-49: check with `claude --help` that this version has every flag of the hardening before the first call (cached by
   * the path and the modification time of the program), and refuse to run if not. Off by default: the composition root
   * turns it on.
   */
  readonly verify?: boolean
}

/**
 * The only environment variables the CLI child receives (RF-49, RNF-04), and only when set: PATH to find the binary
 * and its runtime, HOME, USER, LOGNAME and CLAUDE_CONFIG_DIR to find the user's existing login, LANG and TZ for locale
 * and dates. Nothing else leaks: no API keys, no tokens, no other tools' variables. Proxy and CA variables
 * (HTTPS_PROXY, NODE_EXTRA_CA_CERTS, ...) are intentionally NOT passed: a user behind a proxy must configure it
 * where the CLI itself reads it, not through this process.
 */
export const CHILD_ENV_NAMES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'CLAUDE_CONFIG_DIR', 'LANG', 'TZ'] as const

/**
 * Each of stdout and stderr is capped at about this many characters; past it the child is killed. (The newer presets use
 * the 2 MB of the HTTP APIs; this one keeps the limit it always had.)
 */
const MAX_OUTPUT_CHARS = 1_000_000

/** The flags of `claudeArgs`, as the `--help` of the CLI must list them (RF-49). */
export const CLAUDE_REQUIRED_FLAGS = [
  '--model',
  '--system-prompt',
  '--json-schema',
  '--output-format',
  '--tools',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--safe-mode',
  '--disable-slash-commands',
] as const

/**
 * Exact arguments of every call (RF-47, RF-49). `--tools ''` is one empty-string argument. The transcript is never an
 * argument: it goes through stdin. The system prompt is the program's or the user's own (it can be edited from the web,
 * RF-38), never third-party text; the CLI runs without tools either way.
 *
 * `--safe-mode` disables the user's customizations (CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands
 * and agents, output styles), so no hook receives the chat text. `--disable-slash-commands` is added on top. We do NOT
 * use `--bare`: it skips the OAuth/keychain login. A CLI too old to know these flags exits non-zero without JSON, and
 * `verify` refuses to run it at all. This matches RF-49: the CLI is only used when it can be verified to run this way.
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

const CORRECTION =
  '\n\n---\nYour previous answer was not valid. Answer again with only the JSON object that matches the schema: ' +
  'resumen (string), pendientes (list of strings), necesita_respuesta (true or false), prioridad (alta, media or baja).'

/** Verifies a Claude Code binary: the check `doctor` shows and the summarizer makes before its first call. */
export function verifyClaudeCli(
  command: string,
  env: NodeJS.ProcessEnv,
  requiredFlags: readonly string[] = CLAUDE_REQUIRED_FLAGS,
): Promise<CliVerification> {
  return verifyCli({ command, env, envNames: CHILD_ENV_NAMES, requiredFlags })
}

function interpretClaude(output: { stdout: string; stderr: string; code: number | null }, sent: string): AttemptResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(output.stdout)
  } catch {
    // Model output can echo chat text, so stdout is never quoted: only its length. Stderr is shown with any line of
    // the transcript removed.
    const detail = output.stderr.trim()
      ? excerpt(redactSent(output.stderr, sent))
      : `stdout was ${output.stdout.length} chars`
    return {
      ok: false,
      error: `claude exited with code ${output.code}: ${detail}`,
      retryable: output.code === 0,
    }
  }
  const out = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
  if (out.is_error === true) {
    const reason = String(out.result ?? out.subtype ?? 'error')
    return { ok: false, error: `claude: ${excerpt(redactSent(reason, sent))}`, retryable: false }
  }
  const structured = out.structured_output ?? parseJsonText(out.result)
  if (structured === undefined || structured === null) {
    return { ok: false, error: 'claude returned no structured output', retryable: true }
  }
  const valid = parseSummaryResponse(structured)
  if (!valid.ok) return { ok: false, error: `invalid summary: ${valid.error.join(', ')}`, retryable: true }
  return { ok: true, value: structured }
}

/** The name this adapter reports as the provider of a summary. */
export const CLAUDE_CLI_PROVIDER = 'claude-cli'

/** Summarizes with Claude Code in headless mode, with no tools, in an empty temporary directory (RF-47..49). */
export class ClaudeCliSummarizer implements Summarizer {
  private readonly inner: CliSummarizer

  constructor(options: ClaudeCliOptions) {
    const command = options.command ?? 'claude'
    const adapter: CliAdapter = {
      label: 'claude',
      command,
      envNames: CHILD_ENV_NAMES,
      // The schema is forced natively (`--json-schema`), so the retry only repeats the transcript with a request to correct.
      call: (request: SummarizeRequest, correction) => ({
        args: claudeArgs(options.model, request.systemPrompt),
        stdin: correction === null ? request.transcript : request.transcript + CORRECTION,
      }),
      interpret: interpretClaude,
    }
    this.inner = new CliSummarizer({
      adapter,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      maxOutputChars: MAX_OUTPUT_CHARS,
      ...(options.verify === true ? { verify: () => verifyClaudeCli(command, options.env ?? process.env) } : {}),
    })
  }

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const result: Result<unknown, string> = await this.inner.summarize(request)
    return result.ok ? { ok: true, value: result.value, provider: CLAUDE_CLI_PROVIDER } : result
  }
}
