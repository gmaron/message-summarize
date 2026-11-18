import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError, createApi, type FetchFn } from '../../../src/interfaces/web/lib/api.js'
import { consumeToken } from '../../../src/interfaces/web/lib/auth.js'
import { disposeHarnesses, SUMMARY, seedMessages, until } from '../../support/cli-harness.js'
import { disposeWorlds, QR1, type World, world } from '../../support/web-world.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

/** The real client of the page, talking to the real server: a route that is renamed breaks this. */
function clientOf(w: World, authorize: boolean) {
  const token = readFileSync(w.h.layout.webTokenFile, 'utf8').trim()
  let unauthorized = 0
  const fetchFn: FetchFn = (input, init) =>
    fetch(`http://127.0.0.1:${w.port}${input}`, {
      method: init?.method ?? 'GET',
      headers: { ...(authorize ? { Authorization: `Bearer ${token}` } : {}), ...init?.headers },
      ...(init?.body === undefined ? {} : { body: init.body }),
    })
  return { api: createApi(fetchFn, () => unauthorized++), fetchFn, token, unauthorized: () => unauthorized }
}

const codeOf = async (call: Promise<unknown>): Promise<string | undefined> => {
  try {
    await call
  } catch (error) {
    return error instanceof ApiError ? `${error.status}:${error.code}` : 'other'
  }
  return undefined
}

describe('the client of the page against the real server', () => {
  it('info, accounts, create account, retry and the errors (with their codes)', async () => {
    const w = await world({ accounts: ['alpha'] })
    const { api } = clientOf(w, true)
    expect(await api.info()).toEqual({ language: 'en' })
    expect((await api.accounts()).map((a) => a.id)).toEqual(['alpha'])
    expect(await api.createAccount('beta')).toEqual({ id: 'beta' })
    expect((await api.accounts()).map((a) => a.id).sort()).toEqual(['alpha', 'beta'])
    expect(await codeOf(api.createAccount('beta'))).toBe('409:accountExists')
    expect(await codeOf(api.createAccount('Bad Id'))).toBe('400:invalidAccountId')
    expect(await codeOf(api.retry('alpha'))).toBe('409:notBlocked')
    expect(await codeOf(api.retry('ghost'))).toBe('404:notFound')
  })

  it('schedules: list, add, update, delete, and a refusal with its issue', async () => {
    const w = await world({ accounts: ['alpha'] })
    const { api } = clientOf(w, true)
    const before = await api.schedules('alpha')
    expect(before.timezone).toBe('UTC')
    const added = await api.addSchedule('alpha', { days: [1, 2, 3], time: '09:30' })
    expect(added).toMatchObject({ days: [1, 2, 3], time: '09:30' })
    expect(typeof added.nextRun).toBe('number')
    const updated = await api.updateSchedule('alpha', added.id, { days: [0, 6], time: '18:00' })
    expect(updated).toMatchObject({ id: added.id, days: [0, 6], time: '18:00' })
    expect((await api.schedules('alpha')).schedules.map((s) => s.id)).toContain(added.id)
    try {
      await api.addSchedule('alpha', { days: [], time: '09:00' })
      throw new Error('accepted')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ status: 422, code: 'invalidSchedule', issue: 'noDays' })
    }
    expect(await api.deleteSchedule('alpha', added.id)).toBeUndefined()
    expect((await api.schedules('alpha')).schedules.map((s) => s.id)).not.toContain(added.id)
    expect(await codeOf(api.deleteSchedule('alpha', added.id))).toBe('404:notFound')
  })

  it('link: start, snapshot, the image of the QR at the url the client builds, cancel', async () => {
    const w = await world({ accounts: ['alpha'] })
    const { api, fetchFn } = clientOf(w, true)
    expect(await api.linkSnapshot('alpha')).toEqual({ state: 'idle' })
    w.h.connection.onStart = () => w.h.connection.emit({ state: 'qr', qr: QR1 })
    expect(await api.startLink('alpha')).toEqual({ state: 'waitingQr' })
    await until(() => w.eventsOf('qr').length === 1, 'the qr event')
    expect(await api.linkSnapshot('alpha')).toEqual({ state: 'qr' })
    const image = await fetchFn(api.qrUrl('alpha', 3))
    expect(image.status).toBe(200)
    expect(await api.cancelLink('alpha')).toEqual({ ok: true })
    expect(await codeOf(api.cancelLink('alpha'))).toBe('409:notLinking')
    expect((await fetchFn(api.qrUrl('alpha', 4))).status).toBe(404)
  })

  it('digest and preview: the calls, the refusal of a digest with nothing running, and the content of a preview', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    const runtime = w.h.runtime('alpha')
    try {
      await seedMessages(runtime, [{ id: 'alpha-1', text: 'dinner on friday', timestamp: Date.now() - 3_600_000 }])
    } finally {
      runtime.close()
    }
    await until(() => w.host.daemonOf('alpha') !== undefined, 'the unit')
    const { api } = clientOf(w, true)
    expect(await api.preview('alpha')).toEqual({ state: 'none' })
    expect(await api.startPreview('alpha')).toEqual({ state: 'running' })
    await until(() => w.eventsOf('preview').length === 1, 'the preview event')
    const view = await api.preview('alpha')
    expect(view.state).toBe('done')
    expect(view.parts?.join('\n')).toContain(SUMMARY.resumen)
    expect(await codeOf(api.digestNow('ghost'))).toBe('404:notFound')
    const reply = await codeOf(api.digestNow('alpha'))
    // a unit that is running is asked to make the digest: it is accepted, or refused with a code (never an exception of another kind)
    expect(reply === undefined || /^409:/.test(reply)).toBe(true)
  })

  it('without the token every call is a 401, and the client tells the page so', async () => {
    const w = await world({ accounts: ['alpha'] })
    const { api, unauthorized } = clientOf(w, false)
    expect(await codeOf(api.accounts())).toBe('401:unauthorized')
    expect(await codeOf(api.info())).toBe('401:unauthorized')
    expect(unauthorized()).toBe(2)
  })

  it('consumeToken opens the session with the real server (the cookie is what the page then uses)', async () => {
    const w = await world({ accounts: ['alpha'] })
    const { fetchFn, token } = clientOf(w, false)
    const replaced: string[] = []
    const result = await consumeToken({
      location: { hash: `#token=${token}`, pathname: '/', search: '' },
      history: { replaceState: (_d, _u, url) => void replaced.push(url) },
      fetch: fetchFn,
    })
    expect(result).toBe('ok')
    expect(replaced).toEqual(['/'])
    const wrong = await consumeToken({
      location: { hash: '#token=nope', pathname: '/', search: '' },
      history: { replaceState: () => {} },
      fetch: fetchFn,
    })
    expect(wrong).toBe('rejected')
  })
})
