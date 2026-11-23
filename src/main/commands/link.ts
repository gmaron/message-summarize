import { rm } from 'node:fs/promises'
import { reconcileAccount } from '../../infrastructure/whatsapp/account-binding.js'
import type { WhatsAppStatus } from '../../infrastructure/whatsapp/connection.js'
import type { AccountArg } from '../../interfaces/cli/args.js'
import { EXIT_FAILURE, EXIT_OK } from '../../interfaces/cli/run.js'
import { isPrepared, prepareAccount } from '../account-command.js'
import { readAccountState } from '../account-state.js'
import { daemonUsing } from '../account-use.js'
import { clearBlocked, FIXED_BY_LINKING, readBlocked } from '../blocked.js'
import { type CommandContext, hasSession, maskAccount, withRuntime } from '../context.js'
import { countingCapture } from '../counting-capture.js'
import { acquireLinkLock, LINK_HEARTBEAT_MS } from '../link-lock.js'
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `msum link [--account <id>]`: connects, shows the QR (in the terminal, and as accounts/<id>/qr.png while it is valid), waits until the
 * account is connected and the initial history has been captured, then stops cleanly. A stale qr.png is deleted at
 * the start, and Ctrl+C / SIGTERM delete it and stop the connection.
 *
 * "The history has been received" is known when the connection reports that the history sync is complete (Baileys does
 * for the recent history). When it does not (or it never comes) it is approximated: after connecting, wait at least
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
  const prepared = await prepareAccount(ctx, args.account, 'link')
  if (!isPrepared(prepared)) return prepared.exit
  const { config, catalog, account, installation } = prepared
  const texts = catalog.cli
  let code = EXIT_FAILURE

  // An account the running daemon is using (linked, not blocked) owns its session: refused at once, before anything is
  // taken. The same check is made again under the lock, which is the one that counts.
  const using = await daemonUsing(ctx.layout, account)
  if (using !== null) {
    installation.close()
    io.err(texts.link.activeInDaemon(account.id, using))
    return EXIT_FAILURE
  }

  // The lock of the account comes first: while it is held the daemon does not START the account (a unit that runs is
  // never touched by a lock), so it cannot open a socket with credentials this command is still writing.
  const lock = await acquireLinkLock(account)
  if (!lock.ok) {
    installation.close()
    io.err(texts.link.beingLinked(account.id, lock.pid, account.linkLockFile))
    return EXIT_FAILURE
  }
  const heartbeat = setInterval(() => void lock.heartbeat(), LINK_HEARTBEAT_MS)
  heartbeat.unref()
  try {
    await ctx.afterLock?.()
    // The authoritative check: once the lock is held nothing can change between it and the work.
    const daemonPid = await daemonUsing(ctx.layout, account)
    if (daemonPid !== null) {
      io.err(texts.link.activeInDaemon(account.id, daemonPid))
      return EXIT_FAILURE
    }
    const marker = await readBlocked(account.blockedFile)
    // Blocked for a reason that retrying fixes: linking again is not the answer.
    if (marker !== null && !FIXED_BY_LINKING.includes(marker.reason) && (await hasSession(account))) {
      io.err(texts.link.needsRetry(account.id))
      return EXIT_FAILURE
    }
    // Blocked for a reason that linking fixes: the session is no good, and linking replaces it.
    const relinking = marker !== null && FIXED_BY_LINKING.includes(marker.reason)
    await rm(account.qrFile, { force: true })

    code = await withRuntime(
      () => createRuntime({ layout: account, config, env: ctx.env, clock: ctx.clock, summarizer: null }),
      async (runtime) => {
        const bound = runtime.identity.get()
        if (!relinking && bound !== null && (await hasSession(account))) {
          // Idempotent for scripts: a notice and success, and the session is not touched.
          io.out(texts.link.alreadyLinked(account.id, maskAccount(bound)))
          return EXIT_OK
        }

        const counted = countingCapture(runtime.capture)
        const connection = await ctx.connectionFactory(runtime, {
          capture: counted.capture,
          // Link only captures: the audios stay queued for the daemon's worker (one whisper per installation, RNF-09).
          downloadAudios: false,
          onWarning: (code, detail) => logger.warn('adapter.warning', { code, ...detail }),
          onHistoryProgress: (report) => logger.info('history.progress', { ...report }),
          onUndecryptable: (count) => logger.warn('capture.undecryptable', { count }),
        })
        if (relinking) await connection.clearSession()

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

        let historyComplete = false
        const unsubscribeHistory = connection.onHistorySync?.((history) => {
          if (history.complete) historyComplete = true
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
            // A complete history skips the minimum wait, not the quiet period: Baileys' buffer flush and the trailing
            // name chunks come after the report, and a chunk that was acknowledged is never sent again.
            const quiet = now - counted.lastActivity() >= timing.quietMs
            if (quiet && (historyComplete || elapsed >= timing.minAfterConnectMs)) break
          }
          // The audios of the history are in the durable download queue: stopping aborts the download in progress, and the
          // daemon downloads the rest when it connects. There is nothing to wait for here.
          await connection.stop()
          if (interrupted) return EXIT_INTERRUPTED
          // The account is freshly linked: whatever it was blocked for before (a dead session, or a connection that was
          // refused or replaced) no longer applies, and the daemon, which waits for this lock, starts it.
          await clearBlocked(account.blockedFile)
          io.out(texts.link.done(maskAccount(runtime.identity.get() ?? '')))
          if (installation.schedules.list(account.id).length === 0) io.out(texts.link.scheduleHint)
          return EXIT_OK
        } finally {
          clearTimeout(timer)
          unsubscribe()
          unsubscribeHistory?.()
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
    clearInterval(heartbeat)
    // Last: only now may the daemon take the account (the block was cleared on success, or the account is gone).
    await lock.release()
  }
}
