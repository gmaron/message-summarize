import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../../interfaces/cli/run.js'
import { type CommandContext, loadConfigOrReport } from '../context.js'
import { runningDaemonPid } from '../installation/daemon-lock.js'
import { ensureDataDirs } from '../installation/paths.js'
import { errorCode } from '../logging/logger.js'
import { readWebAddress, type WebAddress } from '../web/address.js'
import { ensureWebToken } from '../web/token.js'

/**
 * The address to open, from where the web really listens: a wildcard address ("any interface") is reached through the
 * loopback of the same family, and an IPv6 address goes in brackets. The token goes in the fragment, which a browser
 * never sends to any server: the page reads it and trades it for a cookie (`POST /api/session`).
 */
export function webUrl(address: WebAddress, token: string): string {
  const host = address.host.replace(/^\[|\]$/g, '')
  const reachable = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host
  const name = reachable.includes(':') ? `[${reachable}]` : reachable
  return `http://${name}:${address.port}/#token=${token}`
}

/**
 * `msum open [--print]` (RF-82): prints the address of the local web, with the access token, and opens it in the
 * browser. `--print` (or `--no-browser`) only prints. The address is the one the running daemon recorded when its web
 * started, and only while that daemon holds the lock: the configuration is not trusted (the port may be held by
 * another program, which would receive the token), nor is a file a crashed daemon left behind.
 */
export async function openCommand(ctx: CommandContext, args: { readonly print: boolean }): Promise<number> {
  const { io, layout } = ctx
  const loaded = await loadConfigOrReport(ctx)
  if (loaded === null) return EXIT_USAGE
  const texts = loaded.catalog.cli.open
  if ((await runningDaemonPid(layout.lockFile)) === null) {
    io.err(texts.daemonNotRunning)
    return EXIT_FAILURE
  }
  const address = await readWebAddress(layout)
  if (address === null) {
    io.err(texts.webNotListening)
    return EXIT_FAILURE
  }
  await ensureDataDirs(layout)
  const url = webUrl(address, await ensureWebToken(layout))
  io.out(texts.url(url))
  if (args.print) return EXIT_OK
  try {
    await ctx.openUrl(url)
  } catch (error) {
    io.err(texts.openFailed(errorCode(error)))
    return EXIT_FAILURE
  }
  return EXIT_OK
}
