import { formatTime, makeSchedule, type Schedule } from '../../domain/schedule.js'
import { HttpError, type Route } from '../../interfaces/http/router.js'
import { loadEffectiveConfig } from '../config/config.js'
import { nextRunAt } from '../config/schedule-format.js'
import type { CommandContext } from '../context.js'
import type { Installation } from '../installation/accounts.js'
import { accountLayoutOf } from '../installation/paths.js'
import { type AccountRoutesSource, knownAccount } from './routes.js'

export interface ScheduleRoutesSource extends AccountRoutesSource {
  readonly ctx: Pick<CommandContext, 'layout' | 'clock'>
}

/** A schedule as the web shows it (RF-60): days as cron numbers (0 is Sunday), the time and when it runs next. */
export interface ScheduleView {
  readonly id: number
  readonly days: readonly number[]
  readonly time: string
  /** Epoch ms in the account's time zone (RF-62), or null. */
  readonly nextRun: number | null
}

const viewOf = (id: number, schedule: Schedule, timezone: string, now: number): ScheduleView => ({
  id,
  days: [...schedule.days],
  time: formatTime(schedule),
  nextRun: nextRunAt(schedule, timezone, now),
})

/** The `{ days, time }` of a body, checked for its TYPES (what the values mean is `makeSchedule`'s to say). */
function readBody(body: unknown): { days: number[]; time: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'invalidRequest')
  const { days, time } = body as { days?: unknown; time?: unknown }
  if (!Array.isArray(days) || !days.every((day) => typeof day === 'number' && Number.isInteger(day))) {
    throw new HttpError(400, 'invalidRequest')
  }
  if (typeof time !== 'string') throw new HttpError(400, 'invalidRequest')
  return { days: days as number[], time }
}

function scheduleOf(installation: Installation, accountId: string, params: Readonly<Record<string, string>>): number {
  const raw = params.sid ?? ''
  const id = /^\d{1,15}$/.test(raw) ? Number(raw) : -1
  if (!installation.schedules.list(accountId).some((stored) => stored.id === id)) throw new HttpError(404, 'notFound')
  return id
}

/**
 * The schedules of an account (RF-60, RF-61, RF-62): list, create, edit and delete. They are rows of `app.db`, which is
 * what `msum schedule` writes too, so the running daemon applies a change within its reload period, with no restart.
 * `onChanged` is called after every change (the next run of the account is another). A schedule is only ever looked up
 * under the account of the path: another account's id is a 404.
 */
export function scheduleRoutes(source: ScheduleRoutesSource, onChanged: () => void): Route[] {
  const { installation, ctx } = source

  /** The time zone of the account (its effective configuration), or a 422 when that configuration is invalid. */
  const timezoneOf = async (id: string): Promise<string> => {
    const loaded = await loadEffectiveConfig(ctx.layout.configFile, accountLayoutOf(ctx.layout, id).configFile)
    if (!loaded.ok) throw new HttpError(422, 'invalidConfig')
    return loaded.value.timezone
  }
  const viewAll = async (id: string) => {
    const timezone = await timezoneOf(id)
    const now = ctx.clock.now()
    return {
      timezone,
      schedules: installation.schedules.list(id).map((stored) => viewOf(stored.id, stored.schedule, timezone, now)),
    }
  }
  const viewOne = async (accountId: string, id: number): Promise<ScheduleView> => {
    const timezone = await timezoneOf(accountId)
    const stored = installation.schedules.list(accountId).find((row) => row.id === id)
    if (stored === undefined) throw new HttpError(404, 'notFound')
    return viewOf(stored.id, stored.schedule, timezone, ctx.clock.now())
  }
  const invalid = (issue: string) => ({ status: 422, body: { error: 'invalidSchedule', issue } })

  return [
    {
      method: 'GET',
      path: '/api/accounts/:id/schedules',
      handler: async ({ params }) => ({ body: await viewAll(knownAccount(source, params)) }),
    },
    {
      method: 'POST',
      path: '/api/accounts/:id/schedules',
      handler: async ({ params, body }) => {
        const accountId = knownAccount(source, params)
        const given = readBody(body)
        const made = makeSchedule(given.days, given.time)
        if (!made.ok) return invalid(made.error)
        await timezoneOf(accountId)
        const id = installation.schedules.add(accountId, made.value)
        onChanged()
        return { status: 201, body: await viewOne(accountId, id) }
      },
    },
    {
      method: 'PUT',
      path: '/api/accounts/:id/schedules/:sid',
      handler: async ({ params, body }) => {
        const accountId = knownAccount(source, params)
        const id = scheduleOf(installation, accountId, params)
        const given = readBody(body)
        const made = makeSchedule(given.days, given.time)
        if (!made.ok) return invalid(made.error)
        await timezoneOf(accountId) // an invalid configuration is refused before anything is written
        if (!installation.schedules.update(accountId, id, made.value)) throw new HttpError(404, 'notFound')
        onChanged()
        return { body: await viewOne(accountId, id) }
      },
    },
    {
      method: 'DELETE',
      path: '/api/accounts/:id/schedules/:sid',
      handler: ({ params }) => {
        const accountId = knownAccount(source, params)
        const id = scheduleOf(installation, accountId, params)
        if (!installation.schedules.remove(accountId, id)) throw new HttpError(404, 'notFound')
        onChanged()
        return { status: 204 }
      },
    },
  ]
}
