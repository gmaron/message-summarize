import type { ServiceInstaller } from '../../application/ports/service-installer.js'
import type { ServiceHost } from './host.js'
import { LaunchdInstaller } from './launchd.js'
import { SystemdInstaller } from './systemd.js'
import { WindowsRunKeyInstaller } from './windows-run-key.js'

export {
  type CommandResult,
  type CommandRunner,
  nodeFiles,
  nodeRunner,
  type ServiceFiles,
  type ServiceHost,
} from './host.js'
export { LAUNCHD_LABEL, LaunchdInstaller, launchdPlist } from './launchd.js'
export { SYSTEMD_UNIT, SystemdInstaller, systemdUnit } from './systemd.js'
export {
  LAUNCHER_NAME,
  launcherScript,
  RUN_KEY,
  RUN_VALUE,
  runCommandLine,
  WindowsRunKeyInstaller,
} from './windows-run-key.js'

/** The installer of the operating system in `host.platform`, or null when there is none. */
export function createServiceInstaller(host: ServiceHost): ServiceInstaller | null {
  switch (host.platform) {
    case 'darwin':
      return new LaunchdInstaller(host)
    case 'linux':
      return new SystemdInstaller(host)
    case 'win32':
      return new WindowsRunKeyInstaller(host)
    default:
      return null
  }
}
