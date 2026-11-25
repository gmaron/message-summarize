import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { SummarizeResult } from '../../../../src/application/ports/summarizer.js'
import { disposeHarnesses, FakeSummarizer, seedMessages, until } from '../../../support/cli-harness.js'
import { BASE, disposeWorlds, type World, world } from '../../../support/web-world.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

const ANA = '9911963367943@s.whatsapp.net'
const BETO = '9912465397241@s.whatsapp.net'
const SECRET_TEXT = 'PRIVATE-CHAT-TEXT: the plan for friday'
/** A chat with nothing to answer and nothing pending: the digest files it under "the rest". */
const QUIET = { resumen: 'Beto only shared a photo', pendientes: [], necesita_respuesta: false, prioridad: 'baja' }

const url = (id: string, tail = '') => `/api/accounts/${id}/history${tail}`
const answer = (value: unknown, provider = 'claude-cli'): SummarizeResult => ({ ok: true, value, provider })

async function seed(w: World, id: string, chats: readonly [string, string][]): Promise<void> {
  const runtime = w.h.runtime(id)
  try {
    await seedMessages(
      runtime,
      chats.map(([chat, name]) => ({
        id: `${chat}-1`,
        text: SECRET_TEXT,
        conversationId: chat,
        conversationName: name,
        timestamp: Date.now() - 3_600_000,
      })),
    )
  } finally {
    runtime.close()
  }
}

async function digest(w: World, id: string): Promise<void> {
  const before = w.eventsOf('history').length
  w.h.connection.emit({ state: 'connected' })
  await until(() => w.host.daemonOf(id)?.settled === true, 'the connection to settle')
  expect((await w.api('POST', `/api/accounts/${id}/digest`)).status).toBe(202)
  await until(() => w.eventsOf('history').length > before, 'the history event')
}

describe('GET /api/accounts/:id/history (RF-74)', () => {
  it('is behind the token and only for an account that exists', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    expect((await w.api('GET', url('alpha'), undefined, null)).status).toBe(401)
    expect((await w.api('GET', url('alpha', '/1'), undefined, null)).status).toBe(401)
    expect(await w.api('GET', url('ghost'))).toEqual({ status: 404, body: { error: 'notFound' } })
    expect((await w.api('GET', url('ghost', '/1'))).status).toBe(404)
    expect((await w.api('GET', '/api/accounts/..%2Fx/history')).status).toBe(404)
  })

  it('answers an empty history, without creating the database, for an account that has none', async () => {
    const w = await world({ accounts: ['alpha'] })
    const db = w.h.accountOf('alpha').dbFile
    expect(await w.api('GET', url('alpha'))).toEqual({ status: 200, body: { total: 0, items: [] } })
    expect(existsSync(db)).toBe(false)
    expect((await w.api('GET', url('alpha', '/1'))).status).toBe(404)
    expect(existsSync(db)).toBe(false)
  })

  it('lists a run of the web newest first, with providers, duration and counts, and announces it without content', async () => {
    const w = await world({
      accounts: ['alpha'],
      linked: ['alpha'],
      summarizer: new FakeSummarizer(() => answer(QUIET, 'ollama')),
    })
    await seed(w, 'alpha', [[ANA, 'Ana Test']])
    await digest(w, 'alpha')
    const reply = await w.api('GET', url('alpha'))
    expect(reply.status).toBe(200)
    expect(reply.body.total).toBe(1)
    const [item] = reply.body.items as Record<string, unknown>[]
    expect(item).toMatchObject({
      trigger: 'manual',
      outcome: 'committed',
      error: null,
      summarized: 1,
      failed: 0,
      providers: { ollama: 1 },
    })
    expect(Object.keys(item as object).sort()).toEqual(
      [
        'id',
        'trigger',
        'startedAt',
        'finishedAt',
        'durationMs',
        'outcome',
        'error',
        'summarized',
        'failed',
        'providers',
        'digestId',
      ].sort(),
    )
    expect(typeof item?.durationMs).toBe('number')
    expect(w.eventsOf('history').at(-1)?.data).toEqual({ account: 'alpha' })
    // nothing private travels in the events
    expect(JSON.stringify(w.sse)).not.toContain('Ana Test')
    expect(JSON.stringify(w.sse)).not.toContain('PRIVATE-CHAT-TEXT')
  })

  it('lists failed runs, empty windows and a cli run too, and paginates', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    const runtime = w.h.runtime('alpha')
    try {
      for (let n = 0; n < 5; n++) {
        const id = runtime.runs.start(n % 2 === 0 ? 'cli' : 'schedule', 1_000 + n)
        runtime.runs.fail(id, 2_000 + n, n === 4 ? 'noProvider' : 'failed')
      }
    } finally {
      runtime.close()
    }
    const first = await w.api('GET', `${url('alpha')}?limit=2&offset=0`)
    expect(first.body.total).toBe(5)
    expect((first.body.items as { startedAt: number }[]).map((i) => i.startedAt)).toEqual([1_004, 1_003])
    expect((first.body.items as { error: string }[])[0]?.error).toBe('noProvider')
    expect((first.body.items as { durationMs: number }[])[0]?.durationMs).toBe(1_000)
    const last = await w.api('GET', `${url('alpha')}?limit=2&offset=4`)
    expect((last.body.items as { startedAt: number }[]).map((i) => i.startedAt)).toEqual([1_000])
    expect((await w.api('GET', `${url('alpha')}?limit=0`)).body.items).toHaveLength(1)
    expect((await w.api('GET', `${url('alpha')}?limit=9999`)).body.items).toHaveLength(5)
    expect((await w.api('GET', `${url('alpha')}?limit=abc`)).status).toBe(400)
    expect((await w.api('GET', `${url('alpha')}?offset=-1`)).status).toBe(400)
  })

  it('shows an open run with no duration', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    const runtime = w.h.runtime('alpha')
    try {
      runtime.runs.start('schedule', 1_000)
    } finally {
      runtime.close()
    }
    const [item] = (await w.api('GET', url('alpha'))).body.items as Record<string, unknown>[]
    expect(item).toMatchObject({ finishedAt: null, durationMs: null, outcome: null, error: null })
  })
})

describe('GET /api/accounts/:id/history/:runId (RF-36, RF-74)', () => {
  it('gives the COMPLETE digest even when hideRest hid the detail of the delivered message', async () => {
    const w = await world({
      accounts: ['alpha'],
      linked: ['alpha'],
      config: { ...BASE, hideRest: true },
      summarizer: new FakeSummarizer(() => answer(QUIET)),
    })
    await seed(w, 'alpha', [[BETO, 'Beto Test']])
    await digest(w, 'alpha')
    const runtime = w.h.runtime('alpha')
    let delivered: string
    try {
      delivered = runtime.store
        .outbox()
        .map((p) => p.text)
        .join('\n')
    } finally {
      runtime.close()
    }
    // the delivered message only counts "the rest"...
    expect(delivered).not.toContain('Beto only shared a photo')
    const list = await w.api('GET', url('alpha'))
    const { id } = (list.body.items as { id: number }[])[0] as { id: number }
    const detail = await w.api('GET', url('alpha', `/${id}`))
    expect(detail.status).toBe(200)
    // ...while the history keeps it in full
    const text = (detail.body.digest as { text: string }).text
    expect(text).toContain('Beto Test')
    expect(text).toContain('Beto only shared a photo')
    expect(detail.body.digest).toMatchObject({ since: expect.any(Number), until: expect.any(Number) })
    expect(detail.body).toMatchObject({ id, trigger: 'manual', outcome: 'committed', failedConversations: [] })
  })

  it('gives the failed conversations with a reason code, and a null digest when there is none', async () => {
    const w = await world({
      accounts: ['alpha'],
      linked: ['alpha'],
      summarizer: new FakeSummarizer(() => ({ ok: false, error: `claude: ${SECRET_TEXT}` })),
    })
    await seed(w, 'alpha', [[ANA, 'Ana Test']])
    await digest(w, 'alpha')
    const { id } = ((await w.api('GET', url('alpha'))).body.items as { id: number }[])[0] as { id: number }
    const detail = await w.api('GET', url('alpha', `/${id}`))
    expect(detail.body.failedConversations).toEqual([{ id: ANA, name: 'Ana Test', reason: 'failed' }])
    expect(JSON.stringify(detail.body)).not.toContain('PRIVATE-CHAT-TEXT')
    expect(detail.body.failed).toBe(1)
  })

  it('a failed run (noProvider) has its code and no digest', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], summarizer: null })
    await digest(w, 'alpha')
    const { id } = ((await w.api('GET', url('alpha'))).body.items as { id: number }[])[0] as { id: number }
    const detail = await w.api('GET', url('alpha', `/${id}`))
    expect(detail.body).toMatchObject({ outcome: 'failed', error: 'noProvider', digest: null, failedConversations: [] })
  })

  it('is a 404 for a run id that does not exist, is not a number, or belongs to another account', async () => {
    const w = await world({ accounts: ['alpha', 'beta'], linked: ['alpha', 'beta'], start: false })
    const runtime = w.h.runtime('alpha')
    let alphaRun = 0
    try {
      alphaRun = runtime.runs.start('cli', 1)
      runtime.runs.fail(alphaRun, 2, 'failed')
    } finally {
      runtime.close()
    }
    expect((await w.api('GET', url('alpha', `/${alphaRun}`))).status).toBe(200)
    // the same id on the other account: that account has no such run
    expect(await w.api('GET', url('beta', `/${alphaRun}`))).toEqual({ status: 404, body: { error: 'notFound' } })
    expect((await w.api('GET', url('alpha', '/999'))).status).toBe(404)
    expect((await w.api('GET', url('alpha', '/abc'))).status).toBe(404)
    expect((await w.api('GET', url('alpha', '/1%3B%20DROP'))).status).toBe(404)
    expect((await w.api('GET', url('alpha', '/-1'))).status).toBe(404)
  })
})

describe('the history event for runs the digest events do not tell about', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

  it('announces a run recorded by another process, and a stale one closed as interrupted, with no content', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await until(() => w.host.daemonOf('alpha') !== undefined, 'the unit')
    // the host looks at the history on its own looks: the first one only learns how it stands
    await settle()
    expect(w.eventsOf('history')).toEqual([])
    const other = w.h.runtime('alpha')
    try {
      other.runs.start('cli', Date.now())
    } finally {
      other.close()
    }
    await until(() => w.eventsOf('history').length === 1, 'the event for the run of another process')
    expect(w.eventsOf('history')[0]?.data).toEqual({ account: 'alpha' })

    const again = w.h.runtime('alpha')
    let staleId = 0
    try {
      staleId = again.runs.start('schedule', Date.now() - 2 * 3_600_000)
    } finally {
      again.close()
    }
    await until(() => w.eventsOf('history').length >= 2, 'the event for the stale run')
    const detail = await w.api('GET', url('alpha', `/${staleId}`))
    expect(detail.body).toMatchObject({ outcome: 'failed', error: 'interrupted' })
    expect(JSON.stringify(w.eventsOf('history'))).not.toContain('interrupted')
  })

  it('does not announce its own digest twice', async () => {
    const w = await world({
      accounts: ['alpha'],
      linked: ['alpha'],
      summarizer: new FakeSummarizer(() => answer(QUIET)),
    })
    await seed(w, 'alpha', [[ANA, 'Ana Test']])
    await digest(w, 'alpha')
    await settle()
    expect(w.eventsOf('history')).toHaveLength(1)
  })
})
