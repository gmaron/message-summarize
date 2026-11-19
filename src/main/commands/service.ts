import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServiceDefinition, ServiceHint, ServiceInstaller } from '../../application/ports/service-installer.js'
import type { Catalog } from '../../infrastructure/i18n/index.js'
import { createServiceInstaller, nodeFiles, nodeRunner } from '../../infrastructure/service/index.js'
import { EXIT_FAILURE, EXIT_OK, type ServiceCommand } from '../../interfaces/cli/run.js'
import { installationCatalog } from '../account-command.js'
import type { CommandContext } from '../context.js'
import { runningDaemonPid } from '../daemon-lock.js'
import { logsDirOf } from '../daemon-logs.js'
import { isVersionManaged, stableNodePath } from '../node-path.js'

/** The compiled CLI (`dist/main/cli.js`), found from this file (`dist/main/commands/service.js`). */
const CLI_ENTRY = fileURLToPath(new URL('../cli.js', import.meta.url))

/**
 * What the service runs: this node executable (absolute, so a different `node` on the PATH of the session cannot change
 * it), the CLI entry and `daemon`. The environment is an allowlist, never a copy of the current one (RNF-04):
 * MSUM_DATA_DIR always (the service manager does not see XDG_DATA_HOME or the home of a shell), and PATH, because the session of a service
 * manager has a minimal one and a CLI provider (`claude`, `ollama`) is looked up in it.
 */
export function serviceDefinition(ctx: CommandContext, entry: readonly string[], startNow: boolean): ServiceDefinition {
  const env: Record<string, string> = { MSUM_DATA_DIR: ctx.layout.dataDir }
  if (ctx.env.PATH !== undefined && ctx.env.PATH !== '') env.PATH = ctx.env.PATH
  return {
    command: [...entry, 'daemon'],
    env,
    dataDir: ctx.layout.dataDir,
    logsDir: logsDirOf(ctx.layout),
    startNow,
  }
}

function installerOf(ctx: CommandContext): ServiceInstaller | null {
  if (ctx.service?.installer !== undefined) return ctx.service.installer
  return createServiceInstaller({
    platform: process.platform,
    home: homedir(),
    dataDir: ctx.layout.dataDir,
    configHome:
      ctx.env.XDG_CONFIG_HOME !== undefined && ctx.env.XDG_CONFIG_HOME !== ''
        ? ctx.env.XDG_CONFIG_HOME
        : join(homedir(), '.config'),
    uid: process.getuid?.() ?? null,
    runner: nodeRunner,
    files: nodeFiles,
  })
}

function hintText(texts: Catalog['cli']['service'], hint: ServiceHint): string {
  switch (hint) {
    case 'enableLinger':
      return texts.hintEnableLinger
    case 'startAtNextLogin':
      return texts.hintStartAtNextLogin
    case 'stopRunningDaemon':
      return texts.hintStopRunningDaemon
  }
}

/**
 * `msum service install|uninstall|status` (RF-80, RNF-07): registers ONLY the daemon with the service manager of the
 * user's session (launchd, `systemd --user`, or the Run key on Windows) so it starts with the session and comes back
 * after a crash. Nothing here needs administrator rights, and nothing is written to the system's job scheduler: the
 * schedules live inside the daemon. Installing and uninstalling can be repeated. `status` reads only.
 */
export async function serviceCommand(ctx: CommandContext, command: ServiceCommand): Promise<number> {
  const { io } = ctx
  const texts = (await installationCatalog(ctx)).cli.service
  const installer = installerOf(ctx)
  if (installer === null) {
    io.err(texts.unsupported(process.platform))
    return EXIT_FAILURE
  }

  if (command.action === 'status') {
    const status = await installer.status()
    io.out(status.installed ? texts.statusInstalled(status.location, status.running) : texts.statusNotInstalled)
    io.out(texts.statusDaemon(await runningDaemonPid(ctx.layout.lockFile)))
    return EXIT_OK
  }

  if (command.action === 'uninstall') {
    const removal = await installer.uninstall()
    if (!removal.ok) {
      io.err(texts.failed(removal.error.step, removal.error.detail))
      return EXIT_FAILURE
    }
    io.out(removal.value.removed ? texts.removed(removal.value.location) : texts.notInstalled)
    for (const hint of removal.value.hints) io.out(hintText(texts, hint))
    return EXIT_OK
  }

  let entry = ctx.service?.entry ?? [process.execPath, CLI_ENTRY]
  let versionManaged = false
  // Only the real entry is checked: a test that gives its own has nothing on disk to look for.
  if (
    ctx.service?.entry === undefined &&
    !(await access(CLI_ENTRY).then(
      () => true,
      () => false,
    ))
  ) {
    io.err(texts.notBuilt(CLI_ENTRY))
    return EXIT_FAILURE
  }
  if (ctx.service?.entry === undefined) {
    // The Cellar path of a Homebrew node disappears with the next `brew upgrade`: the stable link is registered.
    const node = await stableNodePath(process.execPath, ctx.env.PATH)
    entry = [node.path, CLI_ENTRY]
    versionManaged = node.versionManaged
  } else versionManaged = isVersionManaged(entry[0] ?? '')
  // A daemon the service did not start (run by hand) holds the installation: starting another would only fail on the
  // lock and be restarted in a loop, so the service is registered and left for the next login.
  const lockPid = await runningDaemonPid(ctx.layout.lockFile)
  const manualPid = lockPid !== null && (await installer.status()).running !== true ? lockPid : null
  const installation = await installer.install(serviceDefinition(ctx, entry, manualPid === null))
  if (!installation.ok) {
    io.err(texts.failed(installation.error.step, installation.error.detail))
    return EXIT_FAILURE
  }
  io.out(
    installation.value.changed
      ? texts.installed(installation.value.location)
      : texts.alreadyInstalled(installation.value.location),
  )
  for (const hint of installation.value.hints) io.out(hintText(texts, hint))
  if (manualPid !== null) io.out(texts.hintManualDaemon(manualPid))
  if (versionManaged) io.out(texts.hintVersionManager)
  return EXIT_OK
}
