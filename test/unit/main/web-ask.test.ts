import { afterEach, describe, expect, it } from 'vitest'
import { err, ok } from '../../../src/domain/result.js'
import { disposeHarnesses, FakeSummarizer, SUMMARY, seedMessages, until } from '../../support/cli-harness.js'
import { disposeWorlds, type World, world } from '../../support/web-world.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

const PRIVATE_TEXT = 'PRIVATE-CHAT-TEXT: Ana wants a loan of 500'

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
const body = { question: 'who asked me for money?', period: 'h24' }

describe('POST /api/accounts/:id/ask', () => {
  it('answers 202 at once, publishes an ask event without the text, and keeps the answer for the GET', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha')
    await running(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/ask', body, null)).status).toBe(401)

    expect(await w.api('POST', '/api/accounts/alpha/ask', { ...body, chats: [' ana ', ''] })).toEqual({
      status: 202,
      body: { id: 1 },
    })
    await until(() => w.eventsOf('ask').length === 1, 'the ask event')
    expect(w.eventsOf('ask')[0]?.data).toEqual({ account: 'alpha', id: 1, state: 'done' })
    expect(JSON.stringify(w.sse)).not.toContain(PRIVATE_TEXT)
    expect(JSON.stringify(w.sse)).not.toContain(SUMMARY.resumen)

    const asks = await asksOf(w, 'alpha')
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({
      id: 1,
      question: 'who asked me for money?',
      period: 'h24',
      chats: ['ana'],
      state: 'done',
      consulted: 1,
      failedChats: 0,
    })
    expect(asks[0]?.items).toMatchObject([{ answer: SUMMARY.resumen, needsReply: true }])
    // the system prompt of the request carries the question and the transcript has the chat
    const sent = w.summarizer().requests[0] as { systemPrompt: string; transcript: string }
    expect(sent.systemPrompt).toContain('who asked me for money?')
    expect(sent.transcript).toContain(PRIVATE_TEXT)
    // nothing was sent to any chat
    expect(w.h.connection.sent).toEqual([])
  })

  it('omits the conversations that answer "-"', async () => {
    const summarizer = new FakeSummarizer(() => ok({ ...SUMMARY, resumen: '-' }))
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], summarizer })
    await seed(w, 'alpha')
    await running(w, 'alpha')
    await w.api('POST', '/api/accounts/alpha/ask', body)
    await until(() => w.eventsOf('ask').length === 1, 'the ask event')
    expect((await asksOf(w, 'alpha'))[0]).toMatchObject({ state: 'done', consulted: 1, items: [] })
  })

  it('counts a failed conversation instead of failing the request', async () => {
    const summarizer = new FakeSummarizer(() => err('provider down'))
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], summarizer })
    await seed(w, 'alpha')
    await running(w, 'alpha')
    await w.api('POST', '/api/accounts/alpha/ask', body)
    await until(() => w.eventsOf('ask').length === 1, 'the ask event')
    expect((await asksOf(w, 'alpha'))[0]).toMatchObject({ state: 'done', consulted: 1, failedChats: 1, items: [] })
  })

  it('answers 409 busy while one runs, and accepts another after it ends', async () => {
    let open: () => void = () => {}
    const wait = new Promise<void>((resolve) => {
      open = resolve
    })
    const summarizer = new FakeSummarizer(async () => {
      await wait
      return ok(SUMMARY)
    })
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], summarizer })
    await seed(w, 'alpha')
    await running(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/ask', body)).status).toBe(202)
    expect(await w.api('POST', '/api/accounts/alpha/ask', body)).toEqual({ status: 409, body: { error: 'busy' } })
    open()
    await until(() => w.eventsOf('ask').length === 1, 'the ask event')
    expect((await w.api('POST', '/api/accounts/alpha/ask', body)).status).toBe(202)
  })

  it('answers 409 notRunning when the account has no running unit', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    expect(await w.api('POST', '/api/accounts/alpha/ask', body)).toEqual({ status: 409, body: { error: 'notRunning' } })
    expect(w.summarizer().requests).toHaveLength(0)
  })

  it('rejects a question over 1000 characters after trimming, and accepts one of exactly 1000', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha')
    await running(w, 'alpha')
    const ask = (question: string) => w.api('POST', '/api/accounts/alpha/ask', { question, period: 'h24' })
    expect(await ask('q'.repeat(1001))).toEqual({
      status: 400,
      body: { error: 'questionTooLong' },
    })
    expect((await ask(` ${'q'.repeat(1000)} `)).status).toBe(202)
  })

  it('answers 404 for an account that does not exist', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect((await w.api('POST', '/api/accounts/nope/ask', body)).status).toBe(404)
    expect((await w.api('GET', '/api/accounts/nope/asks')).status).toBe(404)
    expect((await w.api('DELETE', '/api/accounts/nope/asks/1')).status).toBe(404)
  })

  it('validates the body', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await running(w, 'alpha')
    const post = (b: unknown) => w.api('POST', '/api/accounts/alpha/ask', b)
    for (const bad of [
      undefined,
      null,
      [],
      'text',
      { period: 'h24' },
      { question: 5, period: 'h24' },
      { question: 'x' },
      { question: 'x', period: 'month' },
      { question: 'x', period: 'h24', chats: 'ana' },
      { question: 'x', period: 'h24', chats: [1] },
      { question: 'x', period: 'h24', chats: Array.from({ length: 21 }, (_, i) => `c${i}`) },
    ]) {
      expect(await post(bad)).toEqual({ status: 400, body: { error: 'invalidRequest' } })
    }
    expect(await post({ question: '   ', period: 'h24' })).toEqual({ status: 400, body: { error: 'emptyQuestion' } })
    expect(w.summarizer().requests).toHaveLength(0)
  })

  it('accepts every period', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha')
    await running(w, 'alpha')
    let n = 0
    for (const period of ['today', 'h24', 'd3', 'd7']) {
      expect((await w.api('POST', '/api/accounts/alpha/ask', { question: 'x', period })).status).toBe(202)
      n += 1
      await until(() => w.eventsOf('ask').length === n, 'the ask event')
    }
  })

  it('trims and caps each chat filter', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha')
    await running(w, 'alpha')
    await w.api('POST', '/api/accounts/alpha/ask', { ...body, chats: [`  ${'a'.repeat(300)}  `] })
    await until(() => w.eventsOf('ask').length === 1, 'the ask event')
    expect((await asksOf(w, 'alpha'))[0]?.chats).toEqual(['a'.repeat(100)])
  })
})

describe('GET and DELETE /api/accounts/:id/asks', () => {
  it('lists newest first and deletes one by id', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha')
    await running(w, 'alpha')
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
