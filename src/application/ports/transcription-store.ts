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

/** Which pending audio a claim takes first. */
export type ClaimOrder = 'newest' | 'oldest'

/**
 * The persistent work queue behind a pool of transcribers (RF-15, RF-20). A worker CLAIMS a pending audio: it is marked
 * in progress in the database, in one step, so no two workers ever get the same one, and it is not handed out again until
 * the claim is released. A claim never outlives the process: `releaseAllClaims` runs at start, so an audio that was
 * being transcribed when the process died is pending again.
 */
export interface TranscriptionClaims {
  /**
   * The next pending audio that nobody works on, marked in progress; null when there is none. `order` picks the end of
   * the queue (default `newest`: what just arrived is read first). Ties go in the order the messages were stored.
   */
  claimPending(range?: TimeRange, order?: ClaimOrder): Promise<PendingAudio | null>
  /** Gives the audio back: it is pending again (the transcription did not happen: stopped, or the transcriber was unavailable). */
  releaseClaim(conversationId: string, messageId: string): Promise<void>
  /** Every audio in progress is pending again. Returns how many were. */
  releaseAllClaims(): Promise<number>
}

/** Counts of the audio queues, for the progress log. Counts only. */
export interface AudioQueueStats {
  /** Waiting for their file to be downloaded. */
  readonly downloading: number
  /** File stored, waiting for a transcriber. */
  readonly pending: number
  /** Being transcribed now. */
  readonly running: number
  readonly done: number
  readonly failed: number
  /** Waiting for the phone to upload an old media again. */
  readonly reuploadRequested: number
}

export interface AudioQueueStatsSource {
  audioQueueStats(): Promise<AudioQueueStats>
}
