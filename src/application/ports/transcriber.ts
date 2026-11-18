import type { Result } from '../../domain/result.js'

export interface TranscribeRequest {
  /** Absolute path of the audio file, in the format the platform delivered it (a WhatsApp voice note is Ogg Opus). */
  readonly audioPath: string
  /** `auto` to detect the language, or an ISO 639 code such as `es` or `en` (RF-23). */
  readonly language: string
}

/**
 * Why an audio was not transcribed.
 * - unavailable: the transcriber cannot work right now (a program or the model is missing, or it was stopped). Nothing is
 *   wrong with the audio: it stays pending and is tried again later (RF-21).
 * - failed: this audio cannot be transcribed (corrupt, unsupported). `reason` is a short internal text, never shown
 *   in a digest and never logged.
 * - timeout: it took longer than the limit and was killed.
 */
export type TranscribeFailure =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'timeout' }

/**
 * Turns an audio file into text, on this machine (RF-20): an implementation never sends the audio anywhere. A
 * transcript can be empty (silence or music).
 */
export interface Transcriber {
  transcribe(request: TranscribeRequest): Promise<Result<string, TranscribeFailure>>
  /** Kills whatever is running and refuses new work. The call may be repeated. */
  close?(): Promise<void>
}
