import { join } from 'node:path'
import type {
  ServiceDefinition,
  ServiceFailure,
  ServiceInstallation,
  ServiceInstaller,
  ServiceRemoval,
  ServiceStatus,
} from '../../application/ports/service-installer.js'
import { err, ok, type Result } from '../../domain/result.js'
import { assertSingleLine, type CommandResult, firstLine, type ServiceHost } from './host.js'

export const LAUNCHD_LABEL = 'dev.message-summarize.daemon'
/** launchd waits this long before it starts a job again (its default, written down so it is not a surprise). */
const THROTTLE_SECONDS = 10
/** `launchctl bootstrap` sometimes fails with EIO right after a `bootout`: it is tried again a couple of times. */
const BOOTSTRAP_ATTEMPTS = 3
const BOOTSTRAP_RETRY_MS = 500

const isIoError = (result: CommandResult): boolean => result.code === 5 || /Input\/output error/i.test(result.stderr)
/** What `bootout` says of a job that is not loaded: not a failure. */
const isNotLoaded = (result: CommandResult): boolean =>
  result.code === 3 || result.code === 113 || /no such process|could not find/i.test(result.stderr)

const xml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The plist of the user agent. `KeepAlive` brings the daemon back after any exit and `RunAtLoad` starts it with the
 * session. Arguments are one `<string>` each, so a path with spaces needs no quoting. Standard output and error go to
 * /dev/null: the daemon writes its own log file, rotated and bounded (RNF-12), and a file here would grow forever.
 */
export function launchdPlist(definition: ServiceDefinition): string {
  for (const value of [...definition.command, definition.logsDir]) assertSingleLine(value)
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...definition.command.map((argument) => `    <string>${xml(argument)}</string>`),
    '  </array>',
  ]
  const env = Object.entries(definition.env)
  if (env.length > 0) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>')
    for (const [name, value] of env) {
      assertSingleLine(name)
      assertSingleLine(value)
      lines.push(`    <key>${xml(name)}</key>`, `    <string>${xml(value)}</string>`)
    }
    lines.push('  </dict>')
  }
  lines.push(
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    `  <integer>${THROTTLE_SECONDS}</integer>`,
    '  <key>StandardOutPath</key>',
    '  <string>/dev/null</string>',
    '  <key>StandardErrorPath</key>',
    '  <string>/dev/null</string>',
    '</dict>',
    '</plist>',
    '',
  )
  return lines.join('\n')
}

/** macOS: a launchd user agent in `~/Library/LaunchAgents`, loaded into the user's `gui/<uid>` domain. */
export class LaunchdInstaller implements ServiceInstaller {
  private readonly plistPath: string
  private readonly domain: string
  private readonly target: string

  constructor(private readonly host: ServiceHost) {
    this.plistPath = join(host.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
    this.domain = `gui/${host.uid ?? 0}`
    this.target = `${this.domain}/${LAUNCHD_LABEL}`
  }

  private async printed(): Promise<{ loaded: boolean; running: boolean }> {
    const result = await this.host.runner.run('launchctl', ['print', this.target])
    return { loaded: result.code === 0, running: result.code === 0 && /^\s*state = running\s*$/m.test(result.stdout) }
  }

  async install(definition: ServiceDefinition): Promise<Result<ServiceInstallation, ServiceFailure>> {
    const plist = launchdPlist(definition)
    const before = await this.host.files.read(this.plistPath)
    const { loaded } = await this.printed()
    if (before === plist && loaded) return ok({ location: this.plistPath, changed: false, hints: [] })
    // The agent's working directory exists before it runs (the daemon would create it too).
    await this.host.files.ensureDir(definition.logsDir)
    await this.host.files.write(this.plistPath, plist, 0o644)
    // A job that is loaded is replaced, not added to: `bootstrap` of a loaded label fails.
    if (loaded) {
      const out = await this.host.runner.run('launchctl', ['bootout', this.target])
      if (out.code !== 0 && !isNotLoaded(out)) {
        await this.restore(before)
        return err({ step: 'launchctl bootout', detail: firstLine(out) })
      }
    }
    // Registered for the next login, but not started now next to a daemon the service did not start.
    if (!loaded && !definition.startNow) return ok({ location: this.plistPath, changed: true, hints: [] })
    const result = await this.bootstrap()
    if (result.code !== 0) {
      await this.restore(before)
      // The old agent was booted out above: put it back, best effort.
      if (loaded && before !== null) await this.bootstrap()
      return err({ step: 'launchctl bootstrap', detail: firstLine(result) })
    }
    return ok({ location: this.plistPath, changed: true, hints: [] })
  }

  private async bootstrap(): Promise<CommandResult> {
    const sleep = this.host.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const run = () => this.host.runner.run('launchctl', ['bootstrap', this.domain, this.plistPath])
    let result = await run()
    for (let attempt = 1; attempt < BOOTSTRAP_ATTEMPTS && result.code !== 0 && isIoError(result); attempt++) {
      await sleep(BOOTSTRAP_RETRY_MS)
      result = await run()
    }
    return result
  }

  /** Puts the plist back as it was before this install (or removes the one it wrote). */
  private async restore(before: string | null): Promise<void> {
    if (before === null) await this.host.files.remove(this.plistPath)
    else await this.host.files.write(this.plistPath, before, 0o644)
  }

  async uninstall(): Promise<Result<ServiceRemoval, ServiceFailure>> {
    const { loaded } = await this.printed()
    if (loaded) {
      const result = await this.host.runner.run('launchctl', ['bootout', this.target])
      if (result.code !== 0) return err({ step: 'launchctl bootout', detail: firstLine(result) })
    }
    const existed = await this.host.files.remove(this.plistPath)
    return ok({ removed: loaded || existed, location: this.plistPath, hints: [] })
  }

  async status(): Promise<ServiceStatus> {
    const installed = (await this.host.files.read(this.plistPath)) !== null
    const { loaded, running } = await this.printed()
    // A plist in LaunchAgents is loaded at the next login even if it is not loaded now.
    return { installed, location: this.plistPath, running: loaded ? running : false }
  }
}
