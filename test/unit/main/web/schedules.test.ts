import { afterEach, describe, expect, it } from 'vitest'
import { scheduleToCron } from '../../../../src/domain/schedule.js'
import { importConfigSchedules } from '../../../../src/main/config/schedules.js'
import { disposeHarnesses, until, waitFor } from '../../../support/cli-harness.js'
import { BASE, disposeWorlds, type World, world } from '../../../support/web-world.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

const started = (w: World, id: string) => until(() => w.host.daemonOf(id) !== undefined, `the unit of ${id}`)
const path = (id: string, sid?: number) => `/api/accounts/${id}/schedules${sid === undefined ? '' : `/${sid}`}`

/** The expressions the running daemon of an account has armed. */
function armed(w: World, id: string): readonly string[] {
  const daemon = w.host.daemonOf(id) as unknown as { scheduler: { expressions: readonly string[] } } | undefined
  return daemon?.scheduler.expressions ?? []
}

function nextRunOfAccount(w: World, id: string): unknown {
  const accounts = w.eventsOf('accounts').at(-1)?.data.accounts as { id: string; nextRun: unknown }[] | undefined
  return accounts?.find((a) => a.id === id)?.nextRun
}

describe('schedules over HTTP (RF-60, RF-61)', () => {
  it('lists, creates, edits and deletes, behind the token, for an account that exists', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    for (const [method, url] of [
      ['GET', path('alpha')],
      ['POST', path('alpha')],
      ['PUT', path('alpha', 1)],
      ['DELETE', path('alpha', 1)],
    ] as const) {
      expect(
        (await w.api(method, url, method === 'GET' ? undefined : { days: [1], time: '09:00' }, null)).status,
        `${method} ${url}`,
      ).toBe(401)
    }
    expect(await w.api('GET', path('ghost'))).toEqual({ status: 404, body: { error: 'notFound' } })
    expect((await w.api('GET', '/api/accounts/..%2Fetc/schedules')).status).toBe(404)
    expect((await w.api('POST', path('ghost'), { days: [1], time: '09:00' })).status).toBe(404)

    expect(await w.api('GET', path('alpha'))).toEqual({ status: 200, body: { timezone: 'UTC', schedules: [] } })
    const created = await w.api('POST', path('alpha'), { days: [3, 1, 3], time: '9:05' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ days: [1, 3], time: '09:05' })
    expect(typeof created.body.nextRun).toBe('number')
    const id = created.body.id as number
    expect((await w.api('GET', path('alpha'))).body).toEqual({
      timezone: 'UTC',
      schedules: [{ id, days: [1, 3], time: '09:05', nextRun: created.body.nextRun }],
    })

    const edited = await w.api('PUT', path('alpha', id), { days: [0, 6], time: '21:30' })
    expect(edited.status).toBe(200)
    expect(edited.body).toMatchObject({ id, days: [0, 6], time: '21:30' })
    expect(w.installation.schedules.list('alpha').map((s) => s.id)).toEqual([id])

    expect(await w.api('DELETE', path('alpha', id))).toEqual({ status: 204, body: {} })
    expect((await w.api('GET', path('alpha'))).body.schedules).toEqual([])
    expect(await w.api('DELETE', path('alpha', id))).toEqual({ status: 404, body: { error: 'notFound' } })
    expect(await w.api('PUT', path('alpha', id), { days: [1], time: '09:00' })).toEqual({
      status: 404,
      body: { error: 'notFound' },
    })
    expect((await w.api('DELETE', '/api/accounts/alpha/schedules/abc')).status).toBe(404)
  })

  it('validates the body: 400 for the wrong types, 422 with the issue for a schedule that is not one', async () => {
    const w = await world({ accounts: ['alpha'] })
    const bad = [undefined, null, [], 'x', {}, { days: [1] }, { time: '09:00' }, { days: 1, time: '09:00' }]
    for (const body of bad) {
      expect(await w.api('POST', path('alpha'), body), JSON.stringify(body)).toEqual({
        status: 400,
        body: { error: 'invalidRequest' },
      })
    }
    for (const body of [
      { days: ['1'], time: '09:00' },
      { days: [1.5], time: '09:00' },
      { days: [null], time: '09:00' },
      { days: [1], time: 900 },
      { days: [1], time: null },
    ]) {
      expect((await w.api('POST', path('alpha'), body)).status, JSON.stringify(body)).toBe(400)
    }
    const raw = await fetch(`http://127.0.0.1:${w.port}${path('alpha')}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${(await import('node:fs')).readFileSync(w.h.layout.webTokenFile, 'utf8').trim()}`,
      },
      body: '{ nope',
    })
    expect(raw.status).toBe(400)
    expect(await raw.json()).toEqual({ error: 'invalidJson' })

    expect(await w.api('POST', path('alpha'), { days: [], time: '09:00' })).toEqual({
      status: 422,
      body: { error: 'invalidSchedule', issue: 'noDays' },
    })
    expect(await w.api('POST', path('alpha'), { days: [1, 7], time: '09:00' })).toEqual({
      status: 422,
      body: { error: 'invalidSchedule', issue: 'invalidDay' },
    })
    expect(await w.api('POST', path('alpha'), { days: [-1], time: '09:00' })).toMatchObject({ status: 422 })
    expect(await w.api('POST', path('alpha'), { days: [1], time: '25:00' })).toEqual({
      status: 422,
      body: { error: 'invalidSchedule', issue: 'invalidTime' },
    })
    expect(await w.api('POST', path('alpha'), { days: [1], time: 'noon' })).toMatchObject({
      status: 422,
      body: { issue: 'invalidTime' },
    })
    // an edit that is refused changes nothing
    const id = (await w.api('POST', path('alpha'), { days: [1], time: '09:00' })).body.id as number
    expect(await w.api('PUT', path('alpha', id), { days: [], time: '10:00' })).toMatchObject({
      status: 422,
      body: { issue: 'noDays' },
    })
    expect(await w.api('PUT', path('alpha', id), { days: [1], time: 5 })).toMatchObject({ status: 400 })
    expect(w.installation.schedules.list('alpha').map((s) => s.schedule.minute)).toEqual([0])
    expect(w.installation.schedules.list('alpha')[0]?.schedule.hour).toBe(9)
  })

  it('never lets one account edit or delete the schedule of another', async () => {
    const w = await world({ accounts: ['alpha', 'beta'] })
    const mine = (await w.api('POST', path('alpha'), { days: [1], time: '08:00' })).body.id as number
    const theirs = (await w.api('POST', path('beta'), { days: [2], time: '10:00' })).body.id as number
    expect(await w.api('PUT', path('alpha', theirs), { days: [5], time: '11:00' })).toEqual({
      status: 404,
      body: { error: 'notFound' },
    })
    expect((await w.api('DELETE', path('alpha', theirs))).status).toBe(404)
    expect((await w.api('PUT', path('beta', mine), { days: [5], time: '11:00' })).status).toBe(404)
    expect((await w.api('DELETE', path('beta', mine))).status).toBe(404)
    expect((await w.api('GET', path('alpha'))).body.schedules).toMatchObject([{ id: mine, days: [1], time: '08:00' }])
    expect((await w.api('GET', path('beta'))).body.schedules).toMatchObject([{ id: theirs, days: [2], time: '10:00' }])
  })

  it('computes nextRun in the time zone of the account across a daylight saving change (RF-62)', async () => {
    const w = await world({ accounts: ['alpha'], config: { ...BASE, timezone: 'America/New_York' } })
    const at = (iso: string) => {
      w.h.clock.now = () => Date.parse(iso)
    }
    const created = await w.api('POST', path('alpha'), { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' })
    expect((await w.api('GET', path('alpha'))).body.timezone).toBe('America/New_York')
    const id = created.body.id as number
    const next = async () => ((await w.api('GET', path('alpha'))).body.schedules as { nextRun: number }[])[0]?.nextRun
    // 2026-03-08 02:00 EST -> 03:00 EDT: 09:00 the next morning is 13:00 UTC, not the 14:00 UTC of a fixed offset
    at('2026-03-07T15:00:00Z')
    expect(await next()).toBe(Date.parse('2026-03-08T13:00:00Z'))
    at('2026-03-08T15:00:00Z')
    expect(await next()).toBe(Date.parse('2026-03-09T13:00:00Z'))
    // 2026-11-01 02:00 EDT -> 01:00 EST: 09:00 is 14:00 UTC afterwards
    at('2026-10-31T15:00:00Z')
    expect(await next()).toBe(Date.parse('2026-11-01T14:00:00Z'))
    // the answers of a create and an edit are computed the same way
    at('2026-03-07T15:00:00Z')
    const edited = await w.api('PUT', path('alpha', id), { days: [0, 1, 2, 3, 4, 5, 6], time: '09:30' })
    expect(edited.body.nextRun).toBe(Date.parse('2026-03-08T13:30:00Z'))
  })

  it('is applied by the running daemon without a restart: the armed expressions follow create, edit and delete', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await started(w, 'alpha')
    expect(armed(w, 'alpha')).toEqual([])
    const unit = w.host.daemonOf('alpha')

    const id = (await w.api('POST', path('alpha'), { days: [1, 3], time: '09:05' })).body.id as number
    await waitFor(() => expect(armed(w, 'alpha')).toEqual(['5 9 * * 1,3']))
    await w.api('PUT', path('alpha', id), { days: [0, 1, 2, 3, 4, 5, 6], time: '18:00' })
    await waitFor(() => expect(armed(w, 'alpha')).toEqual(['0 18 * * *']))
    const other = (await w.api('POST', path('alpha'), { days: [2], time: '07:00' })).body.id as number
    await waitFor(() =>
      expect(armed(w, 'alpha')).toEqual([
        scheduleToCron(w.installation.schedules.list('alpha')[1]?.schedule as never),
        '0 18 * * *',
      ]),
    )
    await w.api('DELETE', path('alpha', id))
    await w.api('DELETE', path('alpha', other))
    await waitFor(() => expect(armed(w, 'alpha')).toEqual([]))
    // the same daemon the whole time: nothing was restarted
    expect(w.host.daemonOf('alpha')).toBe(unit)
    expect(w.h.logs.join('\n')).not.toContain('"event":"account.unitStopped"')
  })

  it('publishes an accounts snapshot after every change, with the new next run', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await started(w, 'alpha')
    expect(nextRunOfAccount(w, 'alpha') ?? null).toBeNull()
    const id = (await w.api('POST', path('alpha'), { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' })).body.id as number
    await waitFor(() => expect(typeof nextRunOfAccount(w, 'alpha')).toBe('number'))
    await w.api('PUT', path('alpha', id), { days: [0, 1, 2, 3, 4, 5, 6], time: '23:59' })
    await waitFor(() => {
      const next = nextRunOfAccount(w, 'alpha') as number
      expect(new Date(next).getUTCHours()).toBe(23)
    })
    await w.api('DELETE', path('alpha', id))
    await waitFor(() => expect(nextRunOfAccount(w, 'alpha')).toBeNull())
  })

  it('a change made by `msum schedule` (another process) reaches the snapshot when the daemon reloads', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await started(w, 'alpha')
    const before = w.eventsOf('accounts').length
    const made = (await import('../../../../src/domain/schedule.js')).makeSchedule([1, 2], '06:00')
    if (!made.ok) throw new Error('invalid')
    w.installation.schedules.add('alpha', made.value)
    await waitFor(() => {
      expect(w.eventsOf('accounts').length).toBeGreaterThan(before)
      expect(typeof nextRunOfAccount(w, 'alpha')).toBe('number')
    })
  })

  it('an invalid configuration of the account is a 422 for the list and the create, which writes nothing', async () => {
    const w = await world({ accounts: ['alpha'] })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(w.h.accountOf('alpha').configFile, '{ not json')
    expect(await w.api('GET', path('alpha'))).toEqual({ status: 422, body: { error: 'invalidConfig' } })
    expect(await w.api('POST', path('alpha'), { days: [1], time: '09:00' })).toEqual({
      status: 422,
      body: { error: 'invalidConfig' },
    })
    expect(w.installation.schedules.list('alpha')).toEqual([])
  })

  it('an edit for an account with an invalid configuration is a 422 that saves nothing', async () => {
    const w = await world({ accounts: ['alpha'] })
    const id = (await w.api('POST', path('alpha'), { days: [1], time: '09:00' })).body.id as number
    const { writeFileSync } = await import('node:fs')
    writeFileSync(w.h.accountOf('alpha').configFile, '{ not json')
    expect(await w.api('PUT', path('alpha', id), { days: [2, 3], time: '10:30' })).toEqual({
      status: 422,
      body: { error: 'invalidConfig' },
    })
    const [kept] = w.installation.schedules.list('alpha')
    expect(kept).toMatchObject({ id, schedule: { days: [1], hour: 9, minute: 0 } })
  })
})

describe('the schedules of the configuration are imported once (RF-60)', () => {
  it('deleting them from the web does not bring them back, on a reconcile or when a unit starts again', async () => {
    const w = await world({
      accounts: ['alpha'],
      linked: ['alpha'],
      config: { ...BASE, schedules: ['0 9 * * *', '30 18 * * 1-5'] },
    })
    await started(w, 'alpha')
    const listed = (await w.api('GET', path('alpha'))).body.schedules as { id: number }[]
    expect(listed).toHaveLength(2)
    await waitFor(() => expect(armed(w, 'alpha')).toHaveLength(2))
    for (const { id } of listed) expect((await w.api('DELETE', path('alpha', id))).status).toBe(204)
    expect((await w.api('GET', path('alpha'))).body.schedules).toEqual([])

    await w.host.reconcile()
    await new Promise((resolve) => setTimeout(resolve, 150)) // several reloads and looks of the host
    await w.host.reconcile()
    expect((await w.api('GET', path('alpha'))).body.schedules).toEqual([])
    expect(armed(w, 'alpha')).toEqual([])
    // what a unit does when it starts: the import is done already, so it adds nothing
    expect(importConfigSchedules(w.installation, 'alpha', { schedules: ['0 9 * * *'] })).toEqual({
      done: false,
      imported: 0,
    })
    expect(w.installation.schedules.list('alpha')).toEqual([])
  })
})
