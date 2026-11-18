/**
 * The one place a transcription runs (RNF-09): work given to `run` goes one at a time, in the order it was given. The
 * composition root makes ONE slot for the whole process and gives it to every account, so a daemon with N accounts runs
 * one whisper at a time, not N.
 */
export interface TranscriptionSlot {
  run<T>(work: () => Promise<T>): Promise<T>
}

export function createTranscriptionSlot(): TranscriptionSlot {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      const result = tail.then(work, work)
      tail = result.catch(() => undefined)
      return result
    },
  }
}
