import { Cron } from 'croner'

/** True when `name` is an IANA time zone this runtime knows ("America/Argentina/Buenos_Aires"). */
export function isValidTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: name })
    return true
  } catch {
    return false
  }
}

/** A cron job that never fires: only used to compute dates. */
function dormant(expression: string, timezone: string): Cron {
  return new Cron(expression, { timezone, paused: true })
}

/** True when croner accepts the expression in that time zone. */
export function isValidCron(expression: string, timezone: string): boolean {
  try {
    dormant(expression, timezone).stop()
    return true
  } catch {
    return false
  }
}

/** The first run of the expression after `from`, or null. */
export function nextRunOf(expression: string, timezone: string, from: Date): Date | null {
  return dormant(expression, timezone).nextRun(from)
}

/** The last run of the expression at or before `from`, or null. */
export function previousRunOf(expression: string, timezone: string, from: Date): Date | null {
  return dormant(expression, timezone).previousRuns(1, from)[0] ?? null
}

export interface CronerSchedulerOptions {
  /** IANA name. The schedules follow its daylight saving changes (RF-62). */
  readonly timezone: string
  /** Cron expressions (RF-60). */
  readonly schedules: readonly string[]
  /** Called when a schedule fires, with its expression. It must not throw; a throw is swallowed. */
  readonly onTick: (schedule: string) => void
}

/**
 * RF-60..62: runs `onTick` at the times of the cron expressions, in the configured time zone, inside this process
 * (never in the operating system's crontab or scheduler). It only decides WHEN; what a tick does (and that two
 * digests never run at once, RF-66) is the caller's.
 */
export class CronerScheduler {
  private jobs: Cron[] = []

  constructor(private readonly options: CronerSchedulerOptions) {}

  start(): void {
    if (this.jobs.length > 0) return
    const { timezone, schedules, onTick } = this.options
    this.jobs = schedules.map(
      (schedule) =>
        new Cron(schedule, { timezone, catch: true }, () => {
          onTick(schedule)
        }),
    )
  }

  stop(): void {
    for (const job of this.jobs) job.stop()
    this.jobs = []
  }

  /** The next run of every schedule after `from`. */
  nextRuns(from: Date): { readonly schedule: string; readonly next: Date | null }[] {
    const { timezone, schedules } = this.options
    return schedules.map((schedule) => ({ schedule, next: nextRunOf(schedule, timezone, from) }))
  }

  /**
   * The most recent scheduled time at or before `now`, over all schedules, or null when there are none. It is what the
   * daemon compares with the digest pointer to find out whether a run was missed (RF-65).
   */
  lastDue(now: Date): Date | null {
    const { timezone, schedules } = this.options
    let latest: Date | null = null
    for (const schedule of schedules) {
      const previous = previousRunOf(schedule, timezone, now)
      if (previous !== null && (latest === null || previous.getTime() > latest.getTime())) latest = previous
    }
    return latest
  }
}
