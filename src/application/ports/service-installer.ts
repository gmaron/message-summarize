import type { Result } from '../../domain/result.js'

/** What the operating system must start with the user's session: ONLY the daemon (RF-80). */
export interface ServiceDefinition {
  /** The program and its arguments, absolute: the node executable, the CLI entry and `daemon`. Never a shell line. */
  readonly command: readonly string[]
  /** The environment baked into the service (the data directory when it is not the default, PATH). Never a secret. */
  readonly env: Readonly<Record<string, string>>
  /** The data directory of the installation, where the adapter may keep its own helper files. */
  readonly dataDir: string
  /**
   * Start the daemon now, besides registering it. False when a daemon that the service did not start already holds the
   * installation: a second one would only fail on the lock and be restarted in a loop. It then starts at the next login.
   */
  readonly startNow: boolean
  /** Where the service manager writes what the daemon prints before its own log file exists. */
  readonly logsDir: string
}

/** Something the user may want to do next, which the installer never does by itself. */
export type ServiceHint = 'enableLinger' | 'startAtNextLogin' | 'stopRunningDaemon'

export interface ServiceInstallation {
  /** The file or registry value that holds the registration. */
  readonly location: string
  /** False when the registration was already exactly this one. */
  readonly changed: boolean
  readonly hints: readonly ServiceHint[]
}

export interface ServiceRemoval {
  /** False when there was nothing to remove. */
  readonly removed: boolean
  readonly location: string
  readonly hints: readonly ServiceHint[]
}

export interface ServiceStatus {
  readonly installed: boolean
  readonly location: string
  /** Whether the service manager says the daemon runs now; null when it cannot tell. */
  readonly running: boolean | null
}

/** A step of the registration that the operating system refused. `detail` is its own message, never chat text. */
export interface ServiceFailure {
  readonly step: string
  readonly detail: string
}

/**
 * Registers the daemon so it starts with the user's session and comes back after a crash (RNF-07). One adapter per
 * operating system. Installing and uninstalling are idempotent. It registers nothing but the daemon: schedules stay
 * inside it (never an OS scheduler).
 */
export interface ServiceInstaller {
  install(definition: ServiceDefinition): Promise<Result<ServiceInstallation, ServiceFailure>>
  uninstall(): Promise<Result<ServiceRemoval, ServiceFailure>>
  status(): Promise<ServiceStatus>
}
