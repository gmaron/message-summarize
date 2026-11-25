import { formatTime, makeSchedule, scheduleToCron } from '../../domain/schedule.js'
import { nextRunOf } from '../../infrastructure/scheduling/croner-scheduler.js'
import { EXIT_FAILURE, EXIT_OK, type ScheduleCommand } from '../../interfaces/cli/run.js'
import { describeDays } from '../config/schedule-format.js'
import { type CommandContext, formatInstant } from '../context.js'
import { isPrepared, prepareAccount } from './account-command.js'

/**
 * `msum schedule [ls|add|rm]` (RF-60, RF-61): the digests of an account run on days of the week at a time, in the time
 * zone of the account (RF-62). They live in `app.db`, so a running daemon applies a change within a few seconds, without
 * a restart. These commands never take the daemon lock: they work while the daemon runs.
 *
 * - `ls`: id, days, time and the next run in the account's time zone.
 * - `add --time HH:MM [--days ...]`: every day unless `--days` says otherwise.
 * - `rm <id>`: removes a schedule of THIS account only.
 */
export async function scheduleCommand(ctx: CommandContext, command: ScheduleCommand): Promise<number> {
  const prepared = await prepareAccount(ctx, command.account, 'existing')
  if (!isPrepared(prepared)) return prepared.exit
  const { installation, account, config, catalog } = prepared
  const texts = catalog.cli.schedule
  const { io } = ctx
  const nextOf = (schedule: Parameters<typeof scheduleToCron>[0]): string | null => {
    const next = nextRunOf(scheduleToCron(schedule), config.timezone, new Date(ctx.clock.now()))
    return next === null ? null : formatInstant(next.getTime(), catalog, config.timezone)
  }
  try {
    switch (command.action) {
      case 'ls': {
        const stored = installation.schedules.list(account.id)
        if (stored.length === 0) io.out(texts.empty)
        for (const { id, schedule } of stored) {
          io.out(texts.row(id, describeDays(texts, schedule.days), formatTime(schedule), nextOf(schedule)))
        }
        return EXIT_OK
      }
      case 'add': {
        const made = makeSchedule(command.days, command.time)
        if (!made.ok) return EXIT_FAILURE // the argument parser already checked both: not reachable
        const id = installation.schedules.add(account.id, made.value)
        io.out(texts.added(id, describeDays(texts, made.value.days), formatTime(made.value), nextOf(made.value)))
        return EXIT_OK
      }
      case 'rm': {
        if (!installation.schedules.remove(account.id, command.id)) {
          io.err(texts.notFound(command.id))
          return EXIT_FAILURE
        }
        io.out(texts.removed(command.id))
        return EXIT_OK
      }
    }
  } finally {
    installation.close()
  }
}
