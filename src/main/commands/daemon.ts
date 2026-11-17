import { rm } from 'node:fs/promises'
import { getCatalog } from '../../infrastructure/i18n/index.js'
import type { AccountArg } from '../../interfaces/cli/args.js'
import { EXIT_FAILURE, EXIT_USAGE } from '../../interfaces/cli/run.js'
import { installationCatalog } from '../account-command.js'
import { type Installation, openInstallation } from '../accounts.js'
import { describeConfigIssue, languageHint, loadEffectiveConfig } from '../config.js'
import type { CommandContext } from '../context.js'
import { DaemonHost, hasNoProvider } from '../daemon-host.js'
import { acquireDaemonLock, HEARTBEAT_MS } from '../daemon-lock.js'
import { linkLockHolder } from '../link-lock.js'
import { accountLayoutOf, ensureDataDirs } from '../paths.js'
import { retryBlock } from '../retry.js'
import { importConfigSchedules } from '../schedules.js'

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
 * It stops cleanly on SIGINT and SIGTERM (every connection stopped in parallel, databases closed). It never writes to
 * the operating system's crontab or scheduler: the schedules live inside the process. A stale qr.png of an account is
 * deleted at the start, unless a `link` is working on it.
 *
 * An account whose configuration is invalid, or that has schedules and no provider to run them, is reported and left
 * idle while the others run (also when it appears later). The daemon refuses to start (exit 2) only when `--account`
 * names such an account, or when every account is like that.
 */
export async function daemonCommand(
  ctx: CommandContext,
  args: { readonly retry: boolean } & AccountArg,
): Promise<number> {
  const { io, layout } = ctx
  await ensureDataDirs(layout)
  const lock = await acquireDaemonLock(layout.lockFile)
  if (!lock.ok) {
    io.err((await installationCatalog(ctx)).cli.daemonRunning(lock.pid))
    return EXIT_FAILURE
  }
  const { heartbeatMs, ...timing } = ctx.daemonTiming ?? {}
  const heartbeat = setInterval(() => void lock.heartbeat(), heartbeatMs ?? HEARTBEAT_MS)
  heartbeat.unref()
  let installation: Installation | null = null
  try {
    const rootCatalog = await installationCatalog(ctx)
    // The lock is held: the migration of the old layout may run, and nothing else can start on this installation.
    const opened = await openInstallation({ layout, clock: ctx.clock, lockHeld: true })
    if (!opened.ok) {
      io.err(rootCatalog.cli.legacyDaemonRunning(opened.pid))
      return EXIT_FAILURE
    }
    installation = opened.installation
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
    void ctx.waitForShutdown().then(() => host.stop())
    try {
      await host.start()
    } catch (error) {
      await host.stop()
      throw error
    }
    io.out(rootCatalog.cli.daemon.running(layout.dataDir))
    if (targets.length === 0) io.err(rootCatalog.cli.daemon.noAccounts)
    const code = await host.finished
    io.out(rootCatalog.cli.daemon.stopped)
    return code
  } finally {
    clearInterval(heartbeat)
    installation?.close()
    await lock.release()
  }
}
