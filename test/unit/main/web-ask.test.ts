import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeHarnesses, FakeAnswerer, seedMessages, until } from '../../support/cli-harness.js'
import { disposeWorlds, type World, world } from '../../support/web-world.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

const PRIVATE_TEXT = 'PRIVATE-CHAT-TEXT: Ana wants a loan of 500'
const ANSWER = '## Orders\n- **Ana**: wants a loan of 500'

async function seed(w: World, id: string): Promise<void> {
  const runtime = w.h.runtime(id)
  try {
    await seedMessages(runtime, [{ id: `${id}-1`, text: PRIVATE_TEXT, timestamp: Date.now() - 3_600_000 }])
  } finally {
    runtime.close()
  }
}

const running = (w: World, id: string) => until(() => w.host.daemonOf(id) !== undefined, `the unit of ${id}`)
const asksOf = async (w: World, id: string) =>
  (await w.api('GET', `/api/accounts/${id}/asks`)).body.asks as Record<string, unknown>[]
const body = { question: 'who asked me for money?', period: 'h24', selection: 'all', deliver: false }

async function ready(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = await world({ accounts: ['alpha'], linked: ['alpha'], ...options })
  await seed(w, 'alpha')
  await running(w, 'alpha')
  return w
}

describe('POST /api/accounts/:id/ask', () => {
  it('answers 202 at once, publishes an ask event without the text, and keeps the answer for the GET', async () => {
    const w = await ready()
    expect((await w.api('POST', '/api/accounts/alpha/ask', body, null)).status).toBe(401)
    expect(await w.api('POST', '/api/accounts/alpha/ask', { ...body, chats: [' ana ', ''] })).toEqual({
      status: 202,
      body: { id: 1 },
    })
    await until(() => w.eventsOf('ask').length === 1, 'the ask event')
    expect(w.eventsOf('ask')[0]?.data).toEqual({ account: 'alpha', id: 1, state: 'done' })
    expect(JSON.stringify(w.sse)).not.toContain(PRIVATE_TEXT)
    expect(JSON.stringify(w.sse)).not.toContain('Ana')

    const asks = await asksOf(w, 'alpha')
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({
      id: 1,
      question: 'who asked me for money?',
      period: 'h24',
      selection: 'all',
      chats: ['ana'],
      state: 'done',
      deliver: false,
      delivery: 'off',
      result: { answer: ANSWER, provider: 'fake', chats: 1, messages: 1, leftOutLocalOnly: 0, parts: 1 },
    })
    const sent = w.answerer().requests[0]
    expect(sent?.systemPrompt).toContain('You are the assistant')
    expect(sent?.input).toContain('Request: who asked me for money?')
    expect(sent?.input).toContain(PRIVATE_TEXT)
    // nothing was sent to any chat, and the per-conversation summarizer was not used
    expect(w.h.connection.sent).toEqual([])
    expect(w.summarizer().requests).toHaveLength(0)
  })

  it('with the WhatsApp box on, queues the answer and the daemon delivers it, formatted, through the own-chat channel', async () => {
    const w = await ready()
    w.h.connection.emit({ state: 'connected' })
    await until(() => w.host.daemonOf('alpha')?.settled === true, 'the connection to settle')
    await w.api('POST', '/api/accounts/alpha/ask', { ...body, deliver: true })
    await until(() => w.eventsOf('ask').length === 1, 'the ask event')
    // `sent` holds what `sendTextToSelf` was given: the channel has no recipient to name (RF-51).
    await until(() => w.h.connection.sent.length >= 2, 'the delivery')
    expect(w.h.connection.sent[0]).toContain('Request about your chats')
    expect(w.h.connection.sent[1]).toBe('*Orders*\n• *Ana*: wants a loan of 500')
    await until(async () => (await asksOf(w, 'alpha'))[0]?.delivery === 'sent', 'the delivery to be marked sent')
  })

  it('with the WhatsApp box on and no connection, the answer waits queued', async () => {
    const w = await ready()
    await w.api('POST', '/api/accounts/alpha/ask', { ...body, deliver: true })
    await until(() => w.eventsOf('ask').length === 1, 'the ask event')
    expect(w.h.connection.sent).toEqual([])
    expect((await asksOf(w, 'alpha'))[0]).toMatchObject({ state: 'done', deliver: true, delivery: 'queued' })
  })

  it('fails with a code and delivers nothing when the model fails', async () => {
    const answerer = new FakeAnswerer(() => ({ ok: false, error: 'provider down' }))
    const w = await ready({ answerer })
    await w.api('POST', '/api/accounts/alpha/ask', { ...body, deliver: true })
    await until(() => w.eventsOf('ask').length === 1, 'the ask event')
    expect(w.eventsOf('ask')[0]?.data).toEqual({ account: 'alpha', id: 1, state: 'failed', error: 'failed' })
    expect((await asksOf(w, 'alpha'))[0]).toMatchObject({ state: 'failed', error: 'failed' })
    expect(w.h.connection.sent).toEqual([])
  })

  it('fails with noMessages when the selection finds nothing', async () => {
    const w = await ready()
    await w.api('POST', '/api/accounts/alpha/ask', { ...body, chats: ['nobody-here'] })
    await until(() => w.eventsOf('ask').length === 1, 'the ask event')
    expect((await asksOf(w, 'alpha'))[0]).toMatchObject({ state: 'failed', error: 'noMessages' })
    expect(w.answerer().requests).toHaveLength(0)
  })

  it('answers 409 busy while one runs, and accepts another after it ends', async () => {
    let open: () => void = () => {}
    const wait = new Promise<void>((resolve) => {
      open = resolve
    })
    const answerer = new FakeAnswerer(async () => {
      await wait
      return { ok: true, text: 'done', provider: 'fake' }
    })
    const w = await ready({ answerer })
    expect((await w.api('POST', '/api/accounts/alpha/ask', body)).status).toBe(202)
    expect(await w.api('POST', '/api/accounts/alpha/ask', body)).toEqual({ status: 409, body: { error: 'busy' } })
    open()
    await until(() => w.eventsOf('ask').length === 1, 'the ask event')
    expect((await w.api('POST', '/api/accounts/alpha/ask', body)).status).toBe(202)
  })

  it('answers 409 notRunning when the account has no running unit', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    expect(await w.api('POST', '/api/accounts/alpha/ask', body)).toEqual({ status: 409, body: { error: 'notRunning' } })
    expect(w.answerer().requests).toHaveLength(0)
  })

  it('rejects a question over 4000 characters after trimming, and accepts one of exactly 4000', async () => {
    const w = await ready()
    const ask = (question: string) => w.api('POST', '/api/accounts/alpha/ask', { ...body, question })
    expect(await ask('q'.repeat(4001))).toEqual({ status: 400, body: { error: 'questionTooLong' } })
    expect((await ask(` ${'q'.repeat(4000)} `)).status).toBe(202)
  })

  it('answers 404 for an account that does not exist', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect((await w.api('POST', '/api/accounts/nope/ask', body)).status).toBe(404)
    expect((await w.api('GET', '/api/accounts/nope/asks')).status).toBe(404)
    expect((await w.api('DELETE', '/api/accounts/nope/asks/1')).status).toBe(404)
    expect((await w.api('GET', '/api/accounts/nope/ask-presets')).status).toBe(404)
    expect((await w.api('PUT', '/api/accounts/nope/ask-presets', { presets: [] })).status).toBe(404)
  })

  it('validates the body: there is no mode, and the selection and the WhatsApp box are required', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await running(w, 'alpha')
    const post = (b: unknown) => w.api('POST', '/api/accounts/alpha/ask', b)
    for (const bad of [
      undefined,
      null,
      [],
      'text',
      { ...body, question: undefined },
      { ...body, question: 5 },
      { ...body, period: undefined },
      { ...body, period: 'month' },
      { ...body, selection: undefined },
      { ...body, selection: 'some' },
      { ...body, deliver: undefined },
      { ...body, deliver: 'yes' },
      { ...body, chats: 'ana' },
      { ...body, chats: [1] },
      { ...body, chats: Array.from({ length: 21 }, (_, i) => `c${i}`) },
    ]) {
      expect(await post(bad)).toEqual({ status: 400, body: { error: 'invalidRequest' } })
    }
    expect(await post({ ...body, question: '   ' })).toEqual({ status: 400, body: { error: 'emptyQuestion' } })
    expect(w.answerer().requests).toHaveLength(0)
  })

  it('accepts every period and every selection', async () => {
    const w = await ready()
    let n = 0
    for (const [period, selection] of [
      ['today', 'unanswered'],
      ['h24', 'unread'],
      ['d3', 'all'],
      ['d7', 'all'],
    ]) {
      expect((await w.api('POST', '/api/accounts/alpha/ask', { ...body, period, selection })).status).toBe(202)
      n += 1
      await until(() => w.eventsOf('ask').length === n, 'the ask event')
    }
  })

  it('trims and caps each chat filter', async () => {
    const w = await ready()
    await w.api('POST', '/api/accounts/alpha/ask', { ...body, chats: [`  ${'a'.repeat(300)}  `] })
    await until(() => w.eventsOf('ask').length === 1, 'the ask event')
    expect((await asksOf(w, 'alpha'))[0]?.chats).toEqual(['a'.repeat(100)])
  })
})

describe('GET and DELETE /api/accounts/:id/asks', () => {
  it('lists newest first and deletes one by id', async () => {
    const w = await ready()
    expect(await asksOf(w, 'alpha')).toEqual([])
    for (const n of [1, 2]) {
      await w.api('POST', '/api/accounts/alpha/ask', body)
      await until(() => w.eventsOf('ask').length === n, 'the ask event')
    }
    expect((await asksOf(w, 'alpha')).map((a) => a.id)).toEqual([2, 1])
    expect((await w.api('DELETE', '/api/accounts/alpha/asks/1', undefined, null)).status).toBe(401)
    expect((await w.api('DELETE', '/api/accounts/alpha/asks/1')).status).toBe(204)
    expect((await asksOf(w, 'alpha')).map((a) => a.id)).toEqual([2])
    expect(await w.api('DELETE', '/api/accounts/alpha/asks/1')).toEqual({ status: 404, body: { error: 'notFound' } })
    expect((await w.api('DELETE', '/api/accounts/alpha/asks/abc')).status).toBe(404)
    expect((await w.api('DELETE', '/api/accounts/alpha/asks/1.5')).status).toBe(404)
  })

  it('requires the token to read the answers', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    expect((await w.api('GET', '/api/accounts/alpha/asks', undefined, null)).status).toBe(401)
  })
})

describe('GET and PUT /api/accounts/:id/ask-presets', () => {
  const accountConfig = (w: World) => w.h.accountOf('alpha').configFile

  it('offers the two defaults of the language when the account has none', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    const got = await w.api('GET', '/api/accounts/alpha/ask-presets')
    expect(got.status).toBe(200)
    expect(got.body.defaults).toBe(true)
    expect((got.body.presets as { name: string }[]).map((p) => p.name)).toEqual(['Orders', 'Pending'])
    expect((await w.api('GET', '/api/accounts/alpha/ask-presets', undefined, null)).status).toBe(401)
  })

  it('saves the presets in the config.json of the account, trimmed, and offers them instead of the defaults', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    const presets = [{ name: ' Weekly orders ', text: ' List the orders of the week. ' }]
    const saved = await w.api('PUT', '/api/accounts/alpha/ask-presets', { presets })
    expect(saved.status).toBe(200)
    expect(saved.body).toEqual({
      defaults: false,
      presets: [{ name: 'Weekly orders', text: 'List the orders of the week.' }],
    })
    expect(JSON.parse(readFileSync(accountConfig(w), 'utf8')).askPresets).toEqual([
      { name: 'Weekly orders', text: 'List the orders of the week.' },
    ])
    expect((await w.api('GET', '/api/accounts/alpha/ask-presets')).body.defaults).toBe(false)
  })

  it("an empty list removes the account's own presets: the defaults are back", async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await w.api('PUT', '/api/accounts/alpha/ask-presets', { presets: [{ name: 'a', text: 'b' }] })
    const cleared = await w.api('PUT', '/api/accounts/alpha/ask-presets', { presets: [] })
    expect(cleared.body.defaults).toBe(true)
    expect('askPresets' in JSON.parse(readFileSync(accountConfig(w), 'utf8'))).toBe(false)
  })

  it('refuses invalid presets with 422 and the issues, and writes nothing', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    const before = existsSync(accountConfig(w)) ? readFileSync(accountConfig(w), 'utf8') : null
    const bad = await w.api('PUT', '/api/accounts/alpha/ask-presets', { presets: [{ name: ' ', text: 'x' }] })
    expect(bad.status).toBe(422)
    expect(bad.body.error).toBe('invalidConfig')
    expect(JSON.stringify(bad.body.issues)).toContain('askPresets[0].name')
    const long = await w.api('PUT', '/api/accounts/alpha/ask-presets', {
      presets: [{ name: 'n', text: 't'.repeat(4001) }],
    })
    expect(long.status).toBe(422)
    expect(existsSync(accountConfig(w)) ? readFileSync(accountConfig(w), 'utf8') : null).toBe(before)
  })

  it('refuses a body that is not a list, or a list of more than 20', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    for (const bad of [
      undefined,
      null,
      {},
      { presets: 'x' },
      { presets: Array.from({ length: 21 }, () => ({ name: 'n', text: 't' })) },
    ]) {
      expect(await w.api('PUT', '/api/accounts/alpha/ask-presets', bad)).toEqual({
        status: 400,
        body: { error: 'invalidRequest' },
      })
    }
  })

  it('the preset of another account is not touched', async () => {
    const w = await world({ accounts: ['alpha', 'beta'], linked: ['alpha', 'beta'] })
    await w.api('PUT', '/api/accounts/alpha/ask-presets', { presets: [{ name: 'a', text: 'b' }] })
    expect((await w.api('GET', '/api/accounts/beta/ask-presets')).body.defaults).toBe(true)
  })
})
