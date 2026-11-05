import { err, ok, type Result } from './result.js'

const HOUR_MS = 3_600_000

/** Half-open interval of epoch milliseconds: a message belongs to it when since <= timestamp < until. */
export interface SummaryWindow {
  readonly since: number
  readonly until: number
}

/** Why a window is invalid. Codes, not text: the interfaces translate them. */
export type WindowError =
  | 'invalidEnd'
  | 'invalidStart'
  | 'invalidHours'
  | 'invalidPointer'
  | 'invalidDefaultHours'
  | 'startNotBeforeEnd'

export interface WindowRequest {
  /** End of the window (epoch ms): "now", or the explicit end requested. */
  readonly until: number
  readonly from?: number | undefined
  readonly hours?: number | undefined
  /** End of the previous digest, if any. */
  readonly pointer?: number | null | undefined
  readonly defaultHours: number
}

/**
 * Resolves the window of a digest (RF-32). The start is the first available of: explicit `from`, `until - hours`,
 * the pointer, `until - defaultHours`. Every value that is given is validated, even when a stronger one wins.
 * A pointer after `until` (with no explicit `from`) is valid and gives an empty window (since > until).
 */
export function resolveWindow(request: WindowRequest): Result<SummaryWindow, WindowError[]> {
  const { until, from, hours, pointer, defaultHours } = request
  const errors: WindowError[] = []
  if (!Number.isFinite(until)) errors.push('invalidEnd')
  if (from !== undefined && !Number.isFinite(from)) errors.push('invalidStart')
  if (hours !== undefined && !(Number.isFinite(hours) && hours > 0)) errors.push('invalidHours')
  if (pointer !== undefined && pointer !== null && !Number.isFinite(pointer)) errors.push('invalidPointer')
  if (!(Number.isFinite(defaultHours) && defaultHours > 0)) errors.push('invalidDefaultHours')
  if (errors.length === 0 && from !== undefined && !(from < until)) {
    errors.push('startNotBeforeEnd')
  }
  if (errors.length > 0) return err(errors)

  const since = from ?? (hours !== undefined ? until - hours * HOUR_MS : (pointer ?? until - defaultHours * HOUR_MS))
  return ok({ since, until })
}

export const isInWindow = (window: SummaryWindow, timestamp: number): boolean =>
  window.since <= timestamp && timestamp < window.until

/** The pointer never goes back. Whether to save it at all (a preview does not) is the caller's decision. */
export const nextPointer = (until: number, pointer: number | null | undefined): number => Math.max(until, pointer ?? 0)
