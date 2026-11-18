/**
 * Small local models that could summarize with Ollama (RF-45) and what each needs. The program lists them and the
 * USER chooses: nothing here picks a model.
 *
 * Tags, parameter counts and download sizes come from the pages of the Ollama library, read on 2026-11-17:
 * https://ollama.com/library/qwen3, /qwen3.5, /qwen2.5, /gemma3, /gemma4, /llama3.1, /llama3.2 and /phi4-mini.
 * Models of 3 to 8 billion parameters only. Left out on purpose: qwen3.5:9b (9B), gemma4:e2b (2.3B effective) and
 * gemma4:12b (outside the range).
 *
 * `minRamGb` is NOT published by Ollama. It is an estimate: the download size times 1.25 (the model in memory plus the
 * 16K-token context the product asks for) plus 3 GB for the system and the rest of the programs, rounded up to 8 or
 * 16. Where a page gives a range of sizes (the same tag with different quantizations), `downloadGb` is the lowest.
 *
 * `evaluated` and `result` record the evaluation of test/eval/ollama (`npm run eval:ollama`, see README, "Choosing a
 * local model"), passing or failing. A candidate with no committed results file stays `evaluated: false`.
 *
 * To record an evaluation: copy the numbers of test/eval/ollama/results/<date>-<tag>.json (date, validJsonRate,
 * needsReplyAgreement rounded to 4 decimals, meanLatencyMs, passed) into the candidate and commit both. A test fails
 * if a committed results file and the table disagree.
 */

export interface OllamaEvaluationResult {
  /** `YYYY-MM-DD` of the run. */
  readonly date: string
  /** 0 to 1, over every case. RF-45 needs 1. */
  readonly validJsonRate: number
  /** 0 to 1, on the clear cases of the evaluation set (not doubtful, not JSON-only). RF-45 needs 0.9 or more. */
  readonly needsReplyAgreement: number
  readonly meanLatencyMs: number
  /** Whether it meets RF-45. */
  readonly passed: boolean
}

export interface OllamaCandidate {
  readonly tag: string
  readonly family: 'qwen' | 'gemma' | 'llama' | 'phi'
  /** As the library page states it. */
  readonly parameters: string
  readonly downloadGb: number
  /** Estimate, see above. */
  readonly minRamGb: 8 | 16
  readonly evaluated: boolean
  readonly result?: OllamaEvaluationResult
}

export const OLLAMA_CANDIDATES: readonly OllamaCandidate[] = [
  {
    tag: 'qwen3.5:4b',
    family: 'qwen',
    parameters: '4B',
    downloadGb: 3.3,
    minRamGb: 8,
    evaluated: true,
    result: { date: '2026-11-18', validJsonRate: 1, needsReplyAgreement: 0.9206, meanLatencyMs: 3641, passed: true },
  },
  {
    tag: 'qwen3:4b',
    family: 'qwen',
    parameters: '4B',
    downloadGb: 2.5,
    minRamGb: 8,
    evaluated: true,
    result: { date: '2026-11-18', validJsonRate: 1, needsReplyAgreement: 0.6349, meanLatencyMs: 3129, passed: false },
  },
  {
    tag: 'qwen3:8b',
    family: 'qwen',
    parameters: '8B',
    downloadGb: 5.2,
    minRamGb: 16,
    evaluated: true,
    result: { date: '2026-11-18', validJsonRate: 1, needsReplyAgreement: 0.9048, meanLatencyMs: 4299, passed: true },
  },
  {
    tag: 'qwen2.5:3b',
    family: 'qwen',
    parameters: '3B',
    downloadGb: 1.9,
    minRamGb: 8,
    evaluated: true,
    result: { date: '2026-11-18', validJsonRate: 1, needsReplyAgreement: 0.873, meanLatencyMs: 2072, passed: false },
  },
  { tag: 'qwen2.5:7b', family: 'qwen', parameters: '7B', downloadGb: 4.7, minRamGb: 16, evaluated: false },
  { tag: 'gemma3:4b', family: 'gemma', parameters: '4B', downloadGb: 3.4, minRamGb: 8, evaluated: false },
  {
    tag: 'gemma4:e4b',
    family: 'gemma',
    parameters: '4.5B effective (8B with embeddings)',
    downloadGb: 6.6,
    minRamGb: 16,
    evaluated: false,
  },
  { tag: 'llama3.2:3b', family: 'llama', parameters: '3B', downloadGb: 2.0, minRamGb: 8, evaluated: false },
  { tag: 'llama3.1:8b', family: 'llama', parameters: '8B', downloadGb: 4.9, minRamGb: 16, evaluated: false },
  { tag: 'phi4-mini:3.8b', family: 'phi', parameters: '3.8B', downloadGb: 2.5, minRamGb: 8, evaluated: false },
]

/** RF-45. */
export const REQUIRED_VALID_JSON_RATE = 1
export const REQUIRED_NEEDS_REPLY_AGREEMENT = 0.9

export function passesRf45(result: { readonly validJsonRate: number; readonly needsReplyAgreement: number }): boolean {
  return (
    result.validJsonRate >= REQUIRED_VALID_JSON_RATE && result.needsReplyAgreement >= REQUIRED_NEEDS_REPLY_AGREEMENT
  )
}

/** Bytes to GB as people read RAM (a "16 GB" Mac reports slightly less than 16 * 2^30). */
export const bytesToGb = (bytes: number): number => bytes / 1024 ** 3

/** A machine reports a bit less than its nominal RAM (a 16 GB Mac: about 15.9 GiB), so a small margin is allowed. */
export const fitsRam = (candidate: OllamaCandidate, totalMemBytes: number): boolean =>
  candidate.minRamGb <= bytesToGb(totalMemBytes) + 0.5

export interface ListedCandidate {
  readonly candidate: OllamaCandidate
  readonly fits: boolean
}

/** Evaluated and passing first, then not evaluated, then failing. */
const group = (candidate: OllamaCandidate): number =>
  candidate.evaluated && candidate.result !== undefined ? (candidate.result.passed ? 0 : 2) : 1

/**
 * The candidates to choose from. Only the ones that fit `totalMemBytes` unless `all`. Sorted with the passing ones
 * first (best agreement first, the smaller download on a tie), then the ones not evaluated (table order), then the
 * failing ones (best agreement first). Nothing is picked: the user chooses.
 */
export function listCandidates(
  totalMemBytes: number,
  options: { readonly all?: boolean; readonly candidates?: readonly OllamaCandidate[] } = {},
): ListedCandidate[] {
  const candidates = options.candidates ?? OLLAMA_CANDIDATES
  const listed = candidates
    .map((candidate, index) => ({ candidate, index, fits: fitsRam(candidate, totalMemBytes) }))
    .filter((entry) => options.all === true || entry.fits)
  listed.sort((a, b) => {
    const byGroup = group(a.candidate) - group(b.candidate)
    if (byGroup !== 0) return byGroup
    if (group(a.candidate) === 1) return a.index - b.index
    return (
      (b.candidate.result?.needsReplyAgreement ?? 0) - (a.candidate.result?.needsReplyAgreement ?? 0) ||
      a.candidate.downloadGb - b.candidate.downloadGb ||
      a.index - b.index
    )
  })
  return listed.map(({ candidate, fits }) => ({ candidate, fits }))
}
