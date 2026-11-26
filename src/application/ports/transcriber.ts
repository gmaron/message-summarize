import type { Result } from '../../domain/result.js'

export interface TranscribeRequest {
  /**
   * Absolute path of the media file, in the format the platform delivered it (a WhatsApp voice note is Ogg Opus; for an
   * image, JPEG, PNG or WebP).
   */
  readonly audioPath: string
  /** `auto` to detect the language, or an ISO 639 code such as `es` or `en` (RF-23). */
  readonly language: string
  /** What the file is. Absent: an audio. An image is read by the image reader, never by whisper. */
  readonly kind?: 'audio' | 'image'
  /** The text that came with an image (its label and caption), as context for whoever reads it. Never for audio. */
  readonly caption?: string | null
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
 * Turns a media file into text. For an audio it happens on this machine (RF-20): an implementation never sends the audio
 * anywhere. An image is different: reading it needs a model with vision, which is the configured provider, so the image
 * leaves this machine (opt-in, `imageReading`). A transcript can be empty (silence or music; an image with nothing to read).
 */
export interface Transcriber {
  transcribe(request: TranscribeRequest): Promise<Result<string, TranscribeFailure>>
  /** Kills whatever is running and refuses new work. The call may be repeated. */
  close?(): Promise<void>
}
