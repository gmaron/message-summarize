#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { runMain } from './app.js'
import { DEFAULT_LINK_TIMING } from './context.js'
import { createTappableLogger } from './logger.js'
import { openInBrowser } from './open-url.js'
import { layoutOf, resolveDataDir } from './paths.js'
import { realProbes } from './probes.js'
import { createShutdown, installProcessGuards } from './process-guard.js'
import { systemClock } from './runtime.js'
import { versionCommand } from './version.js'
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

/**
 * Reads a secret from the input (RNF-04). On a terminal the prompt goes to stderr and what is typed is not echoed (the
 * readline output is a sink that discards everything). Piped, the whole of stdin is read. Never from the arguments.
 */
async function readSecret(prompt: string): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write(prompt)
    const muted = new Writable({
      write(_chunk, _encoding, done) {
        done()
      },
    })
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true })
    try {
      return await rl.question('')
    } finally {
      rl.close()
      process.stderr.write('\n')
    }
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

// One logger for the whole process: the guards, the commands and the crash handler below. The daemon attaches its log
// file to it (see `startDaemonLogs`), so a fatal error reaches the file and the web too.
const logger = createTappableLogger(process.stdout, process.stderr)

/** The composition root: the real process, file system and WhatsApp wired into the commands. */
async function main(): Promise<void> {
  const versionCode = versionCommand(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  })
  if (versionCode !== null) {
    process.exitCode = versionCode
    return
  }
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
    readSecret,
    waitForShutdown: () => shutdown.wait(),
    probes: realProbes,
    openUrl: openInBrowser,
    nodeVersion: process.versions.node,
    linkTiming: DEFAULT_LINK_TIMING,
  })
  process.exitCode = process.exitCode === 1 ? 1 : code
  // A safety net: if something keeps the process alive after the command finished, leave anyway.
  setTimeout(() => process.exit(process.exitCode as number), 3_000).unref()
}

main().catch(() => {
  try {
    logger.error('cli.crashed')
  } catch {
    process.stderr.write('{"level":"error","event":"cli.crashed"}\n')
  }
  process.exit(1)
})
