import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { err, ok, type Result } from '../../src/domain/result.js'
import { parseSummaryResponse } from '../../src/domain/summary.js'
import {
  isOnMachine,
  OllamaSummarizer,
  passesRf45,
  REQUIRED_NEEDS_REPLY_AGREEMENT,
  REQUIRED_VALID_JSON_RATE,
} from '../../src/infrastructure/llm/index.js'
import { createRenderers } from '../../src/infrastructure/rendering/index.js'

// Evaluation of a local Ollama model against the made-up golden conversations (RF-45). It is a developer tool, not part
// of the product: `npm run eval:ollama -- --models qwen3:4b,gemma3:4b [--base-url URL] [--runs N] [--allow-remote]`.
//
// For every model and every case it calls the real `OllamaSummarizer` with the production system prompt and schema, and
// records whether the JSON came back valid, whether `necesita_respuesta` agrees with the hand-written label, how long it
// took and the error if any. The pass criteria are the ones of RF-45: 100% valid JSON and 90% or more agreement.

export const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ollama')
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'

export interface EvalCase {
  readonly id: string
  readonly owner: string
  readonly chatName: string
  readonly isGroup: boolean
  /** Exactly what the summarizer receives as the user message. */
  readonly transcript: string
  /** The reference label, written by hand under the rule in test/eval/ollama/README.md. */
  readonly needsReply: boolean
  readonly reason: string
  /** A reader could argue the label. Counted apart from the clear cases. */
  readonly doubtful: boolean
  /** Filler with no real message: it counts for the valid-JSON check and not for agreement. */
  readonly jsonOnly: boolean
}

/** Which figure a case feeds. `jsonOnly` wins over `doubtful`. */
export type CaseKind = 'clear' | 'doubtful' | 'jsonOnly'
export const kindOf = (item: Pick<EvalCase, 'doubtful' | 'jsonOnly'>): CaseKind =>
  item.jsonOnly ? 'jsonOnly' : item.doubtful ? 'doubtful' : 'clear'

interface TranscriptRow {
  readonly id: string
  readonly owner: string
  readonly chatName: string
  readonly isGroup: boolean
  readonly transcript: string
}
interface LabelRow {
  readonly id: string
  readonly chat: string
  readonly needsReply: boolean
  readonly reason: string
  readonly doubtful?: boolean
  readonly jsonOnly?: boolean
}

/** Joins `transcripts.json` and `labels.json`. Every transcript needs a label for the same chat, and the reverse. */
export async function loadCases(dir: string = EVAL_DIR): Promise<Result<EvalCase[], string>> {
  const transcripts = JSON.parse(await readFile(join(dir, 'transcripts.json'), 'utf8')) as TranscriptRow[]
  const labels = (JSON.parse(await readFile(join(dir, 'labels.json'), 'utf8')) as { labels: LabelRow[] }).labels
  const byId = new Map(labels.map((label) => [label.id, label]))
  const cases: EvalCase[] = []
  for (const row of transcripts) {
    const label = byId.get(row.id)
    if (label === undefined) return err(`case ${row.id} has no label`)
    if (label.chat !== row.chatName) return err(`label ${row.id} is for "${label.chat}", the case is "${row.chatName}"`)
    if (typeof label.needsReply !== 'boolean' || label.reason.trim() === '') return err(`label ${row.id} is incomplete`)
    cases.push({
      id: row.id,
      owner: row.owner,
      chatName: row.chatName,
      isGroup: row.isGroup,
      transcript: row.transcript,
      needsReply: label.needsReply,
      reason: label.reason,
      doubtful: label.doubtful === true,
      jsonOnly: label.jsonOnly === true,
    })
  }
  const known = new Set(transcripts.map((row) => row.id))
  for (const label of labels) if (!known.has(label.id)) return err(`label ${label.id} has no case`)
  return ok(cases)
}

export interface CaseRecord {
  readonly id: string
  readonly kind: CaseKind
  readonly valid: boolean
  /** What the model answered, when the JSON was valid. */
  readonly answered: boolean | null
  readonly expected: boolean
  readonly agrees: boolean
  readonly latencyMs: number
  readonly error: string | null
}

export interface ModelScore {
  readonly model: string
  /** Calls made: cases times runs. */
  readonly calls: number
  /** Over every call, filler included (RF-45 asks for 100%). */
  readonly validJsonRate: number
  /**
   * The figure RF-45's 90% is judged on: calls on CLEAR cases (not doubtful, not jsonOnly) whose JSON was valid AND
   * whose `necesita_respuesta` equals the label, over the calls on clear cases.
   */
  readonly needsReplyAgreement: number
  /** The same over the doubtful cases. Informative. */
  readonly doubtfulAgreement: number
  /** The same over clear and doubtful cases together (jsonOnly leaves out). Informative. */
  readonly overallAgreement: number
  readonly meanLatencyMs: number
  readonly errors: number
  readonly passed: boolean
}

export function score(model: string, records: readonly CaseRecord[]): ModelScore {
  const calls = records.length
  const share = (subset: readonly CaseRecord[], count: (record: CaseRecord) => boolean): number =>
    subset.length === 0 ? 0 : subset.filter(count).length / subset.length
  const clear = records.filter((record) => record.kind === 'clear')
  const doubtful = records.filter((record) => record.kind === 'doubtful')
  const validJsonRate = share(records, (record) => record.valid)
  const needsReplyAgreement = share(clear, (record) => record.agrees)
  const meanLatencyMs = calls === 0 ? 0 : Math.round(records.reduce((sum, record) => sum + record.latencyMs, 0) / calls)
  return {
    model,
    calls,
    validJsonRate,
    needsReplyAgreement,
    doubtfulAgreement: share(doubtful, (record) => record.agrees),
    overallAgreement: share([...clear, ...doubtful], (record) => record.agrees),
    meanLatencyMs,
    errors: records.filter((record) => record.error !== null).length,
    passed: clear.length > 0 && passesRf45({ validJsonRate, needsReplyAgreement }),
  }
}

export interface RunOptions {
  readonly model: string
  readonly baseUrl: string
  readonly runs: number
  readonly onCase?: (record: CaseRecord, index: number, total: number) => void
}

/** Calls the real `OllamaSummarizer` for each case, `runs` times, with the production prompt. */
export async function evaluateModel(cases: readonly EvalCase[], options: RunOptions): Promise<CaseRecord[]> {
  const summarizer = new OllamaSummarizer({ model: options.model, baseUrl: options.baseUrl })
  const renderers = createRenderers('es', 'America/Argentina/Buenos_Aires')
  const records: CaseRecord[] = []
  const total = cases.length * options.runs
  for (let run = 0; run < options.runs; run++) {
    for (const item of cases) {
      const started = Date.now()
      const result = await summarizer.summarize({
        conversation: { id: item.id, name: item.chatName, isGroup: item.isGroup },
        systemPrompt: renderers.systemPrompt.render(null, item.owner),
        transcript: item.transcript,
      })
      const latencyMs = Date.now() - started
      const base = { id: item.id, kind: kindOf(item), expected: item.needsReply, latencyMs }
      let record: CaseRecord
      if (!result.ok) {
        record = { ...base, valid: false, answered: null, agrees: false, error: result.error }
      } else {
        const parsed = parseSummaryResponse(result.value)
        record = parsed.ok
          ? {
              ...base,
              valid: true,
              answered: parsed.value.needsReply,
              agrees: parsed.value.needsReply === item.needsReply,
              error: null,
            }
          : {
              ...base,
              valid: false,
              answered: null,
              agrees: false,
              error: `invalid summary: ${parsed.error.join(', ')}`,
            }
      }
      records.push(record)
      options.onCase?.(record, records.length, total)
    }
  }
  return records
}

const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`

/** The table printed at the end: one row per model. */
export function renderTable(scores: readonly ModelScore[]): string {
  const header = [
    'model',
    'calls',
    'valid JSON',
    'agreement (clear)',
    'doubtful',
    'overall',
    'mean latency',
    'errors',
    'RF-45',
  ]
  const rows = scores.map((s) => [
    s.model,
    String(s.calls),
    percent(s.validJsonRate),
    percent(s.needsReplyAgreement),
    percent(s.doubtfulAgreement),
    percent(s.overallAgreement),
    `${s.meanLatencyMs} ms`,
    String(s.errors),
    s.passed ? 'PASS' : 'FAIL',
  ])
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)))
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd()
  return [
    line(header),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
    `RF-45 passes with ${percent(REQUIRED_VALID_JSON_RATE)} valid JSON (every case) and at least ${percent(REQUIRED_NEEDS_REPLY_AGREEMENT)} agreement on the clear cases (not doubtful, not JSON-only).`,
  ].join('\n')
}

/** `2026-11-17-qwen3-4b.json`: the model tag made safe for a file name. */
export const resultFileName = (date: string, model: string): string =>
  `${date}-${model.replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')}.json`

export interface EvalArgs {
  readonly models: readonly string[]
  readonly baseUrl: string
  readonly runs: number
  readonly allowRemote: boolean
}

/** `--models a,b [--base-url URL] [--runs N] [--allow-remote]`. */
export function parseEvalArgs(argv: readonly string[]): Result<EvalArgs, string> {
  let models: string[] = []
  let baseUrl = DEFAULT_BASE_URL
  let runs = 1
  let allowRemote = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = (): string | undefined => argv[++i]
    if (flag === '--models') {
      const text = value()
      if (text === undefined) return err('--models needs a comma-separated list of model tags')
      models = text
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== '')
    } else if (flag === '--base-url') {
      const text = value()
      if (text === undefined || text.trim() === '') return err('--base-url needs a URL')
      baseUrl = text.trim()
    } else if (flag === '--runs') {
      const text = value()
      runs = Number(text)
      if (text === undefined || !Number.isInteger(runs) || runs < 1)
        return err('--runs needs a whole number, 1 or more')
    } else if (flag === '--allow-remote') {
      allowRemote = true
    } else {
      return err(`unknown option: ${flag}`)
    }
  }
  if (models.length === 0) return err('--models is required, for example --models qwen3:4b,gemma3:4b')
  return ok({ models, baseUrl, runs, allowRemote })
}

export interface EvalDeps {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  /** `YYYY-MM-DD`. */
  readonly today: () => string
  readonly resultsDir: string
  readonly casesDir?: string
}

/** The one-line instruction to record a passing model in the table of candidates. */
const tableLine = (s: ModelScore, date: string): string =>
  `  ${s.model}: set  evaluated: true, result: { date: '${date}', validJsonRate: ${s.validJsonRate}, needsReplyAgreement: ${Number(s.needsReplyAgreement.toFixed(4))} }  in src/infrastructure/llm/ollama-candidates.ts`

/**
 * Runs the evaluation and returns the exit code: 0 when every model passed, 1 when one did not, 2 on wrong usage. A
 * base URL that is not on this machine is refused unless `--allow-remote` is given, because the transcripts are sent
 * to it (they are made up, but a habit of sending chats to another host is not one to build).
 */
export async function runEval(argv: readonly string[], deps: EvalDeps): Promise<number> {
  const parsed = parseEvalArgs(argv)
  if (!parsed.ok) {
    deps.err(parsed.error)
    return 2
  }
  const args = parsed.value
  if (!isOnMachine(args.baseUrl) && !args.allowRemote) {
    deps.err(
      `${args.baseUrl} is not on this machine. Use a loopback URL, or pass --allow-remote to send the test conversations there.`,
    )
    return 2
  }
  const loaded = await loadCases(deps.casesDir)
  if (!loaded.ok) {
    deps.err(`The evaluation set is inconsistent: ${loaded.error}`)
    return 2
  }
  const date = deps.today()
  await mkdir(deps.resultsDir, { recursive: true })
  const scores: ModelScore[] = []
  for (const model of args.models) {
    deps.out(`Evaluating ${model} on ${loaded.value.length} cases x ${args.runs} run(s) at ${args.baseUrl}`)
    const records = await evaluateModel(loaded.value, {
      model,
      baseUrl: args.baseUrl,
      runs: args.runs,
      onCase: (_record, index, total) => {
        if (index % 10 === 0 || index === total) deps.out(`  ${index}/${total}`)
      },
    })
    const result = score(model, records)
    scores.push(result)
    const file = join(deps.resultsDir, resultFileName(date, model))
    await writeFile(
      file,
      `${JSON.stringify({ date, baseUrl: args.baseUrl, runs: args.runs, cases: loaded.value.length, ...result, records }, null, 2)}\n`,
    )
    deps.out(`  written ${file}`)
  }
  deps.out(renderTable(scores))
  for (const result of scores.filter((s) => s.passed)) deps.out(tableLine(result, date))
  return scores.every((s) => s.passed) ? 0 : 1
}
