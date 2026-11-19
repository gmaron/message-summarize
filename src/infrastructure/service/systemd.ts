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
import { assertSingleLine, firstLine, type ServiceHost } from './host.js'

export const SYSTEMD_UNIT = 'message-summarize.service'
const RESTART_SECONDS = 5

/**
 * One word of a unit line, in double quotes so a path with spaces stays one word. systemd expands `%` specifiers in
 * every value (`%%` is a literal percent) and `$` variables in `ExecStart` only (`$$`).
 */
export function systemdWord(text: string, expandsVariables: boolean): string {
  assertSingleLine(text)
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  return `"${expandsVariables ? escaped.replace(/\$/g, '$$$$') : escaped}"`
}

/**
 * The unit of the user manager. `Restart=always` brings the daemon back five seconds after it ends for any reason,
 * except a stop asked for with `systemctl --user stop` (systemd never restarts those). Ending on SIGINT or SIGTERM
 * (exit codes 130 and 143) counts as a success, so a stop does not leave the unit "failed". The daemon's output goes
 * to the journal.
 */
export function systemdUnit(definition: ServiceDefinition): string {
  const lines = [
    '[Unit]',
    'Description=message-summarize daemon',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${definition.command.map((word) => systemdWord(word, true)).join(' ')}`,
  ]
  for (const [name, value] of Object.entries(definition.env)) {
    lines.push(`Environment=${systemdWord(`${name}=${value}`, false)}`)
  }
  lines.push(
    'Restart=always',
    `RestartSec=${RESTART_SECONDS}`,
    'SuccessExitStatus=130 143',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  )
  return lines.join('\n')
}

/** Linux: a `systemd --user` unit in `~/.config/systemd/user`, enabled and started now. */
export class SystemdInstaller implements ServiceInstaller {
  private readonly unitPath: string

  constructor(private readonly host: ServiceHost) {
    this.unitPath = join(host.configHome, 'systemd', 'user', SYSTEMD_UNIT)
  }

  private systemctl(...args: string[]) {
    return this.host.runner.run('systemctl', ['--user', ...args])
  }

  async install(definition: ServiceDefinition): Promise<Result<ServiceInstallation, ServiceFailure>> {
    const unit = systemdUnit(definition)
    const before = await this.host.files.read(this.unitPath)
    const changed = before !== unit
    // Not started now next to a daemon the service did not start; one the service already runs keeps running.
    const running = definition.startNow || (await this.systemctl('is-active', SYSTEMD_UNIT)).stdout.trim() === 'active'
    const enableArgs = running ? ['enable', '--now'] : ['enable']
    if (changed) await this.host.files.write(this.unitPath, unit, 0o644)
    const reload = await this.systemctl('daemon-reload')
    if (reload.code !== 0) {
      await this.rollback(before, changed)
      return err({ step: 'systemctl daemon-reload', detail: firstLine(reload) })
    }
    const enable = await this.systemctl(...enableArgs, SYSTEMD_UNIT)
    if (enable.code !== 0) {
      await this.rollback(before, changed)
      return err({ step: `systemctl ${enableArgs.join(' ')}`, detail: firstLine(enable) })
    }
    // `enable --now` leaves a daemon that already runs alone: a changed unit takes effect with a restart.
    if (changed && before !== null && running) {
      const restart = await this.systemctl('restart', SYSTEMD_UNIT)
      if (restart.code !== 0) return err({ step: 'systemctl restart', detail: firstLine(restart) })
    }
    // Without lingering the user manager (and the daemon) stops at the last logout: a hint, never done here.
    return ok({ location: this.unitPath, changed, hints: ['enableLinger'] })
  }

  /** Puts the unit back as it was (or removes the one this install wrote) so a failed install changed nothing. */
  private async rollback(before: string | null, changed: boolean): Promise<void> {
    if (!changed) return
    if (before === null) await this.host.files.remove(this.unitPath)
    else await this.host.files.write(this.unitPath, before, 0o644)
    await this.systemctl('daemon-reload')
  }

  async uninstall(): Promise<Result<ServiceRemoval, ServiceFailure>> {
    const before = await this.host.files.read(this.unitPath)
    if (before === null) return ok({ removed: false, location: this.unitPath, hints: [] })
    // Not enabled or not running is fine: the unit goes away either way.
    await this.systemctl('disable', '--now', SYSTEMD_UNIT)
    await this.host.files.remove(this.unitPath)
    const reload = await this.systemctl('daemon-reload')
    if (reload.code !== 0) return err({ step: 'systemctl daemon-reload', detail: firstLine(reload) })
    return ok({ removed: true, location: this.unitPath, hints: [] })
  }

  async status(): Promise<ServiceStatus> {
    const installed = (await this.host.files.read(this.unitPath)) !== null
    if (!installed) return { installed, location: this.unitPath, running: false }
    const active = await this.systemctl('is-active', SYSTEMD_UNIT)
    return { installed, location: this.unitPath, running: active.stdout.trim() === 'active' }
  }
}
