import { errorCode, type Logger } from '../logging/logger.js'

/** One request to stop, shared by the signals, a fatal error and the commands that wait for it. */
export interface Shutdown {
  request(): void
  /** Resolves when a stop is requested. Calling it tells the guards that someone handles the stop. */
  wait(): Promise<void>
  /** True once a command called `wait()`: only those commands (daemon, link) stop gracefully on a signal. */
  isAwaited(): boolean
}

export function createShutdown(): Shutdown {
  let requested: () => void = () => {}
  let awaited = false
  const promise = new Promise<void>((resolve) => {
    requested = resolve
  })
  return {
    request: () => requested(),
    wait: () => {
      awaited = true
      return promise
    },
    isAwaited: () => awaited,
  }
}

/** The part of `process` that the guards use. Tests give an EventEmitter. */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  exitCode?: number | string | null | undefined
  exit(code?: number): unknown
}

/** If a graceful stop after a fatal error takes longer than this, leave anyway (Docker's stop timeout is 10 s). */
export const FORCE_EXIT_MS = 8_000

export interface ProcessGuardOptions {
  readonly proc: ProcessLike
  readonly logger: Logger
  readonly shutdown: Shutdown
  readonly forceExitMs?: number
}

/**
 * SIGINT and SIGTERM ask for a graceful stop. An uncaught exception or an unhandled rejection is logged by its code
 * only (never its message or data: they can quote chat text or secrets), starts the same graceful stop (so the
 * daemon releases its lock and closes the database) and sets exit code 1. If the stop does not finish in time, the
 * process exits anyway.
 */
export function installProcessGuards({
  proc,
  logger,
  shutdown,
  forceExitMs = FORCE_EXIT_MS,
}: ProcessGuardOptions): void {
  // The first signal asks the command that waits for it (daemon, link) to stop gracefully. Any other case, or a
  // second signal, ends the process at once, as the default behavior would.
  let signalled = false
  const onSignal = (code: number) => () => {
    if (signalled || !shutdown.isAwaited()) {
      proc.exit(code)
      return
    }
    signalled = true
    shutdown.request()
  }
  proc.on('SIGINT', onSignal(130))
  proc.on('SIGTERM', onSignal(143))

  let failing = false
  const fatal = (event: string) => (reason: unknown) => {
    logger.error(event, { code: errorCode(reason) })
    proc.exitCode = 1
    if (failing) return
    failing = true
    // Nobody is waiting for a graceful stop (a short command): there is nothing to release.
    if (!shutdown.isAwaited()) {
      proc.exit(1)
      return
    }
    shutdown.request()
    setTimeout(() => proc.exit(1), forceExitMs).unref()
  }
  proc.on('uncaughtException', fatal('process.uncaughtException'))
  proc.on('unhandledRejection', fatal('process.unhandledRejection'))
}
