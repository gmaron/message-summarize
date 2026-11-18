import type { SummarizeRequest, SummarizeResult, Summarizer } from '../../../application/ports/summarizer.js'
import type { Result } from '../../../domain/result.js'
import { excerpt } from '../summary-schema.js'
import {
  type AttemptResult,
  type CliAdapter,
  CliSummarizer,
  correctionNote,
  readSummaryFromText,
  redactSent,
  schemaInPrompt,
} from './cli-summarizer.js'

/** The name this adapter reports as the provider of a summary (RF-74). */
export const GENERIC_CLI_PROVIDER = 'generic-cli'

/** In the command template, an element that is exactly this text is replaced by the whole prompt. */
export const PROMPT_PLACEHOLDER = '{{prompt}}'

/**
 * The only variables a generic CLI receives, when set: PATH to find programs, HOME so it finds its own login or config
 * files, USER and LOGNAME, LANG and TZ. Nothing else, and never one of our API keys: a generic CLI cannot be known to be
 * trustworthy with them.
 */
export const GENERIC_ENV_NAMES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TZ'] as const

export interface GenericCliOptions {
  /**
   * The command as an argument list: no shell, and no interpolation inside an element. The first element is the program.
   * An element that is exactly `{{prompt}}` receives the whole prompt; without one the prompt goes through stdin.
   */
  readonly command: readonly string[]
  /** RF-49: the generic CLI is refused unless the user acknowledged the risk. */
  readonly acknowledgeRisk: boolean
  /** Default 3 minutes. */
  readonly timeoutMs?: number
  readonly killGraceMs?: number
  readonly env?: NodeJS.ProcessEnv
}

/** Why a command template is not acceptable, or null. `{{prompt}}` is allowed only as a whole element, and never as the program. */
export function genericCommandProblem(
  command: readonly string[],
): 'empty' | 'placeholderInProgram' | 'partialPlaceholder' | null {
  const [program, ...rest] = command
  if (program === undefined || program.trim() === '') return 'empty'
  if (program.includes(PROMPT_PLACEHOLDER)) return 'placeholderInProgram'
  if (rest.some((element) => element !== PROMPT_PLACEHOLDER && element.includes(PROMPT_PLACEHOLDER))) {
    return 'partialPlaceholder'
  }
  return null
}

export const GENERIC_RISK_REFUSAL =
  'generic-cli was not run: it may run tools on text written by third parties (RF-49); set provider.genericCli.acknowledgeRisk to true to accept that'

function interpretGeneric(
  output: { stdout: string; stderr: string; code: number | null },
  sent: string,
): AttemptResult {
  if (output.code !== 0) {
    // Stdout is never quoted. Stderr is shown short, with any line of the prompt removed.
    const detail = output.stderr.trim()
      ? excerpt(redactSent(output.stderr, sent))
      : `stdout was ${output.stdout.length} chars`
    return { ok: false, error: `generic exited with code ${output.code}: ${detail}`, retryable: false }
  }
  return readSummaryFromText(output.stdout)
}

/**
 * Any command that takes the prompt (on stdin, or as one argument) and prints text with the answer (RF-47, generic mode).
 * It cannot be hardened: we do not know what the command can do. So it refuses to run without `acknowledgeRisk`, it
 * runs with the same containment as the presets (no shell, an empty directory, a minimal environment, a time limit, a
 * cap on the output), and it always asks for the schema in the prompt, validates, and retries once to correct (RF-48).
 */
export class GenericCliSummarizer implements Summarizer {
  private readonly inner: CliSummarizer

  constructor(options: GenericCliOptions) {
    const problem = genericCommandProblem(options.command)
    const viaArgument = options.command.includes(PROMPT_PLACEHOLDER)
    const adapter: CliAdapter = {
      label: 'generic',
      command: options.command[0] ?? '',
      envNames: GENERIC_ENV_NAMES,
      call: (request: SummarizeRequest, correction) => {
        const prompt = `${schemaInPrompt(request.systemPrompt)}\n\n---\n${request.transcript}${
          correction === null ? '' : correctionNote(correction)
        }`
        const args = options.command.slice(1).map((element) => (element === PROMPT_PLACEHOLDER ? prompt : element))
        return viaArgument ? { args, stdin: '', sent: prompt } : { args, stdin: prompt }
      },
      interpret: interpretGeneric,
    }
    const unavailable = !options.acknowledgeRisk
      ? GENERIC_RISK_REFUSAL
      : problem !== null
        ? `generic-cli command is not valid: ${problem}`
        : undefined
    this.inner = new CliSummarizer({
      adapter,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      ...(unavailable === undefined ? {} : { unavailable }),
    })
  }

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const result: Result<unknown, string> = await this.inner.summarize(request)
    return result.ok ? { ok: true, value: result.value, provider: GENERIC_CLI_PROVIDER } : result
  }
}
