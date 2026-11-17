import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DigestReport, GenerateDigestError } from '../application/generate-digest.js'
import { err, type Result } from '../domain/result.js'
import type { Runtime } from './runtime.js'

export interface RunDigestOptions {
  /** A preview returns the digest and saves nothing (RF-64). */
  readonly preview: boolean
  readonly from?: number | undefined
  readonly until?: number | undefined
  readonly hours?: number | undefined
}

export type RunDigestError =
  | GenerateDigestError
  /** No provider was chosen (RF-41). */
  | { readonly kind: 'noProvider' }
  /** `promptFile` is set and cannot be read. */
  | { readonly kind: 'promptFile'; readonly path: string }

export const PLATFORM_NAME = 'WhatsApp'

/**
 * Runs the digest use case with the settings of the configuration. Shared by `msum digest` and the daemon's schedules.
 * The custom prompt is read on every run, so editing the file applies to the next digest.
 */
export async function runDigest(
  runtime: Runtime,
  options: RunDigestOptions,
): Promise<Result<DigestReport, RunDigestError>> {
  const { generateDigest, config } = runtime
  if (generateDigest === null) return err({ kind: 'noProvider' })
  let promptTemplate: string | null = null
  if (config.promptFile !== null) {
    // A relative path is relative to the data directory, not to wherever the command was started.
    const path = resolve(runtime.layout.dataDir, config.promptFile)
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
  })
}
