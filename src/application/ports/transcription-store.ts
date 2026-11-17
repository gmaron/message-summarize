/** An audio that was downloaded and waits for its transcript (RF-15). */
export interface PendingAudio {
  readonly conversationId: string
  readonly messageId: string
  /** Where the file is, as the adapter that stored it wrote it down. The use case never looks inside it. */
  readonly mediaRef: string
  /** Epoch ms. */
  readonly timestamp: number
}

/** Epoch milliseconds: `from` inclusive, `until` exclusive. A missing end is open. */
export interface TimeRange {
  readonly from?: number
  readonly until?: number
}

/**
 * The queue of audios to transcribe. An audio is pending while it has a stored file, no transcript and no recorded
 * failure. Capture puts audios in (`CaptureRepository.setMedia`); the transcription use case takes them out.
 */
export interface TranscriptionStore {
  /** The OLDEST pending audio, optionally only inside `range`. Ties go in the order the messages were stored. */
  nextPending(range?: TimeRange): Promise<PendingAudio | null>
  countPending(range?: TimeRange): Promise<number>
  /**
   * Stores the transcript (possibly empty) and takes the audio out of the queue. False when it was not pending any
   * more (another process finished it first, or the message is gone): nothing changes.
   */
  complete(conversationId: string, messageId: string, transcript: string): Promise<boolean>
  /** Takes the audio out of the queue and records why. It is not tried again. */
  fail(conversationId: string, messageId: string, reason: string): Promise<void>
}
