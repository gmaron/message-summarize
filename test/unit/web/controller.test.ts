import { afterEach, describe, expect, it } from 'vitest'
import { createApi } from '../../../src/interfaces/web/lib/api.js'
import { createController } from '../../../src/interfaces/web/lib/controller.js'
import { account, FakeEventSource, fakeFetch } from './support.js'

afterEach(() => {
  for (const source of FakeEventSource.all) source.close()
  FakeEventSource.all = []
})

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
type Answers = Parameters<typeof fakeFetch>[0]

function setup(answers: Answers = {}, browserLanguage = 'en-US') {
  const fake = fakeFetch({
    'GET /api/info': { body: { language: 'es' } },
    'GET /api/accounts': { body: { accounts: [account()] } },
    ...answers,
  })
  const controller = createController({
    api: createApi(fake.fetchFn, () => controller.markUnauthorized()),
    createEventSource: () => new FakeEventSource(),
    browserLanguage,
    retryMs: 5,
  })
  return { ...fake, controller }
}
const accountCalls = (calls: { path: string }[]) => calls.filter((c) => c.path === '/api/accounts').length

describe('start', () => {
  it('takes the language of the installation, loads the accounts and listens', async () => {
    const { controller } = setup()
    await controller.start()
    expect(controller.state.language).toBe('es')
    expect(controller.state.accounts).toEqual([account()])
    FakeEventSource.last().emit('open')
    expect(controller.state.connection).toBe('online')
    FakeEventSource.last().emit('accounts', { accounts: [account({ state: 'blocked', blockedReason: 'loggedOut' })] })
    expect(controller.state.accounts?.[0]?.state).toBe('blocked')
  })

  it('falls back to the language of the browser when the daemon does not say', async () => {
    const { controller } = setup({ 'GET /api/info': { status: 404 } }, 'es-AR')
    await controller.start()
    expect(controller.state.language).toBe('es')
  })

  it('shows the "open it again" state on any 401', async () => {
    const { controller } = setup({
      'GET /api/accounts': { status: 401, body: { error: 'unauthorized' } },
      'GET /api/info': { status: 401 },
    })
    await controller.start()
    expect(controller.state.unauthorized).toBe(true)
    expect(controller.state.accounts).toBeNull()
  })

  it('reports a failed first load with its code', async () => {
    const { controller } = setup({ 'GET /api/accounts': { status: 500, body: { error: 'internal' } } })
    await controller.start()
    expect(controller.state.loadError).toBe('internal')
  })

  it('asks again for the accounts on every open (the first included) and for the link in progress on a reconnect', async () => {
    const { controller, calls } = setup({
      'GET /api/accounts/alpha/link': { body: { state: 'syncing', sync: { chats: 2, messages: 9, done: false } } },
      'POST /api/accounts/alpha/link': { status: 202, body: { state: 'waitingQr' } },
    })
    await controller.start()
    await controller.startLink('alpha')
    const before = accountCalls(calls)
    FakeEventSource.last().emit('open')
    await wait()
    // what changed between the first fetch and the stream is not lost
    expect(accountCalls(calls)).toBe(before + 1)
    expect(calls.some((c) => c.path === '/api/accounts/alpha/link' && c.method === 'GET')).toBe(false)
    FakeEventSource.last().emit('error')
    expect(controller.state.connection).toBe('offline')
    FakeEventSource.last().emit('open')
    await wait()
    expect(accountCalls(calls)).toBe(before + 2)
    expect(calls.some((c) => c.path === '/api/accounts/alpha/link' && c.method === 'GET')).toBe(true)
    expect(controller.state.links.alpha).toMatchObject({ phase: 'syncing', sync: { chats: 2 } })
    expect(controller.state.connection).toBe('online')
  })

  it('after a daemon restart (the session is forgotten) a broken stream ends in the "open it again" state, for good', async () => {
    const answer: { status: number; body: unknown } = { status: 200, body: { language: 'en' } }
    const { controller, calls } = setup({ 'GET /api/info': () => answer })
    await controller.start()
    const first = FakeEventSource.last()
    first.readyState = 2
    answer.status = 401
    answer.body = { error: 'unauthorized' }
    first.emit('error')
    await wait(30)
    expect(controller.state.unauthorized).toBe(true)
    // the stream is closed and no new one is opened
    expect(first.closed).toBe(true)
    const streams = FakeEventSource.all.length
    const probes = calls.filter((c) => c.path === '/api/info').length
    await wait(40)
    expect(FakeEventSource.all.length).toBe(streams)
    expect(calls.filter((c) => c.path === '/api/info').length).toBe(probes)
  })

  it('a broken stream with a daemon that answers stays "offline" and keeps trying', async () => {
    const { controller } = setup()
    await controller.start()
    const first = FakeEventSource.last()
    first.readyState = 2
    first.emit('error')
    await wait(30)
    expect(controller.state.unauthorized).toBe(false)
    expect(controller.state.connection).toBe('offline')
    expect(FakeEventSource.all.length).toBeGreaterThan(1)
    controller.stop()
  })

  it('opens a new stream by itself when the browser gave up on the old one', async () => {
    const { controller } = setup()
    await controller.start()
    const first = FakeEventSource.last()
    first.readyState = 2
    first.emit('error')
    await wait(30)
    expect(FakeEventSource.all.length).toBe(2)
    controller.stop()
  })
})

describe('actions', () => {
  it('summarize now: 202 started, then the events say the rest', async () => {
    const { controller } = setup({ 'POST /api/accounts/alpha/digest': { status: 202, body: { state: 'started' } } })
    await controller.start()
    await controller.digestNow('alpha')
    expect(controller.state.digests.alpha).toEqual({ kind: 'started' })
    FakeEventSource.last().emit('digest', { account: 'alpha', state: 'done', summarized: 2, parts: 1 })
    expect(controller.state.digests.alpha).toEqual({ kind: 'done', summarized: 2, parts: 1 })
  })

  it('summarize now: deferred, busy (409) and refused (409 notRunning)', async () => {
    const answer: { status: number; body: unknown } = { status: 202, body: { state: 'deferred' } }
    const { controller } = setup({ 'POST /api/accounts/alpha/digest': () => answer })
    await controller.start()
    await controller.digestNow('alpha')
    expect(controller.state.digests.alpha).toEqual({ kind: 'deferred' })
    Object.assign(answer, { status: 409, body: { error: 'busy' } })
    await controller.digestNow('alpha')
    expect(controller.state.digests.alpha).toEqual({ kind: 'busy' })
    Object.assign(answer, { status: 409, body: { error: 'notRunning' } })
    await controller.digestNow('alpha')
    expect(controller.state.digests.alpha).toEqual({ kind: 'error', code: 'notRunning' })
  })

  it('does not overwrite an event that arrived before the answer of the request', async () => {
    const { controller } = setup({ 'POST /api/accounts/alpha/digest': { status: 202, body: { state: 'started' } } })
    await controller.start()
    const pending = controller.digestNow('alpha')
    FakeEventSource.last().emit('digest', { account: 'alpha', state: 'done', summarized: 1, parts: 1 })
    await pending
    expect(controller.state.digests.alpha?.kind).toBe('done')
  })

  it('preview: runs, and on the event asks for the content', async () => {
    const { controller, calls } = setup({
      'POST /api/accounts/alpha/preview': { status: 202, body: { state: 'running' } },
      'GET /api/accounts/alpha/preview': {
        body: { state: 'done', parts: ['<b>hi</b>\nthere'], summarized: 1, failed: 0, generatedAt: 5 },
      },
    })
    await controller.start()
    await controller.startPreview('alpha')
    expect(controller.state.previews.alpha).toEqual({ kind: 'running' })
    FakeEventSource.last().emit('preview', { account: 'alpha', state: 'done' })
    await wait()
    expect(calls.some((c) => c.method === 'GET' && c.path === '/api/accounts/alpha/preview')).toBe(true)
    // the text arrives untouched (the page shows it as text)
    expect(controller.state.previews.alpha?.view?.parts).toEqual(['<b>hi</b>\nthere'])
  })

  it('preview: a refusal is shown with its code, but one already running is waited for', async () => {
    const answer: { status: number; body: unknown } = { status: 422, body: { error: 'invalidConfig' } }
    const { controller } = setup({ 'POST /api/accounts/alpha/preview': () => answer })
    await controller.start()
    await controller.startPreview('alpha')
    expect(controller.state.previews.alpha).toEqual({ kind: 'error', code: 'invalidConfig' })
    Object.assign(answer, { status: 409, body: { error: 'busy' } })
    await controller.startPreview('alpha')
    expect(controller.state.previews.alpha).toEqual({ kind: 'running' })
  })

  it('history: the event reaches whoever listens, for its account, and carries no content', async () => {
    const { controller } = setup()
    await controller.start()
    const seen: string[] = []
    const stop = controller.onHistory((id) => seen.push(id))
    FakeEventSource.last().emit('history', { account: 'alpha' })
    FakeEventSource.last().emit('history', {})
    FakeEventSource.last().emit('history', { account: 5 })
    expect(seen).toEqual(['alpha'])
    stop()
    FakeEventSource.last().emit('history', { account: 'alpha' })
    expect(seen).toEqual(['alpha'])
  })

  it('add account: validates the id before asking, then creates it', async () => {
    const { controller, calls } = setup({ 'POST /api/accounts': { status: 201, body: { id: 'work' } } })
    await controller.start()
    expect(await controller.addAccount('Bad Id')).toEqual({ ok: false, code: 'invalidAccountId' })
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/accounts')).toBe(false)
    expect(await controller.addAccount('work')).toEqual({ ok: true })
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/accounts')?.body).toEqual({ id: 'work' })
  })

  it('add account: shows the code when the daemon refuses', async () => {
    const { controller } = setup({ 'POST /api/accounts': { status: 409, body: { error: 'accountExists' } } })
    await controller.start()
    expect(await controller.addAccount('alpha')).toEqual({ ok: false, code: 'accountExists' })
  })

  it('link: start, a link already in progress is restored, a refusal is shown, cancel resets', async () => {
    const answer: { status: number; body: unknown } = { status: 202, body: { state: 'waitingQr' } }
    const { controller, calls } = setup({
      'POST /api/accounts/alpha/link': () => answer,
      'GET /api/accounts/alpha/link': { body: { state: 'qr' } },
      'DELETE /api/accounts/alpha/link': { body: { ok: true } },
    })
    await controller.start()
    await controller.startLink('alpha')
    expect(controller.state.links.alpha?.phase).toBe('waitingQr')
    Object.assign(answer, { status: 409, body: { error: 'alreadyLinking' } })
    await controller.startLink('alpha')
    expect(controller.state.links.alpha?.phase).toBe('qr')
    Object.assign(answer, { status: 422, body: { error: 'invalidConfig' } })
    await controller.startLink('alpha')
    expect(controller.state.links.alpha).toMatchObject({ phase: 'idle', requestError: 'invalidConfig' })
    await controller.cancelLink('alpha')
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
    expect(controller.state.links.alpha?.phase).toBe('idle')
  })

  it('retry: returns the code of a refusal and refreshes the accounts on success', async () => {
    const answer: { status: number; body: unknown } = { status: 409, body: { error: 'needsRelink' } }
    const { controller, calls } = setup({ 'POST /api/accounts/alpha/retry': () => answer })
    await controller.start()
    expect(await controller.retry('alpha')).toBe('needsRelink')
    Object.assign(answer, { status: 200, body: { ok: true } })
    const before = accountCalls(calls)
    expect(await controller.retry('alpha')).toBeNull()
    expect(accountCalls(calls)).toBe(before + 1)
  })

  it('tells its listeners about every change, until they unsubscribe', async () => {
    const { controller } = setup()
    const seen: number[] = []
    const off = controller.subscribe((s) => seen.push(s.accounts?.length ?? -1))
    await controller.start()
    expect(seen.length).toBeGreaterThan(0)
    off()
    const count = seen.length
    FakeEventSource.last().emit('accounts', { accounts: [] })
    expect(seen.length).toBe(count)
  })
})
