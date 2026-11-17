#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { runMain } from './app.js'
import { DEFAULT_LINK_TIMING } from './context.js'
import { createLogger } from './logger.js'
import { layoutOf, resolveDataDir } from './paths.js'
import { realProbes } from './probes.js'
import { createShutdown, installProcessGuards } from './process-guard.js'
import { systemClock } from './runtime.js'
import { createWhatsAppConnectionFor } from './whatsapp.js'

/** Asks a yes/no question on the terminal. Without a terminal (a pipe, a service) the answer is no. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(question)).trim().toLowerCase()
    return ['y', 'yes', 's', 'si', 'sí'].includes(answer)
  } finally {
    rl.close()
  }
}

/** The composition root: the real process, file system and WhatsApp wired into the commands. */
async function main(): Promise<void> {
  const logger = createLogger(process.stdout, process.stderr)
  const shutdown = createShutdown()
  installProcessGuards({ proc: process as never, logger, shutdown })
  const code = await runMain(process.argv.slice(2), {
    env: process.env,
    layout: layoutOf(resolveDataDir({ env: process.env })),
    io: {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
    logger,
    clock: systemClock,
    connectionFactory: createWhatsAppConnectionFor,
    confirm,
    waitForShutdown: () => shutdown.wait(),
    probes: realProbes,
    nodeVersion: process.versions.node,
    linkTiming: DEFAULT_LINK_TIMING,
  })
  process.exitCode = process.exitCode === 1 ? 1 : code
  // A safety net: if something keeps the process alive after the command finished, leave anyway.
  setTimeout(() => process.exit(process.exitCode as number), 3_000).unref()
}

main().catch(() => {
  process.stderr.write('{"level":"error","event":"cli.crashed"}\n')
  process.exit(1)
})
