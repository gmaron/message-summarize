import { rm } from 'node:fs/promises'
import type { CaptureMessages } from '../../application/capture-messages.js'
import { reconcileAccount } from '../../infrastructure/whatsapp/account-binding.js'
import type { WhatsAppStatus } from '../../infrastructure/whatsapp/connection.js'
import type { AccountArg } from '../../interfaces/cli/args.js'
import { EXIT_FAILURE, EXIT_OK } from '../../interfaces/cli/run.js'
import { installationCatalog, isPrepared, prepareAccount } from '../account-command.js'
import { readAccountState } from '../account-state.js'
import { clearBlocked, FIXED_BY_LINKING, readBlocked } from '../blocked.js'
import { type CommandContext, hasSession, maskAccount, withRuntime } from '../context.js'
import { runningDaemonPid } from '../daemon-lock.js'
import { qrForTerminal, writeQrPng } from '../qr.js'
import { createRuntime } from '../runtime.js'

type LinkOutcome =
  | { readonly kind: 'connected' }
  | { readonly kind: 'loggedOut' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'interrupted' }

/** Exit code of a command stopped with Ctrl+C (128 + SIGINT). */
const EXIT_INTERRUPTED = 130

/** The capture use case, counting calls: `link` waits until the initial history stops arriving. */
function countingCapture(capture: CaptureMessages): { readonly capture: CaptureMessages; lastActivity(): number } {
  let last = Date.now()
  const touch = (): void => {
    last = Date.now()
  }
  const wrapped: CaptureMessages = {
    receiveMessage: (event) => {
      touch()
      return capture.receiveMessage(event)
    },
    editMessage: (event) => {
      touch()
      return capture.editMessage(event)
    },
    messagesRead: (event) => {
      touch()
      return capture.messagesRead(event)
    },
    unreadChanged: (event) => {
      touch()
      return capture.unreadChanged(event)
    },
    unreadSnapshot: (event) => {
      touch()
      return capture.unreadSnapshot(event)
    },
    conversationMetadata: (event) => {
      touch()
      return capture.conversationMetadata(event)
    },
    participantInfo: (event) => {
      touch()
      return capture.participantInfo(event)
    },
    transcriptReady: (event) => {
      touch()
      return capture.transcriptReady(event)
    },
  }
  return { capture: wrapped, lastActivity: () => last }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `msum link [--account <id>]`: connects, shows the QR (in the terminal, and as accounts/<id>/qr.png while it is valid), waits until the
 * account is connected and the initial history has been captured, then stops cleanly. A stale qr.png is deleted at
 * the start, and Ctrl+C / SIGTERM delete it and stop the connection.
 *
 * "The history has been received" cannot be observed directly, so it is approximated: after connecting, wait at least
 * `minAfterConnectMs`, then until nothing was captured for `quietMs`, and never more than `maxAfterConnectMs`.
 *
 * The account is created when it does not exist (`default` when there is none and no id was given). One that is
 * already linked is left alone (a notice and exit 0): `unlink` it first to link it again. A first link that fails,
 * times out or is interrupted before anything was bound removes the account it created.
 *
 * A session of a different account than the bound one (or with no phone number) is deleted on the spot, so nothing
 * of it stays or is captured into this installation, and the command fails.
 */
export async function linkCommand(ctx: CommandContext, args: AccountArg): Promise<number> {
  const { io, logger } = ctx
  // Before anything is created: a running daemon owns the session and the files.
  const daemonPid = await runningDaemonPid(ctx.layout.lockFile)
  if (daemonPid !== null) {
    io.err((await installationCatalog(ctx)).cli.daemonRunning(daemonPid))
    return EXIT_FAILURE
  }
  const prepared = await prepareAccount(ctx, args.account, 'link')
  if (!isPrepared(prepared)) return prepared.exit
  const { config, catalog, account, installation } = prepared
  const texts = catalog.cli
  let code = EXIT_FAILURE
  try {
    await rm(account.qrFile, { force: true })

    code = await withRuntime(
      () => createRuntime({ layout: account, config, env: ctx.env, clock: ctx.clock, summarizer: null }),
      async (runtime) => {
        const bound = runtime.identity.get()
        if (bound !== null && (await hasSession(account))) {
          // Idempotent for scripts: a notice and success, and the session is not touched.
          io.out(texts.link.alreadyLinked(account.id, maskAccount(bound)))
          return EXIT_OK
        }

        const counted = countingCapture(runtime.capture)
        const connection = await ctx.connectionFactory(runtime, {
          capture: counted.capture,
          onWarning: (code) => logger.warn('adapter.warning', { code }),
        })

        const timing = ctx.linkTiming
        let qrShown = false
        let interrupted = false
        let settle: (outcome: LinkOutcome) => void = () => {}
        const outcome = new Promise<LinkOutcome>((resolve) => {
          settle = resolve
        })
        void ctx.waitForShutdown().then(() => {
          interrupted = true
          settle({ kind: 'interrupted' })
        })
        const showQr = async (qr: string): Promise<void> => {
          try {
            io.out(await qrForTerminal(qr))
            await writeQrPng(account.qrFile, qr).then(
              () => {
                if (!qrShown) io.out(texts.link.scanQr(account.qrFile))
              },
              () => {
                if (!qrShown) io.out(texts.link.scanQr('-'))
              },
            )
            qrShown = true
          } catch {
            logger.warn('link.qrFailed', {})
          }
        }
        const unsubscribe = connection.onStatus((status: WhatsAppStatus) => {
          if (status.state === 'qr') void showQr(status.qr)
          else if (status.state === 'connected') settle({ kind: 'connected' })
          else if (status.state === 'loggedOut') settle({ kind: 'loggedOut' })
          else if (status.state === 'error') settle({ kind: 'failed', reason: status.reason })
        })

        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await connection.start()
          const result = await Promise.race([
            outcome,
            new Promise<LinkOutcome>((resolve) => {
              timer = setTimeout(() => resolve({ kind: 'timeout' }), timing.connectTimeoutMs)
            }),
          ])
          clearTimeout(timer)
          if (result.kind === 'interrupted') return EXIT_INTERRUPTED
          if (result.kind === 'timeout') {
            io.err(texts.link.timeout)
            return EXIT_FAILURE
          }
          if (result.kind === 'loggedOut') {
            io.err(texts.link.loggedOut(account.id))
            return EXIT_FAILURE
          }
          if (result.kind === 'failed') {
            io.err(texts.link.failed(result.reason))
            return EXIT_FAILURE
          }

          const check = reconcileAccount(runtime.identity, connection.selfChat()?.user)
          if (check === 'mismatch' || check === 'noAccount') {
            unsubscribe()
            await connection.clearSession()
            io.err(check === 'mismatch' ? texts.link.mismatch(account.id) : texts.link.failed('noAccount'))
            return EXIT_FAILURE
          }
          io.out(texts.link.connected)
          io.out(texts.link.receivingHistory)
          const connectedAt = Date.now()
          while (!interrupted) {
            await sleep(timing.pollMs)
            const now = Date.now()
            const elapsed = now - connectedAt
            if (elapsed >= timing.maxAfterConnectMs) break
            if (elapsed >= timing.minAfterConnectMs && now - counted.lastActivity() >= timing.quietMs) break
          }
          await connection.stop()
          if (interrupted) return EXIT_INTERRUPTED
          // Linking fixes what a daemon was blocked for, except a refused or replaced connection (`daemon --retry`).
          const marker = await readBlocked(account.blockedFile)
          if (marker !== null && FIXED_BY_LINKING.includes(marker.reason)) await clearBlocked(account.blockedFile)
          io.out(texts.link.done(maskAccount(runtime.identity.get() ?? '')))
          if (installation.schedules.list(account.id).length === 0) io.out(texts.link.scheduleHint)
          return EXIT_OK
        } finally {
          clearTimeout(timer)
          unsubscribe()
          await connection.stop().catch(() => undefined)
          // The QR is a pairing credential: never left behind.
          await rm(account.qrFile, { force: true })
        }
      },
    )
    return code
  } finally {
    // An account this run created and nothing got linked into (no bound number, no session) is not left behind:
    // a failed, timed-out or interrupted first link must not leave an empty record and directory.
    if (code !== EXIT_OK && prepared.created) {
      const state = await readAccountState(account).catch(() => null)
      if (state !== null && state.masked === null && !(await hasSession(account))) {
        await installation.deleteAccount(account.id).catch(() => undefined)
      }
    }
    installation.close()
  }
}
