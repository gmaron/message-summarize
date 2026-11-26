import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnswerRequest } from '../../../application/ports/answerer.js'
import type { SummarizeRequest, Summarizer } from '../../../application/ports/summarizer.js'
import { err, ok, type Result } from '../../../domain/result.js'
import { parseSummaryResponse } from '../../../domain/summary.js'
import { excerpt, SUMMARY_JSON_SCHEMA_TEXT } from '../summary-schema.js'
import { DEFAULT_MAX_OUTPUT_CHARS, pickEnv, runProcess } from './run-process.js'
import type { CliVerification } from './verify.js'

/** What a CLI printed. Never quoted in an error: it can echo the chat. */
export interface CliOutput {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

/** What one attempt came to. `retryable` says that asking again to correct the answer may help (RF-48). */
export type AttemptResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean; readonly reason?: string }

/**
 * What differs between CLIs: the arguments, what goes on stdin, and how to read the answer. The core (`CliSummarizer`)
 * does everything RF-49 asks of every one of them: no shell, an empty temporary directory, a minimal environment, a time
 * limit that kills the whole process group, a cap on the output, and one retry to correct an unusable answer.
 */
export interface CliAdapter {
  /** Names the CLI in error reasons ("claude timed out after 3s"). */
  readonly label: string
  /** The program to run. */
  readonly command: string
  /** The only environment variables the child may receive, when set (see each preset for why). */
  readonly envNames: readonly string[]
  /**
   * The call to make. `correction` is null the first time; on the retry it is why the last answer was unusable (without
   * any text of the chat), for CLIs that put it in the prompt.
   */
  call(
    request: SummarizeRequest,
    correction: string | null,
  ): {
    readonly args: readonly string[]
    readonly stdin: string
    /** What carries the chat when it is not stdin (a prompt in an argument): used to keep it out of error reasons. */
    readonly sent?: string
  }
  /** Reads what the CLI printed. `sent` is what was written to its stdin, so the chat can be kept out of error reasons. */
  interpret(output: CliOutput, sent: string): AttemptResult
  /** How the CLI gives a free-text answer (the "Ask" tab): the same containment, no schema and no retry. */
  readonly answer?: {
    call(request: AnswerRequest): {
      readonly args: readonly string[]
      readonly stdin: string
      readonly sent?: string
    }
    interpret(
      output: CliOutput,
      sent: string,
    ): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }
  }
}

export interface CliSummarizerOptions {
  readonly adapter: CliAdapter
  /** Where the environment is taken from. Default `process.env`. Only the names of the adapter are used. */
  readonly env?: NodeJS.ProcessEnv
  /** Default 3 minutes. */
  readonly timeoutMs?: number
  /** One free-text answer (the "Ask" tab). Default 10 minutes. */
  readonly answerTimeoutMs?: number
  /** Time between SIGTERM and SIGKILL when the timeout fires. Default 5 seconds. */
  readonly killGraceMs?: number
  /** Cap on each of stdout and stderr, in characters. Default 2 MB, like the answers of the HTTP APIs. */
  readonly maxOutputChars?: number
  /**
   * RF-49: asked before the first call, and the call is not made when it says no. The result should be cached (see
   * `verifyCli`). Without it the CLI is run as configured, which is what the tests of an adapter do.
   */
  readonly verify?: () => Promise<CliVerification>
  /** Why the CLI is unavailable (a disabled preset, a generic CLI without acknowledgment): every call fails with it. */
  readonly unavailable?: string
}

/** The reason a call is refused when verification says no. English, for logs and reports, never shown in the digest. */
export function describeUnverified(label: string, result: Exclude<CliVerification, { ok: true }>): string {
  switch (result.kind) {
    case 'notFound':
      return `${label} was not found`
    case 'unrunnable':
      return `${label} could not be checked: its --help did not run`
    case 'missingFlags':
      return `this version of ${label} cannot be run without tools (RF-49): its --help does not list ${result.flags.join(', ')}`
    case 'disabled':
      return `${label} is disabled: its documentation offers no way to run it without tools (RF-49)`
  }
}

/**
 * Summarizes by running a CLI (RF-47..49). One call to `summarize` is at most two runs: if the answer is unusable (not
 * JSON, or it fails the summary schema) it is asked once more to correct it (RF-48); a timeout, a size overflow, an error
 * exit or a spawn error are not retried. After that the call fails and the backup provider takes over (RF-42).
 */
export class CliSummarizer implements Summarizer {
  private readonly timeoutMs: number
  private readonly killGraceMs: number
  private readonly maxOutputChars: number

  constructor(private readonly options: CliSummarizerOptions) {
    this.timeoutMs = options.timeoutMs ?? 3 * 60_000
    this.killGraceMs = options.killGraceMs ?? 5_000
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  }

  async summarize(request: SummarizeRequest): Promise<Result<unknown, string>> {
    const { adapter } = this.options
    if (this.options.unavailable !== undefined) return err(this.options.unavailable)
    // What is run is the program that was verified (its absolute path), not whatever the name resolves to later.
    let command = adapter.command
    if (this.options.verify !== undefined) {
      const verified = await this.options.verify()
      if (!verified.ok) return err(describeUnverified(adapter.label, verified))
      command = verified.path
    }
    const first = await this.attempt(request, null, command)
    if (first.ok || !first.retryable) return first.ok ? ok(first.value) : err(first.error)
    // RF-48: the answer was unusable. Ask once to correct it.
    const second = await this.attempt(request, first.reason ?? first.error, command)
    return second.ok ? ok(second.value) : err(`${first.error}; retry: ${second.error}`)
  }

  /**
   * A free-text answer: one run (never retried), verified and contained exactly as a summary is (RF-49). Fails when the
   * CLI has no way to answer in text.
   */
  async answer(request: AnswerRequest): Promise<Result<string, string>> {
    const { adapter } = this.options
    if (this.options.unavailable !== undefined) return err(this.options.unavailable)
    if (adapter.answer === undefined) return err(`${adapter.label} cannot give a free-text answer`)
    let command = adapter.command
    if (this.options.verify !== undefined) {
      const verified = await this.options.verify()
      if (!verified.ok) return err(describeUnverified(adapter.label, verified))
      command = verified.path
    }
    const { args, stdin, sent } = adapter.answer.call(request)
    const outcome = await this.run(command, args, stdin, this.options.answerTimeoutMs ?? 10 * 60_000)
    switch (outcome.kind) {
      case 'spawn-error':
        return err(outcome.reason)
      case 'timeout':
        return err(`${adapter.label} timed out after ${(this.options.answerTimeoutMs ?? 10 * 60_000) / 1000}s`)
      case 'too-large':
        return err(`${adapter.label} output exceeded the size limit`)
      case 'exited': {
        const read = adapter.answer.interpret(outcome, sent ?? stdin)
        return read.ok ? ok(read.text) : err(read.error)
      }
    }
  }

  private async run(command: string, args: readonly string[], stdin: string, timeoutMs: number) {
    const { adapter } = this.options
    const cwd = await mkdtemp(join(tmpdir(), 'message-summarize-llm-'))
    try {
      return await runProcess({
        command,
        args,
        stdin,
        cwd,
        env: pickEnv(this.options.env ?? process.env, adapter.envNames),
        timeoutMs,
        killGraceMs: this.killGraceMs,
        maxOutputChars: this.maxOutputChars,
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }

  private async attempt(request: SummarizeRequest, correction: string | null, command: string): Promise<AttemptResult> {
    const { adapter } = this.options
    const { args, stdin, sent } = adapter.call(request, correction)
    const outcome = await this.run(command, args, stdin, this.timeoutMs)
    switch (outcome.kind) {
      case 'spawn-error':
        return { ok: false, error: outcome.reason, retryable: false }
      case 'timeout':
        return { ok: false, error: `${adapter.label} timed out after ${this.timeoutMs / 1000}s`, retryable: false }
      case 'too-large':
        return { ok: false, error: `${adapter.label} output exceeded the size limit`, retryable: false }
      case 'exited':
        return adapter.interpret(outcome, sent ?? stdin)
    }
  }
}

/** Replaces every meaningful line of the text that was sent found in `text`, so error reasons never quote chat content. */
export function redactSent(text: string, sent: string): string {
  let out = text
  for (const line of new Set(sent.split('\n').map((l) => l.trim()))) {
    if (line.length >= 4) out = out.replaceAll(line, '[chat text]')
  }
  return out
}

/** JSON in a text, with or without the Markdown fence models like to put around it. Undefined when there is none. */
export function parseJsonText(text: unknown): unknown {
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

/**
 * RF-48 for a CLI that cannot force a schema: the schema goes in the prompt (the same words as the `prompt` mode of the
 * OpenAI adapter), and the answer is validated afterwards.
 */
export function schemaInPrompt(system: string): string {
  return `${system}\n\nAnswer with only a JSON object, with no other text, that matches this JSON schema: ${SUMMARY_JSON_SCHEMA_TEXT}`
}

/** What the retry asks for, with why the last answer was unusable. `why` is a validation message, never chat text. */
export function correctionNote(why: string): string {
  return (
    `\n\n---\nYour previous answer was not valid: ${excerpt(why)}. Answer again with only the JSON object that matches ` +
    'the schema: resumen (string), pendientes (list of strings), necesita_respuesta (true or false), ' +
    'prioridad (alta, media or baja).'
  )
}

/** Finds the summary in what a CLI that answers in plain text printed, and validates it. */
export function readSummaryFromText(stdout: string): AttemptResult {
  let value = parseJsonText(stdout)
  if (value === undefined) {
    // Some CLIs add a line or two around the JSON: take the outermost object.
    const start = stdout.indexOf('{')
    const end = stdout.lastIndexOf('}')
    if (start !== -1 && end > start) value = parseJsonText(stdout.slice(start, end + 1))
  }
  if (value === undefined || value === null) {
    // stdout can echo chat text: only its length is reported.
    return {
      ok: false,
      error: 'the answer is not JSON',
      retryable: true,
      reason: `it was not valid JSON (${stdout.length} characters)`,
    }
  }
  const valid = parseSummaryResponse(value)
  if (!valid.ok) {
    const detail = valid.error.join(', ')
    return { ok: false, error: `invalid summary: ${detail}`, retryable: true, reason: detail }
  }
  return { ok: true, value }
}
