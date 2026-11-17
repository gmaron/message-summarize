import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { err, ok, type Result } from '../../domain/result.js'
import { sha256File } from './checksum.js'
import { findModel, modelFileName, modelUrl, WHISPER_MODELS, type WhisperModel } from './models.js'

export interface DownloadProgress {
  /** Bytes received so far. */
  readonly received: number
  /** Bytes the whole file has (from the pinned table). */
  readonly total: number
}

/**
 * Why a download did not finish. Fixed words: the CLI translates them.
 * - unknownModel: the name is not in the table of pinned models.
 * - http: the server did not answer 200 (`status`).
 * - network: the connection failed, or stalled for too long.
 * - size: the file is not the size the table says (announced, or counted while receiving).
 * - checksum: the SHA-256 of what arrived is not the pinned one. Nothing was kept.
 * - write: the file could not be written to the models directory.
 */
export type DownloadError =
  | { readonly kind: 'unknownModel' }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'network' }
  | { readonly kind: 'size' }
  | { readonly kind: 'checksum' }
  | { readonly kind: 'write' }

export interface DownloadedModel {
  readonly path: string
  readonly bytes: number
  /** True when the file was there already and its checksum is the pinned one: nothing was downloaded. */
  readonly alreadyThere: boolean
}

export interface ModelDownloaderOptions {
  readonly modelsDir: string
  /** Replaced by tests: they never reach the network. Default the global `fetch`. */
  readonly fetch?: typeof fetch
  /** The pinned models. Default `WHISPER_MODELS`. */
  readonly table?: readonly WhisperModel[]
  /** Where a model comes from. Default the official whisper.cpp repository on Hugging Face (RNF-01). */
  readonly urlOf?: (name: string) => string
  /** The download is given up when no data arrives for this long. Default 60 seconds. */
  readonly stallMs?: number
  readonly onProgress?: (progress: DownloadProgress) => void
}

const MAX_REDIRECTS = 5

/** Hugging Face and its content network: the only hosts a model download may be sent to. */
export const isModelHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase()
  return host === 'huggingface.co' || host === 'hf.co' || host.endsWith('.hf.co')
}

const MODELS_DIR_MODE = 0o700
const MODEL_FILE_MODE = 0o600

/**
 * Downloads a whisper.cpp model into the models directory (RF-22).
 *
 * The size and the SHA-256 come from the pinned table, never from the server: the file is hashed while it is received,
 * written to a temporary file next to its destination, checked, and only then renamed into place. So a bad checksum, a
 * short or long file, or an interrupted download leaves no model behind (and no temporary file), and a model that is
 * there is always a complete, verified one. The program contacts the one host of `MODEL_BASE_URL`, and only when the
 * user asks for a download (RNF-01).
 */
export async function downloadModel(
  name: string,
  options: ModelDownloaderOptions,
): Promise<Result<DownloadedModel, DownloadError>> {
  const model = findModel(name, options.table ?? WHISPER_MODELS)
  if (model === undefined) return err({ kind: 'unknownModel' })
  const doFetch = options.fetch ?? fetch
  const url = (options.urlOf ?? modelUrl)(model.name)
  const finalPath = join(options.modelsDir, modelFileName(model.name))

  try {
    await mkdir(options.modelsDir, { recursive: true, mode: MODELS_DIR_MODE })
    if (process.platform !== 'win32') await chmod(options.modelsDir, MODELS_DIR_MODE)
  } catch {
    return err({ kind: 'write' })
  }

  // A verified model that is there already is not downloaded again.
  if ((await stat(finalPath).catch(() => null))?.isFile() === true) {
    const there = await sha256File(finalPath).catch(() => null)
    if (there === model.sha256) return ok({ path: finalPath, bytes: model.bytes, alreadyThere: true })
  }

  const partial = join(options.modelsDir, `.${modelFileName(model.name)}.${randomBytes(6).toString('hex')}.part`)
  const stallMs = options.stallMs ?? 60_000
  const controller = new AbortController()
  let stall: ReturnType<typeof setTimeout> | undefined
  const watch = (): void => {
    clearTimeout(stall)
    stall = setTimeout(() => controller.abort(), stallMs)
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    watch()
    let response: Response
    try {
      // Redirects are followed by hand, so each hop can be checked: Hugging Face sends the file to its own content network
      // (`*.hf.co`), and nothing else is a place this program downloads from (RNF-01).
      let target = url
      for (let hop = 0; ; hop++) {
        response = await doFetch(target, { signal: controller.signal, redirect: 'manual' })
        const next = response.headers.get('location')
        if (response.status < 300 || response.status >= 400 || next === null) break
        await response.body?.cancel().catch(() => undefined)
        const to = new URL(next, target)
        if (hop >= MAX_REDIRECTS || to.protocol !== 'https:' || !isModelHost(to.hostname)) {
          return err({ kind: 'network' })
        }
        target = to.href
      }
    } catch {
      return err({ kind: 'network' })
    }
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel().catch(() => undefined)
      return err({ kind: 'http', status: response.status })
    }
    const announced = response.headers.get('content-length')
    if (announced !== null && Number(announced) !== model.bytes) {
      await response.body.cancel().catch(() => undefined)
      return err({ kind: 'size' })
    }

    try {
      handle = await open(partial, 'wx', MODEL_FILE_MODE)
    } catch {
      await response.body.cancel().catch(() => undefined)
      return err({ kind: 'write' })
    }
    const hash = createHash('sha256')
    let received = 0
    try {
      for await (const chunk of response.body) {
        watch()
        received += chunk.byteLength
        // Never more than the pinned size: a server that keeps sending cannot fill the disk.
        if (received > model.bytes) return err({ kind: 'size' })
        hash.update(chunk)
        try {
          await handle.write(chunk)
        } catch {
          return err({ kind: 'write' })
        }
        options.onProgress?.({ received, total: model.bytes })
      }
    } catch {
      return err({ kind: 'network' })
    }
    if (received !== model.bytes) return err({ kind: 'size' })
    if (hash.digest('hex') !== model.sha256) return err({ kind: 'checksum' })
    try {
      await handle.sync()
      await handle.close()
      handle = null
      await rename(partial, finalPath)
    } catch {
      return err({ kind: 'write' })
    }
    return ok({ path: finalPath, bytes: model.bytes, alreadyThere: false })
  } finally {
    clearTimeout(stall)
    await handle?.close().catch(() => undefined)
    // After a successful rename there is nothing at `partial`: this only removes what a failure left.
    await rm(partial, { force: true })
  }
}
