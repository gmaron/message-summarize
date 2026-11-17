import { existsSync } from 'node:fs'
import { CronerScheduler } from '../../infrastructure/scheduling/croner-scheduler.js'
import { EXIT_OK, EXIT_USAGE } from '../../interfaces/cli/run.js'
import { readBlocked } from '../blocked.js'
import { type CommandContext, formatInstant, loadConfigOrReport, maskAccount } from '../context.js'
import { runningDaemonPid } from '../daemon-lock.js'
import { createRuntime } from '../runtime.js'

/**
 * `msum status`: where the data is, the linked account (masked), when the last digest ended, how many parts wait to
 * be delivered, whether a daemon runs and the next run of each schedule. Never prints message content. It does not
 * create anything: with no database yet it reports an empty installation.
 */
export async function statusCommand(ctx: CommandContext): Promise<number> {
  const loaded = await loadConfigOrReport(ctx)
  if (loaded === null) return EXIT_USAGE
  const { config, catalog } = loaded
  const texts = catalog.cli.status
  const { io, layout } = ctx
  const now = ctx.clock.now()

  let account: string | null = null
  let pointer: number | null = null
  let pending = 0
  if (existsSync(layout.dbFile)) {
    const runtime = createRuntime({ layout, config, env: ctx.env, clock: ctx.clock, summarizer: null })
    try {
      const bound = runtime.identity.get()
      account = bound === null ? null : maskAccount(bound)
      pointer = await runtime.store.getPointer()
      pending = runtime.store.pendingOutbox().length
    } finally {
      runtime.close()
    }
  }

  io.out(texts.dataDir(layout.dataDir))
  io.out(texts.account(account))
  io.out(texts.lastDigest(pointer === null ? null : formatInstant(pointer, catalog, config.timezone)))
  io.out(texts.pending(pending))
  io.out(texts.daemon(await runningDaemonPid(layout.lockFile)))
  const blocked = await readBlocked(layout.blockedFile)
  if (blocked !== null) {
    const when = blocked.at === 0 ? '-' : formatInstant(blocked.at, catalog, config.timezone)
    io.out(texts.blocked(catalog.cli.blockedReasons[blocked.reason], when))
  }
  if (config.schedules.length === 0) io.out(texts.noSchedules)
  const scheduler = new CronerScheduler({ timezone: config.timezone, schedules: config.schedules, onTick: () => {} })
  for (const { schedule, next } of scheduler.nextRuns(new Date(now))) {
    io.out(texts.schedule(schedule, next === null ? null : formatInstant(next.getTime(), catalog, config.timezone)))
  }
  return EXIT_OK
}
