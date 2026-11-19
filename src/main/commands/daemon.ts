import { rm } from 'node:fs/promises'
import { getCatalog } from '../../infrastructure/i18n/index.js'
import type { AccountArg } from '../../interfaces/cli/args.js'
import { EXIT_FAILURE, EXIT_USAGE } from '../../interfaces/cli/run.js'
import { installationCatalog } from '../account-command.js'
import { type Installation, openInstallation } from '../accounts.js'
import { DEFAULT_LOGS, describeConfigIssue, languageHint, loadEffectiveConfig, readConfigObject } from '../config.js'
import type { CommandContext } from '../context.js'
import { DaemonHost, hasNoProvider } from '../daemon-host.js'
import { acquireDaemonLock, HEARTBEAT_MS } from '../daemon-lock.js'
import { type DaemonLogs, startDaemonLogs } from '../daemon-logs.js'
import { removeStaleImportDirs } from '../import-workdirs.js'
import { linkLockHolder } from '../link-lock.js'
import { accountLayoutOf, ensureDataDirs } from '../paths.js'
import { retryBlock } from '../retry.js'
import { importConfigSchedules } from '../schedules.js'
import { startWeb, type WebHandle } from '../web.js'
import { removeWebAddress } from '../web-address.js'
import { chooseWebHost } from '../web-host.js'

/**
 * `msum daemon [--retry] [--account <id>]`: ONE process for the whole installation (RF-03). It holds the lock file
 * (host, pid, and a heartbeat on its mtime every 30 s) and runs EVERY registered account, each in its own isolated unit
 * (see `DaemonHost`): its own connection, schedules, missed-run catch-up and delivery, so an account that is blocked
 * or fails does not stop the others. It keeps looking at the installation while it runs: an account linked later (even
 * with `msum link` while the daemon runs) is picked up, one that was removed is dropped, one whose block was cleared
 * (`msum retry`) connects again.
 *
 * `--account <id>` runs only that account (for debugging). `--retry` clears, before starting, the blocks of the accounts
 * it runs that retrying fixes (exactly what `msum retry` clears; a dead session stays blocked and gets no socket). An
 * account with nothing linked is left idle: no connection is opened for it.
 *
 * When `web.enabled` (the default) it also serves the local web (see `startWeb`): on 127.0.0.1 with an access token
 * unless the configuration says otherwise. A web that cannot start (the port is taken) is reported and does not stop
 * the accounts.
 *
 * It stops cleanly on SIGINT and SIGTERM (every connection stopped in parallel, databases closed). It never writes to
 * the operating system's crontab or scheduler: the schedules live inside the process. A stale qr.png of an account is
 * deleted at the start, unless a `link` is working on it.
 *
 * An account whose configuration is invalid, or that has schedules and no provider to run them, is reported and left
 * idle while the others run (also when it appears later). The daemon refuses to start (exit 2) only when `--account`
 * names such an account, or when every account is like that.
 */
export async function daemonCommand(
  baseCtx: CommandContext,
  args: { readonly retry: boolean } & AccountArg,
): Promise<number> {
  const { io, layout } = baseCtx
  // From the lock on, what the daemon logs also goes to the log file and the web (see `startDaemonLogs`).
  let ctx = baseCtx
  await ensureDataDirs(layout)
  const lock = await acquireDaemonLock(layout.lockFile)
  if (!lock.ok) {
    io.err((await installationCatalog(baseCtx)).cli.daemonRunning(lock.pid))
    return EXIT_FAILURE
  }
  // Whatever address a daemon that died left behind is not ours to trust: this one has the lock now.
  await removeWebAddress(layout).catch(() => undefined)
  const { heartbeatMs, ...timing } = ctx.daemonTiming ?? {}
  const heartbeat = setInterval(() => void lock.heartbeat(), heartbeatMs ?? HEARTBEAT_MS)
  heartbeat.unref()
  let installation: Installation | null = null
  let web: WebHandle | null = null
  let logs: DaemonLogs | null = null
  try {
    // Keeping a log is never a reason not to run: whatever goes wrong there leaves the daemon without a file.
    try {
      const rootForLogs = await loadEffectiveConfig(layout.configFile, null)
      logs = await startDaemonLogs(
        baseCtx.logger,
        layout,
        rootForLogs.ok ? rootForLogs.value.logs.maxBytes : DEFAULT_LOGS.maxBytes,
      )
      ctx = { ...baseCtx, logger: logs.logger }
    } catch {
      baseCtx.logger.warn('logs.fileDisabled', { reason: 'failed' })
    }
    const rootCatalog = await installationCatalog(ctx)
    // The lock is held: the migration of the old layout may run, and nothing else can start on this installation.
    const opened = await openInstallation({ layout, clock: ctx.clock, lockHeld: true })
    if (!opened.ok) {
      io.err(rootCatalog.cli.legacyDaemonRunning(opened.pid))
      return EXIT_FAILURE
    }
    installation = opened.installation
    // A copy of a session left by an import that died is not kept around (the work directories of live imports are).
    await removeStaleImportDirs(layout, ctx.logger)
    const known = installation.accounts().map((row) => row.id)
    if (args.account !== null && !known.includes(args.account)) {
      io.err(rootCatalog.cli.accounts.unknown(args.account, known.join(', ')))
      return EXIT_USAGE
    }
    const targets = args.account === null ? known : [args.account]

    // What can be wrong is found before anything connects. An account with a problem (an invalid configuration, or
    // schedules and no provider to run them) is left idle by the daemon, which reports it, and the others run. It is
    // a reason not to start only when the account was named with `--account`, or when no account at all could run.
    const broken = new Map<string, () => void>()
    for (const id of targets) {
      const account = accountLayoutOf(layout, id)
      const loaded = await loadEffectiveConfig(layout.configFile, account.configFile)
      if (!loaded.ok) {
        const catalog = getCatalog(await languageHint(layout.configFile, account.configFile))
        broken.set(id, () => {
          io.err(catalog.cli.config.heading)
          for (const issue of loaded.error) io.err(`  - ${describeConfigIssue(catalog, issue)}`)
        })
        continue
      }
      importConfigSchedules(installation, id, loaded.value)
      const texts = getCatalog(loaded.value.language).cli
      if (installation.schedules.list(id).length === 0) io.err(texts.daemon.noSchedules(id))
      else if (hasNoProvider(ctx, loaded.value)) broken.set(id, () => io.err(texts.config.noProvider))
    }
    const mustStop =
      (args.account !== null && broken.has(args.account)) || (targets.length > 0 && broken.size === targets.length)
    if (mustStop) {
      for (const report of broken.values()) report()
      return EXIT_USAGE
    }

    for (const id of targets) {
      const account = accountLayoutOf(layout, id)
      if (args.retry && !broken.has(id)) {
        // The same as `msum retry`: only what retrying fixes. A dead session stays blocked and gets no socket.
        const outcome = await retryBlock(account)
        if (outcome.result === 'needsRelink') io.err(rootCatalog.cli.retry.needsRelink(id))
      }
      // A link in progress owns its QR: only a stale one is removed.
      if ((await linkLockHolder(account)) === null) await rm(account.qrFile, { force: true })
    }

    const host = new DaemonHost({
      ctx,
      installation,
      onlyAccount: args.account,
      language: await languageHint(layout.configFile),
      timing,
    })
    // The web goes down before the host: its streams are closed first, so the shutdown stays inside its budget.
    let stopRequested = false
    void ctx.waitForShutdown().then(async () => {
      stopRequested = true
      await web?.stop()
      await host.stop()
    })
    try {
      await host.start()
    } catch (error) {
      await host.stop()
      throw error
    }
    // The web needs the installation's own configuration; when it is invalid the accounts were already reported.
    const root = await loadEffectiveConfig(layout.configFile, null)
    if (!root.ok) ctx.logger.warn('web.skipped', { reason: 'config' })
    else if (root.value.web.enabled && !stopRequested) {
      // MSUM_WEB_HOST (the Docker image) applies only when config.json does not set web.host.
      const raw = await readConfigObject(layout.configFile)
      const chosen = chooseWebHost(root.value.web, raw.ok ? raw.value : {}, ctx.env)
      if (chosen.invalidEnv) ctx.logger.warn('web.host_env_ignored', { reason: 'invalid' })
      web = await startWeb({
        ctx,
        installation,
        host,
        web: chosen.web,
        language: root.value.language,
        ...(logs === null ? {} : { logs: logs.store }),
      })
      if (stopRequested) await web?.stop()
    }
    io.out(rootCatalog.cli.daemon.running(layout.dataDir))
    if (targets.length === 0) io.err(rootCatalog.cli.daemon.noAccounts)
    const code = await host.finished
    io.out(rootCatalog.cli.daemon.stopped)
    return code
  } finally {
    clearInterval(heartbeat)
    await web?.stop()
    await removeWebAddress(layout).catch(() => undefined)
    installation?.close()
    await logs?.close()
    await lock.release()
  }
}
