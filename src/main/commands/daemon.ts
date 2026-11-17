import { rm } from 'node:fs/promises'
import type { AccountArg } from '../../interfaces/cli/args.js'
import { EXIT_FAILURE, EXIT_USAGE } from '../../interfaces/cli/run.js'
import { installationCatalog, isPrepared, prepareAccount } from '../account-command.js'
import { clearBlocked, readBlocked, writeBlocked } from '../blocked.js'
import { type CommandContext, hasSession, withRuntime } from '../context.js'
import { Daemon } from '../daemon.js'
import { acquireDaemonLock, HEARTBEAT_MS } from '../daemon-lock.js'
import { ensureDataDirs } from '../paths.js'
import { createRuntime } from '../runtime.js'

/**
 * `msum daemon [--account <id>]`: connects to WhatsApp and keeps running (RF-03). One daemon per installation: it holds a lock file
 * (host, pid, and a heartbeat on its mtime every 30 s). It stops cleanly on SIGINT and SIGTERM (connection stopped,
 * database closed). It never writes to the operating system's crontab or scheduler: the schedules live inside the
 * process.
 *
 * It runs ONE account (the one of `--account`, or the only one; with several and no flag it refuses and lists them).
 * When the account cannot be used (see `Daemon`) it stays idle, without connecting, until it is stopped. `--retry`
 * clears the marker of a refused or replaced connection first. A stale qr.png is deleted at the start.
 */
export async function daemonCommand(
  ctx: CommandContext,
  args: { readonly retry: boolean } & AccountArg,
): Promise<number> {
  const { io, layout, logger } = ctx
  await ensureDataDirs(layout)
  const lock = await acquireDaemonLock(layout.lockFile)
  if (!lock.ok) {
    io.err((await installationCatalog(ctx)).cli.daemonRunning(lock.pid))
    return EXIT_FAILURE
  }
  // The lock is held: the migration of the old layout may run, and nothing else can start on this installation.
  const prepared = await prepareAccount(ctx, args.account, 'daemon', { lockHeld: true }).catch(async (error) => {
    await lock.release()
    throw error
  })
  if (!isPrepared(prepared)) {
    await lock.release()
    return prepared.exit
  }
  const { config, catalog, installation, account } = prepared
  const texts = catalog.cli
  await rm(account.qrFile, { force: true })

  const { heartbeatMs, ...timing } = ctx.daemonTiming ?? {}
  const heartbeat = setInterval(() => void lock.heartbeat(), heartbeatMs ?? HEARTBEAT_MS)
  heartbeat.unref()
  try {
    return await withRuntime(
      () =>
        createRuntime({
          layout: account,
          config,
          env: ctx.env,
          clock: ctx.clock,
          ...(ctx.summarizer === undefined ? {} : { summarizer: ctx.summarizer }),
        }),
      async (runtime) => {
        if (args.retry) await clearBlocked(account.blockedFile)
        if (config.schedules.length === 0) io.err(texts.daemon.noSchedules)
        else if (runtime.generateDigest === null) {
          io.err(texts.config.noProvider)
          return EXIT_USAGE
        }
        if (runtime.identity.get() === null && !(await hasSession(account))) {
          // Not linked: idle until `msum link` clears this, instead of exiting into a supervisor's restart loop.
          if ((await readBlocked(account.blockedFile)) === null) {
            await writeBlocked(account.blockedFile, 'notLinked', ctx.clock.now())
          }
        }

        const connection = await ctx.connectionFactory(runtime, {
          onWarning: (code) => logger.warn('adapter.warning', { code }),
        })
        const daemon = new Daemon({
          runtime,
          connection,
          logger,
          ...timing,
          onBlocked: (reason) => io.err(texts.daemon.blocked(texts.blockedReasons[reason](account.id))),
        })
        void ctx.waitForShutdown().then(() => daemon.stop())
        try {
          await daemon.start()
          if (daemon.blocked === null) io.out(texts.daemon.running(layout.dataDir))
        } catch (error) {
          await daemon.stop()
          throw error
        }
        const code = await daemon.finished
        io.out(texts.daemon.stopped)
        return code
      },
    )
  } finally {
    clearInterval(heartbeat)
    installation.close()
    await lock.release()
  }
}
