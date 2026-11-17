import type { DigestArgs } from '../../interfaces/cli/args.js'
import { zonedToEpoch } from '../../interfaces/cli/local-time.js'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../../interfaces/cli/run.js'
import { isPrepared, prepareAccount } from '../account-command.js'
import { type CommandContext, withRuntime } from '../context.js'
import { runningDaemonPid } from '../daemon-lock.js'
import { runDigest } from '../run-digest.js'
import { createRuntime } from '../runtime.js'

/**
 * `msum digest [--account <id>]`: generates a digest from the database, WITHOUT a WhatsApp connection (the daemon owns the session, and
 * two sockets with the same credentials kick each other out). A normal run commits the parts to the outbox and the
 * running daemon delivers them on its next sweep. `--dry-run` prints the digest and saves nothing (RF-64).
 */
export async function digestCommand(ctx: CommandContext, args: DigestArgs): Promise<number> {
  const prepared = await prepareAccount(ctx, args.account, 'existing')
  if (!isPrepared(prepared)) return prepared.exit
  const { config, catalog, installation, account } = prepared
  const { io } = ctx

  const toEpoch = (local: DigestArgs['from']): number | undefined =>
    local === null ? undefined : zonedToEpoch(local, config.timezone)

  try {
    // With a daemon running, it owns the transcription (one whisper at a time, and never two processes on one account):
    // this command only waits, for a bounded time, for the daemon to finish the audios of its window. Without a daemon it
    // transcribes by itself. This applies to `--dry-run` too: a transcript is captured data, not a result of the digest,
    // so a preview may store it and RF-64 still holds (no pointer move, nothing in the history or the outbox).
    const transcriptionMode = (await runningDaemonPid(ctx.layout.lockFile)) === null ? 'own' : 'observe'
    return await withRuntime(
      () =>
        createRuntime({
          layout: account,
          config,
          env: ctx.env,
          clock: ctx.clock,
          transcriptionMode,
          // Checked again before each audio: a daemon that starts meanwhile takes over the transcription.
          daemonRunning: async () => (await runningDaemonPid(ctx.layout.lockFile)) !== null,
          ...(ctx.transcriptionTiming?.waitMs === undefined
            ? {}
            : { transcriptionWaitMs: ctx.transcriptionTiming.waitMs }),
          ...(ctx.transcriptionTiming?.pollMs === undefined
            ? {}
            : { transcriptionPollMs: ctx.transcriptionTiming.pollMs }),
          ...(ctx.summarizer === undefined ? {} : { summarizer: ctx.summarizer }),
          ...(ctx.transcriber === undefined ? {} : { transcriber: ctx.transcriber }),
        }),
      async (runtime) => {
        const result = await runDigest(runtime, {
          preview: args.dryRun,
          from: toEpoch(args.from),
          until: toEpoch(args.to),
          hours: args.hours ?? undefined,
        })
        if (!result.ok) {
          const { error } = result
          switch (error.kind) {
            case 'noProvider':
              io.err(catalog.cli.config.noProvider)
              return EXIT_USAGE
            case 'promptFile':
              io.err(catalog.cli.config.promptFile(error.path))
              return EXIT_USAGE
            case 'concurrentRun':
              io.err(catalog.cli.digest.concurrentRun)
              return EXIT_FAILURE
            case 'invalidWindow':
              for (const code of error.errors) {
                io.err(`${catalog.errors.window[code]} ${catalog.cli.digest.flagHint[code]}`)
              }
              return EXIT_USAGE
          }
        }
        const report = result.value
        if (report.digest === null) {
          io.out(catalog.cli.digest.empty)
          return EXIT_OK
        }
        if (args.dryRun) {
          io.out(report.parts.join('\n\n'))
          io.err(catalog.cli.digest.dryRun)
        } else {
          io.out(catalog.cli.digest.committed(report.summarized, report.failed.length, report.parts.length))
        }
        return EXIT_OK
      },
    )
  } finally {
    installation.close()
  }
}
