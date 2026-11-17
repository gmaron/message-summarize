/** A time limit: `expired` resolves when it passes, unless it was cancelled first. */
export interface Deadline {
  readonly expired: Promise<void>
  cancel(): void
}

/** Starts a time limit of `ms` milliseconds. The application has no timers of its own: the composition root gives them. */
export type StartDeadline = (ms: number) => Deadline
