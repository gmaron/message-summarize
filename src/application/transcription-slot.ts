/**
 * The place the transcriptions run (RNF-09): work given to `run` starts in the order it was given, and at most `limit`
 * pieces run at once (`transcription.concurrency`, 1 by default). The composition root makes ONE slot for the whole
 * process and gives it to every account, so a daemon with N accounts never runs more whispers than the limit.
 */
export interface TranscriptionSlot {
  run<T>(work: () => Promise<T>): Promise<T>
}

export interface LimitedTranscriptionSlot extends TranscriptionSlot {
  /** How many pieces of work may run at once now. */
  readonly limit: number
  /** Changes how many pieces of work run at once (a whole number, at least 1). Applies to the work that starts next. */
  setLimit(limit: number): void
}

export function createTranscriptionSlot(initialLimit = 1): LimitedTranscriptionSlot {
  let limit = Math.max(1, Math.floor(initialLimit))
  let running = 0
  const waiting: (() => void)[] = []

  const release = (): void => {
    running--
    drain()
  }
  const drain = (): void => {
    while (running < limit) {
      const next = waiting.shift()
      if (next === undefined) return
      running++
      next()
    }
  }

  return {
    get limit() {
      return limit
    },
    setLimit(next) {
      limit = Math.max(1, Math.floor(next))
      drain()
    },
    run<T>(work: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        waiting.push(() => {
          let result: Promise<T>
          try {
            result = Promise.resolve(work())
          } catch (error) {
            result = Promise.reject(error)
          }
          result.then(resolve, reject).finally(release)
        })
        drain()
      })
    },
  }
}
