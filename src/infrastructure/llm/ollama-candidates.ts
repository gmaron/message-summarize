/**
 * Small local models that could summarize with Ollama (RF-45) and what each needs.
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
 * Until the evaluation has been run and its result committed (`npm run eval:ollama`, see README, "Choosing a local
 * model"), every candidate has `evaluated: false` and the recommendation is provisional.
 *
 * To record an evaluation: after `npm run eval:ollama -- --models <tag>` passes (it prints the lines), set on that
 * candidate `evaluated: true` and `result: { date, validJsonRate, needsReplyAgreement }` with the numbers of
 * test/eval/ollama/results/<date>-<tag>.json, and commit both. A test fails if a committed results file says a
 * candidate passed and the table still says `evaluated: false`.
 */

export interface OllamaEvaluationResult {
  /** `YYYY-MM-DD` of the run. */
  readonly date: string
  /** 0 to 1. RF-45 needs 1. */
  readonly validJsonRate: number
  /** 0 to 1, on the clear cases of the evaluation set (not doubtful, not JSON-only). RF-45 needs 0.9 or more. */
  readonly needsReplyAgreement: number
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
  { tag: 'qwen3.5:4b', family: 'qwen', parameters: '4B', downloadGb: 3.3, minRamGb: 8, evaluated: false },
  { tag: 'qwen3:4b', family: 'qwen', parameters: '4B', downloadGb: 2.5, minRamGb: 8, evaluated: false },
  { tag: 'qwen3:8b', family: 'qwen', parameters: '8B', downloadGb: 5.2, minRamGb: 16, evaluated: false },
  { tag: 'qwen2.5:3b', family: 'qwen', parameters: '3B', downloadGb: 1.9, minRamGb: 8, evaluated: false },
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

export interface Recommendation {
  readonly candidate: OllamaCandidate
  /** True while no fitting candidate has a committed passing evaluation. */
  readonly provisional: boolean
}

/** Bytes to GB as people read RAM (a "16 GB" Mac reports slightly less than 16 * 2^30). */
export const bytesToGb = (bytes: number): number => bytes / 1024 ** 3

/** A machine reports a bit less than its nominal RAM (a 16 GB Mac: about 15.9 GiB), so a small margin is allowed. */
export const fitsRam = (candidate: OllamaCandidate, totalMemBytes: number): boolean =>
  candidate.minRamGb <= bytesToGb(totalMemBytes) + 0.5

/**
 * The best candidate that fits in `totalMemBytes`. With evaluations: the passing candidate with the best agreement
 * (the smaller download on a tie). Without any: the one with the largest download that fits, which is a guess, so the
 * result is provisional. Null when not even the smallest fits.
 */
export function recommendCandidate(
  totalMemBytes: number,
  candidates: readonly OllamaCandidate[] = OLLAMA_CANDIDATES,
): Recommendation | null {
  const fits = candidates.filter((candidate) => fitsRam(candidate, totalMemBytes))
  const passing = fits.filter(
    (candidate) => candidate.evaluated && candidate.result !== undefined && passesRf45(candidate.result),
  )
  if (passing.length > 0) {
    const [best] = [...passing].sort(
      (a, b) =>
        (b.result?.needsReplyAgreement ?? 0) - (a.result?.needsReplyAgreement ?? 0) || a.downloadGb - b.downloadGb,
    )
    return best === undefined ? null : { candidate: best, provisional: false }
  }
  const [guess] = [...fits].sort((a, b) => b.downloadGb - a.downloadGb)
  return guess === undefined ? null : { candidate: guess, provisional: true }
}
