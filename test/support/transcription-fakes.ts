import type { Deadline, StartDeadline } from '../../src/application/ports/deadline.js'
import type { TranscribeFailure, TranscribeRequest, Transcriber } from '../../src/application/ports/transcriber.js'
import { err, ok, type Result } from '../../src/domain/result.js'

/**
 * A Transcriber with no program behind it. Without a script it follows the contract of the port
 * (test/contract/transcriber.contract.ts): the "audio files" are the keys of `files` and their content is what they say.
 * With `answer` a test decides what each call does (and for how long), and `inFlight` / `maxInFlight` show how many
 * calls overlapped.
 */
export class FakeTranscriber implements Transcriber {
  readonly calls: TranscribeRequest[] = []
  inFlight = 0
  maxInFlight = 0
  closed = false
  closeCalls = 0
  /** Resolves when `close()` is called, like a killed process ending: a call that waits for it ends as the real one would. */
  readonly closedSignal: Promise<void>
  private signalClosed: () => void = () => {}
  answer: ((request: TranscribeRequest) => Promise<Result<string, TranscribeFailure>>) | null = null

  constructor(readonly files: Record<string, string> = {}) {
    this.closedSignal = new Promise<void>((resolve) => {
      this.signalClosed = resolve
    })
  }

  async transcribe(request: TranscribeRequest): Promise<Result<string, TranscribeFailure>> {
    this.calls.push(request)
    if (this.closed) return err({ kind: 'unavailable', reason: 'closed' })
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.answer !== null) return await this.answer(request)
      const content = this.files[request.audioPath]
      if (content === undefined) return err({ kind: 'failed', reason: 'audio-missing' })
      return ok(content.replace(/\s+/g, ' ').trim())
    } finally {
      this.inFlight--
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.closeCalls++
    this.signalClosed()
  }
}

/**
 * A deadline the test fires by hand: `expire()` ends every wait that is open, `expire(ms)` only those started with that
 * duration. Nothing is ever really waited for.
 */
export function manualDeadlines(): {
  start: StartDeadline
  expire(ms?: number): void
  started: number[]
  cancelled: () => number
} {
  const open: { ms: number; resolve: () => void }[] = []
  const started: number[] = []
  let cancelled = 0
  const start: StartDeadline = (ms): Deadline => {
    started.push(ms)
    let resolve: () => void = () => {}
    const expired = new Promise<void>((r) => {
      resolve = r
    })
    open.push({ ms, resolve })
    return {
      expired,
      cancel: () => {
        cancelled++
      },
    }
  }
  return {
    start,
    expire: (ms) => {
      for (const entry of [...open]) {
        if (ms !== undefined && entry.ms !== ms) continue
        open.splice(open.indexOf(entry), 1)
        entry.resolve()
      }
    },
    started,
    cancelled: () => cancelled,
  }
}
