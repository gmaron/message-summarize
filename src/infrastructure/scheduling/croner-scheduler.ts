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
  /** IANA name. The schedules follow its daylight saving changes (RF-62). `setTimezone` changes it. */
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
  /** One job per distinct expression, with the number of the creation it came from (see `generationOf`). */
  private jobs = new Map<string, { readonly job: Cron; readonly generation: number }>()
  private created = 0
  private running = false
  private schedules: readonly string[]
  private zone: string

  constructor(private readonly options: CronerSchedulerOptions) {
    this.zone = options.timezone
    this.schedules = [...new Set(options.schedules)]
  }

  /**
   * Which creation of the job of `expression` is armed (1 for the first job ever made, 2 for the next...), or
   * undefined when there is none. A job that survives a `replace` keeps its number: it is how a test (or a log) can
   * tell a job that was kept from one that was re-created.
   */
  generationOf(expression: string): number | undefined {
    return this.jobs.get(expression)?.generation
  }

  /** How many schedules it runs. */
  get count(): number {
    return this.schedules.length
  }

  /** The expressions it runs now. */
  get expressions(): readonly string[] {
    return this.schedules
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.arm()
  }

  stop(): void {
    this.running = false
    this.disarm()
  }

  /**
   * Replaces the schedules (RF-61): the jobs of the old ones are stopped and the new ones armed, without restarting
   * anything else. Called while it is stopped, it only changes what `start` will run.
   */
  replace(schedules: readonly string[]): void {
    this.schedules = [...new Set(schedules)]
    if (this.running) this.arm()
  }

  /** The time zone the schedules run in. */
  get timezone(): string {
    return this.zone
  }

  /**
   * Moves the schedules to another time zone (RF-62): the same expressions, so the same set, now at the hours of the
   * new zone. The armed jobs are re-created (a job keeps the zone it was made with); while stopped it only changes what
   * `start` will arm. No-op when the zone is the same.
   */
  setTimezone(timezone: string): void {
    if (timezone === this.zone) return
    this.zone = timezone
    if (!this.running) return
    this.disarm()
    this.arm()
  }

  /**
   * Makes the armed jobs match the schedules, one job per distinct expression: the jobs of expressions that are gone
   * are stopped, the ones that are new are created, and the ones that did not change are left alone (so a job that is
   * about to fire is not rebuilt by an unrelated change).
   */
  private arm(): void {
    const { onTick } = this.options
    const timezone = this.zone
    const wanted = new Set(this.schedules)
    for (const [expression, { job }] of this.jobs) {
      if (wanted.has(expression)) continue
      job.stop()
      this.jobs.delete(expression)
    }
    for (const schedule of this.schedules) {
      if (this.jobs.has(schedule)) continue
      const job = new Cron(schedule, { timezone, catch: true }, () => {
        onTick(schedule)
      })
      this.jobs.set(schedule, { job, generation: ++this.created })
    }
  }

  private disarm(): void {
    for (const { job } of this.jobs.values()) job.stop()
    this.jobs.clear()
  }

  /** The next run of every schedule after `from`. */
  nextRuns(from: Date): { readonly schedule: string; readonly next: Date | null }[] {
    const timezone = this.zone
    return this.schedules.map((schedule) => ({ schedule, next: nextRunOf(schedule, timezone, from) }))
  }

  /**
   * The most recent scheduled time at or before `now`, over all schedules, or null when there are none. It is what the
   * daemon compares with the digest pointer to find out whether a run was missed (RF-65).
   */
  lastDue(now: Date): Date | null {
    const timezone = this.zone
    let latest: Date | null = null
    for (const schedule of this.schedules) {
      const previous = previousRunOf(schedule, timezone, now)
      if (previous !== null && (latest === null || previous.getTime() > latest.getTime())) latest = previous
    }
    return latest
  }
}
