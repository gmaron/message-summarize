import { getCatalog } from '../infrastructure/i18n/index.js'
import { type CliHandlers, EXIT_FAILURE, runCli } from '../interfaces/cli/run.js'
import { daemonCommand } from './commands/daemon.js'
import { digestCommand } from './commands/digest.js'
import { doctorCommand } from './commands/doctor.js'
import { initCommand } from './commands/init.js'
import { linkCommand } from './commands/link.js'
import { statusCommand } from './commands/status.js'
import { unlinkCommand } from './commands/unlink.js'
import { languageHint } from './config.js'
import type { CommandContext } from './context.js'
import { errorCode } from './logger.js'

export function createHandlers(ctx: CommandContext): CliHandlers {
  return {
    init: () => initCommand(ctx),
    link: () => linkCommand(ctx),
    unlink: (args) => unlinkCommand(ctx, args),
    daemon: (args) => daemonCommand(ctx, args),
    digest: (args) => digestCommand(ctx, args),
    status: () => statusCommand(ctx),
    doctor: () => doctorCommand(ctx),
  }
}

/**
 * Runs the CLI with `argv` (without node and the script) and returns the exit code. An error nobody expected is
 * reported by its code only (never its message: it could quote chat text or a secret) and exits with 1.
 */
export async function runMain(argv: readonly string[], ctx: CommandContext): Promise<number> {
  const texts = getCatalog(await languageHint(ctx.layout.configFile)).cli
  try {
    return await runCli(argv, createHandlers(ctx), ctx.io, texts)
  } catch (error) {
    ctx.io.err(texts.unexpectedError(errorCode(error)))
    ctx.logger.error('cli.failed', { code: errorCode(error) })
    return EXIT_FAILURE
  }
}
