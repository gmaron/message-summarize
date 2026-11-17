import type { DigestArgs } from '../../interfaces/cli/args.js'
import { zonedToEpoch } from '../../interfaces/cli/local-time.js'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../../interfaces/cli/run.js'
import { type CommandContext, loadConfigOrReport, withRuntime } from '../context.js'
import { ensureDataDirs } from '../paths.js'
import { runDigest } from '../run-digest.js'
import { createRuntime } from '../runtime.js'

/**
 * `msum digest`: generates a digest from the database, WITHOUT a WhatsApp connection (the daemon owns the session, and
 * two sockets with the same credentials kick each other out). A normal run commits the parts to the outbox and the
 * running daemon delivers them on its next sweep. `--dry-run` prints the digest and saves nothing (RF-64).
 */
export async function digestCommand(ctx: CommandContext, args: DigestArgs): Promise<number> {
  const loaded = await loadConfigOrReport(ctx)
  if (loaded === null) return EXIT_USAGE
  const { config, catalog } = loaded
  const { io } = ctx
  await ensureDataDirs(ctx.layout)

  const toEpoch = (local: DigestArgs['from']): number | undefined =>
    local === null ? undefined : zonedToEpoch(local, config.timezone)

  return withRuntime(
    () =>
      createRuntime({
        layout: ctx.layout,
        config,
        env: ctx.env,
        clock: ctx.clock,
        ...(ctx.summarizer === undefined ? {} : { summarizer: ctx.summarizer }),
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
}
