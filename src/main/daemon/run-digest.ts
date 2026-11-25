import { readFile } from 'node:fs/promises'
import type { DigestReport, GenerateDigestError } from '../../application/generate-digest.js'
import { err, type Result } from '../../domain/result.js'
import type { RunTrigger } from '../../infrastructure/persistence/sqlite/index.js'
import type { Runtime } from '../runtime.js'

export interface RunDigestOptions {
  /** A preview returns the digest and saves nothing (RF-64). */
  readonly preview: boolean
  readonly from?: number | undefined
  readonly until?: number | undefined
  readonly hours?: number | undefined
  /** Why it runs. Every run that is not a preview is recorded in the history (RF-74) under it. Default `cli`. */
  readonly trigger?: RunTrigger | undefined
}

export type RunDigestError =
  | GenerateDigestError
  /** No provider was chosen (RF-41). */
  | { readonly kind: 'noProvider' }
  /** `promptFile` is set and cannot be read. */
  | { readonly kind: 'promptFile'; readonly path: string }

/** An open run older than this is called interrupted (see `SqliteDigestRuns.markStale`). */
export const STALE_RUN_MS = 60 * 60_000

export const PLATFORM_NAME = 'WhatsApp'

/**
 * Runs the digest use case with the settings of the configuration. Shared by `msum digest` and the daemon's schedules.
 * The custom prompt is read on every run, so editing the file applies to the next digest.
 *
 * A run that is not a preview is recorded (RF-74): its row opens before anything else happens, so a crash leaves it open;
 * a run that commits closes it inside the commit's transaction; any other way out (an error value, an exception) closes
 * it here as failed, with the kind of the error as code.
 */
export async function runDigest(
  runtime: Runtime,
  options: RunDigestOptions,
): Promise<Result<DigestReport, RunDigestError>> {
  if (options.preview) return execute(runtime, options, undefined)
  const { runs, clock } = runtime
  // A run of any process that was cut off long ago is closed now: nobody else would, with no daemon around.
  try {
    runs.markStale(clock.now(), STALE_RUN_MS)
  } catch {
    // bookkeeping only
  }
  const runId = runs.start(options.trigger ?? 'cli', clock.now())
  const close = (code: string): void => {
    try {
      runs.fail(runId, clock.now(), code)
    } catch {
      // The history must not turn a failed digest into another failure; the open row is closed on the next start.
    }
  }
  try {
    const result = await execute(runtime, options, runId)
    if (!result.ok) close(result.error.kind)
    return result
  } catch (error) {
    close('failed')
    throw error
  }
}

async function execute(
  runtime: Runtime,
  options: RunDigestOptions,
  runId: number | undefined,
): Promise<Result<DigestReport, RunDigestError>> {
  const { generateDigest, config } = runtime
  if (generateDigest === null) return err({ kind: 'noProvider' })
  let promptTemplate: string | null = null
  if (config.promptFile !== null) {
    // The configuration loader resolved it against the directory of the file that set it: it is absolute here.
    const path = config.promptFile
    try {
      promptTemplate = await readFile(path, 'utf8')
    } catch {
      return err({ kind: 'promptFile', path })
    }
  }
  return generateDigest({
    preview: options.preview,
    from: options.from,
    until: options.until,
    hours: options.hours,
    settings: config.digest,
    promptTemplate,
    platformName: PLATFORM_NAME,
    concurrency: config.concurrency,
    runId,
  })
}
