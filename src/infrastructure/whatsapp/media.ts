import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { err, ok, type Result } from '../../domain/result.js'

/** The media directory of an account is private to its owner, and so are the audio files in it (RNF-04). */
export const MEDIA_DIR_MODE = 0o700
export const MEDIA_FILE_MODE = 0o600
/** A voice note of a few minutes is well under 1 MB: a file bigger than this is not one, and is not downloaded. */
export const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024
export const DEFAULT_AUDIO_DOWNLOAD_TIMEOUT_MS = 60_000
/** What the audio files of one account may take together, downloaded and not yet transcribed (`transcription.maxMediaMb`). */
export const DEFAULT_MAX_MEDIA_DIR_BYTES = 500 * 1024 * 1024

/**
 * Why a download did not happen or failed. Fixed words, recorded on the message; never an error message.
 * - invalid-media-path: the message has no `directPath`, or it is not a plain WhatsApp media path. Nothing is requested
 *   (the sender writes these fields, and they must never choose where we connect).
 * - unsupported-format: the mimetype is not one of the audio formats of WhatsApp.
 * - media-cap: the account's media directory is full (`transcription.maxMediaMb`).
 * - invalid-media: no usable decryption key.
 * - expired: the server no longer has the file (HTTP 404 or 410). It will not come back: Baileys' way of asking the sender
 *   to upload it again is a message out, which this program never sends (RNF-17).
 * - aborted: not a failure of the audio (the connection was closed or dropped): it is asked for again.
 */
export type AudioFetchFailure =
  | 'too-large'
  | 'timeout'
  | 'download-failed'
  | 'empty'
  | 'write-failed'
  | 'aborted'
  | 'invalid-media-path'
  | 'invalid-media'
  | 'unsupported-format'
  | 'media-cap'
  | 'expired'

/**
 * What a failure means for the queue (`DownloadFailure`): permanent (never will), transient (may work next time) or
 * unavailable (nothing can be tried now: not the fault of the audio).
 */
export function classifyFailure(code: AudioFetchFailure): 'permanent' | 'transient' | 'unavailable' {
  switch (code) {
    case 'timeout':
    case 'download-failed':
    case 'write-failed':
      return 'transient'
    case 'aborted':
      return 'unavailable'
    default:
      return 'permanent'
  }
}

/** The HTTP status that a failed download carries (Baileys throws a Boom with it), if any. */
function statusOf(error: unknown): number | undefined {
  const e = error as { output?: { statusCode?: unknown }; statusCode?: unknown; status?: unknown } | null
  for (const value of [e?.output?.statusCode, e?.statusCode, e?.status]) if (typeof value === 'number') return value
  return undefined
}

/** What the fetcher needs of an audio: the download descriptor, as the capture stored it. */
export interface AudioDescriptor {
  readonly directPath: string
  readonly mediaKey: Uint8Array
  readonly mimetype: string
  readonly fileLength: number | null
}

export interface AudioFetcherOptions {
  /** `accounts/<id>/media/`. Created (0700) on the first download. */
  readonly mediaDir: string
  /** Opens the audio as a stream of its decrypted bytes (the socket's `openAudio`). */
  readonly openAudio: (descriptor: AudioDescriptor) => Promise<Readable>
  /** Bigger files are refused, by the size the message announces and by what actually arrives. */
  readonly maxBytes?: number
  /** The whole download, opening included. */
  readonly timeoutMs?: number
  /** The most the media directory may hold. Default 500 MB. */
  readonly maxDirBytes?: number
  /** False once the connection is gone: a download that finishes after that is thrown away, not stored. */
  readonly isLive?: () => boolean
}

export interface AudioFetcher {
  /**
   * Downloads the audio into the media directory and returns its media reference: the file name, relative to the
   * directory. The file is written under a temporary name and renamed, so a half-written file is never mistaken for an
   * audio. `signal` aborts it: the stream is destroyed and the temporary file removed. Never throws.
   */
  fetch(
    descriptor: AudioDescriptor,
    key: { readonly conversationId: string; readonly messageId: string },
    signal?: AbortSignal,
  ): Promise<Result<string, AudioFetchFailure>>
}

/**
 * Audio formats of WhatsApp, by mimetype (parameters like `; codecs=opus` ignored) to the extension the file gets. The
 * transcription side picks the ffmpeg input format from that extension, so an unknown format never reaches ffmpeg.
 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
}

/** The extension for a mimetype, or undefined when it is not a known audio format. */
export function extensionForMimetype(mimetype: string | null | undefined): string | undefined {
  if (typeof mimetype !== 'string') return undefined
  const base = mimetype.split(';')[0]?.trim().toLowerCase() ?? ''
  return Object.hasOwn(EXTENSIONS, base) ? EXTENSIONS[base] : undefined
}

/**
 * Is this the `directPath` of a WhatsApp media: a path that starts with one slash and holds only the characters such
 * paths use? Refuses `@` (a user-info trick: `https://host@evil/`), backslashes, `//` (a protocol-relative address), `..`
 * and anything else odd. WhatsApp's own paths look like `/v/t62.7117-24/123_456_n.enc?ccb=11-4&oh=...&oe=...`.
 */
export function isSafeDirectPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 2_000) return false
  if (!path.startsWith('/')) return false
  if (path.includes('@') || path.includes('\\') || path.includes('//') || path.includes('..')) return false
  return /^\/[A-Za-z0-9._~\-/?=&%+:]*$/.test(path)
}

/**
 * The name of the file of an audio: derived from the conversation and message ids by hashing, so the id (a phone number
 * for an individual chat) is not in the file name and no id, whatever it holds, can make a path.
 */
export function mediaRefOf(conversationId: string, messageId: string, extension = 'ogg'): string {
  const digest = createHash('sha256').update(conversationId).update('\0').update(messageId).digest('hex')
  return `${digest.slice(0, 32)}.${extension}`
}

/** The bytes the files of a directory take (0 when it does not exist). Files only: the directory is flat. */
export async function mediaDirectoryBytes(mediaDir: string): Promise<number> {
  let total = 0
  for (const name of await readdir(mediaDir).catch(() => [] as string[])) {
    const info = await stat(join(mediaDir, name)).catch(() => null)
    if (info?.isFile() === true) total += info.size
  }
  return total
}

/** `mediaDir` must be a real directory (not a link) or absent: nothing is created or tightened through a link. */
async function ensureMediaDir(mediaDir: string): Promise<boolean> {
  const info = await lstat(mediaDir).catch(() => null)
  if (info !== null && !info.isDirectory()) return false
  await mkdir(mediaDir, { recursive: true, mode: MEDIA_DIR_MODE })
  if (process.platform !== 'win32') await chmod(mediaDir, MEDIA_DIR_MODE)
  return true
}

export function createAudioFetcher(options: AudioFetcherOptions): AudioFetcher {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_AUDIO_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUDIO_DOWNLOAD_TIMEOUT_MS
  const maxDirBytes = options.maxDirBytes ?? DEFAULT_MAX_MEDIA_DIR_BYTES
  const isLive = options.isLive ?? (() => true)

  return {
    async fetch(descriptor, { conversationId, messageId }, signal) {
      // A function, so each check reads the answer again: it changes while the download runs.
      const gone = (): boolean => signal?.aborted === true || !isLive()
      // Before anything else, and before any request: the sender wrote these fields (the capture checked them too).
      if (!isSafeDirectPath(descriptor.directPath)) return err('invalid-media-path')
      const extension = extensionForMimetype(descriptor.mimetype)
      if (extension === undefined) return err('unsupported-format')
      if (descriptor.mediaKey.byteLength !== 32) return err('invalid-media')
      if (gone()) return err('aborted')
      const announced = descriptor.fileLength
      if (announced !== null && announced > maxBytes) return err('too-large')

      try {
        if (!(await ensureMediaDir(options.mediaDir))) return err('write-failed')
        if ((await mediaDirectoryBytes(options.mediaDir)) + (announced ?? 0) > maxDirBytes) return err('media-cap')
      } catch {
        return err('write-failed')
      }
      const ref = mediaRefOf(conversationId, messageId, extension)
      const partial = join(options.mediaDir, `.${ref}.${randomBytes(6).toString('hex')}.part`)

      let stream: Readable | null = null
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const interrupted = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          stream?.destroy()
          reject(new Error('timeout'))
        }, timeoutMs)
        onAbort = () => {
          stream?.destroy()
          reject(new Error('aborted'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      interrupted.catch(() => undefined) // when the work wins, nobody awaits it
      let handle: Awaited<ReturnType<typeof open>> | null = null
      let failure: AudioFetchFailure = 'download-failed'
      const opening = options.openAudio(descriptor)
      opening.catch(() => undefined)
      try {
        stream = await Promise.race([opening, interrupted])
        const source = stream
        // An error while the file is being opened must not go unhandled (the loop below reads it again when it starts).
        source.on('error', () => undefined)
        try {
          handle = await open(partial, 'wx', MEDIA_FILE_MODE)
        } catch {
          failure = 'write-failed'
          throw new Error('write')
        }
        const file = handle
        let bytes = 0
        const copy = (async () => {
          for await (const chunk of source) {
            const data = chunk as Uint8Array
            bytes += data.byteLength
            if (bytes > maxBytes) {
              failure = 'too-large'
              throw new Error('too-large')
            }
            try {
              await file.write(data)
            } catch {
              failure = 'write-failed'
              throw new Error('write')
            }
          }
        })()
        copy.catch(() => undefined) // when the deadline wins, the stream is destroyed and this one fails: expected
        await Promise.race([copy, interrupted])
        if (bytes === 0) {
          failure = 'empty'
          throw new Error('empty')
        }
        // The connection may have gone while the last bytes arrived: nothing is stored for a unit that is released.
        if (gone()) throw new Error('aborted')
        await file.sync()
        await file.close()
        handle = null
        if (process.platform !== 'win32') await chmod(partial, MEDIA_FILE_MODE)
        if (gone()) throw new Error('aborted')
        await rename(partial, join(options.mediaDir, ref))
        return ok(ref)
      } catch (error) {
        if (gone() || (error as Error).message === 'aborted') return err('aborted')
        if ((error as Error).message === 'timeout') return err('timeout')
        // The server answered that the file is gone: it will not come back.
        if (stream === null && [404, 410].includes(statusOf(error) ?? 0)) return err('expired')
        return err(failure)
      } finally {
        clearTimeout(timer)
        if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
        stream?.destroy()
        // A stream that opened after we gave up is closed as soon as it shows up: nothing is left open.
        if (stream === null) {
          opening.then(
            (late) => late.destroy(),
            () => undefined,
          )
        }
        await handle?.close().catch(() => undefined)
        await rm(partial, { force: true })
      }
    },
  }
}
