import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../../../../src/domain/result.js'
import {
  disposeHarnesses,
  FakeSummarizer,
  SUMMARY,
  seedMessages,
  until,
  waitFor,
} from '../../../support/cli-harness.js'
import { BASE, disposeWorlds, type World, world } from '../../../support/web-world.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

const ANA = '9911963367943@s.whatsapp.net'
const BETO = '9912465397241@s.whatsapp.net'
const GROUP = '120363146125332922@g.us'
/** Its id contains the one of NUMBER (the substring trap). */
const NUMBER = '9922979713568@s.whatsapp.net'
const LONGER = '19922979713568@s.whatsapp.net'
const SECRET_TEXT = 'PRIVATE-CHAT-TEXT: the plan for friday'

/** A configuration with an Ollama model: "local only" needs one. */
const WITH_OLLAMA = { ...BASE, provider: { primary: 'claude-cli', ollama: { model: 'llama-test' } } }

const url = (id: string, cid?: string) =>
  cid === undefined
    ? `/api/accounts/${id}/conversations`
    : `/api/accounts/${id}/conversations/${encodeURIComponent(cid)}/marks`
const started = (w: World, id: string) => until(() => w.host.daemonOf(id) !== undefined, `the unit of ${id}`)
const accountFile = (w: World, id: string) => w.h.accountOf(id).configFile
const readAccount = (w: World, id: string) =>
  JSON.parse(readFileSync(accountFile(w, id), 'utf8')) as Record<string, unknown>

async function seed(
  w: World,
  id: string,
  chats: readonly { id: string; name: string; messages?: number; timestamp?: number }[],
): Promise<void> {
  const runtime = w.h.runtime(id)
  try {
    for (const chat of chats) {
      await seedMessages(
        runtime,
        Array.from({ length: chat.messages ?? 1 }, (_, n) => ({
          id: `${chat.id}-${n}`,
          text: SECRET_TEXT,
          conversationId: chat.id,
          conversationName: chat.name,
          ...(chat.timestamp === undefined ? {} : { timestamp: chat.timestamp + n }),
        })),
      )
    }
  } finally {
    runtime.close()
  }
}

/** Rows of a query on the account's database (a connection of its own, closed after). */
function rows(w: World, id: string, sql: string): Record<string, unknown>[] {
  const runtime = w.h.runtime(id)
  try {
    return runtime.db.prepare(sql).all() as Record<string, unknown>[]
  } finally {
    runtime.close()
  }
}

const ids = (body: Record<string, unknown>) => (body.items as { id: string }[]).map((item) => item.id)

describe('GET /api/accounts/:id/conversations (RF-72)', () => {
  it('is behind the token and only for an account that exists', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    expect((await w.api('GET', url('alpha'), undefined, null)).status).toBe(401)
    expect((await w.api('PUT', url('alpha', ANA), { excluded: true }, null)).status).toBe(401)
    expect(await w.api('GET', url('ghost'))).toEqual({ status: 404, body: { error: 'notFound' } })
    expect((await w.api('PUT', url('ghost', ANA), { excluded: true })).status).toBe(404)
    expect((await w.api('GET', '/api/accounts/..%2Fx/conversations')).status).toBe(404)
  })

  it('lists newest first with the name, the numbers and the marks, in the shape the page reads', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    await seed(w, 'alpha', [
      { id: ANA, name: 'Ana Test', messages: 3, timestamp: 1_000 },
      { id: BETO, name: 'Beto Test', messages: 1, timestamp: 5_000 },
    ])
    const reply = await w.api('GET', url('alpha'))
    expect(reply.status).toBe(200)
    expect(reply.body.total).toBe(2)
    expect(reply.body.timezone).toBe('UTC')
    expect(reply.body.localAvailable).toBe(false)
    expect(reply.body.unlisted).toEqual([])
    expect(reply.body.items).toEqual([
      {
        id: BETO,
        name: 'Beto Test',
        isGroup: false,
        address: '+9911963367943',
        lastMessageAt: 5_000,
        messages: 1,
        unread: { kind: 'unknown' },
        excluded: false,
        localOnly: false,
        marks: { excluded: null, localOnly: null },
      },
      expect.objectContaining({ id: ANA, name: 'Ana Test', messages: 3, lastMessageAt: 1_002 }),
    ])
  })

  it('answers an empty list, without creating the database, for an account that has none', async () => {
    const w = await world({ accounts: ['alpha'] })
    const db = w.h.accountOf('alpha').dbFile
    expect(existsSync(db)).toBe(false)
    const reply = await w.api('GET', url('alpha'))
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ total: 0, items: [], unlisted: [] })
    expect(existsSync(db)).toBe(false)
  })

  it('reads the running unit database too', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha', [{ id: ANA, name: 'Ana Test' }])
    await started(w, 'alpha')
    expect(ids((await w.api('GET', url('alpha'))).body)).toEqual([ANA])
  })

  it('searches by name and address; % and _ are plain characters', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    await seed(w, 'alpha', [
      { id: ANA, name: 'Ana Test' },
      { id: BETO, name: '100% Beto' },
      { id: GROUP, name: 'a_b' },
      { id: NUMBER, name: 'axb' },
    ])
    const search = async (q: string) => ids((await w.api('GET', `${url('alpha')}?q=${encodeURIComponent(q)}`)).body)
    expect(await search('ana')).toEqual([ANA])
    expect(await search('ANA')).toEqual([ANA])
    expect(await search('%')).toEqual([BETO])
    expect(await search('_')).toEqual([GROUP])
    expect(await search('a_b')).toEqual([GROUP])
    expect(await search('%%')).toEqual([])
    expect(await search('+99')).toHaveLength(4)
    const none = await w.api('GET', `${url('alpha')}?q=zzz`)
    expect(none.body).toMatchObject({ total: 0, items: [] })
  })

  it('pages with limit and offset, and refuses numbers that are not', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    const chats = Array.from({ length: 5 }, (_, n) => ({
      id: `99571313112${n}0@s.whatsapp.net`,
      name: `Chat ${n}`,
      timestamp: 1_000 + n * 100,
    }))
    await seed(w, 'alpha', chats)
    const first = await w.api('GET', `${url('alpha')}?limit=2`)
    const second = await w.api('GET', `${url('alpha')}?limit=2&offset=2`)
    const third = await w.api('GET', `${url('alpha')}?limit=2&offset=4`)
    expect(first.body.total).toBe(5)
    expect([...ids(first.body), ...ids(second.body), ...ids(third.body)]).toEqual(chats.map((c) => c.id).reverse())
    expect(ids((await w.api('GET', `${url('alpha')}?limit=100000`)).body)).toHaveLength(5)
    for (const bad of ['limit=-1', 'limit=abc', 'offset=1.5', 'limit=1e3']) {
      expect(await w.api('GET', `${url('alpha')}?${bad}`)).toEqual({ status: 400, body: { error: 'invalidRequest' } })
    }
  })

  it('refuses to answer when the configuration is not valid', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ timezone: 'Not/AZone' }))
    expect(await w.api('GET', url('alpha'))).toEqual({ status: 422, body: { error: 'invalidConfig' } })
  })
})

describe('PUT /api/accounts/:id/conversations/:cid/marks (RF-14, RF-43, RF-72)', () => {
  it('marks a chat local only and removes the mark; it writes the ACCOUNT file with the exact id form', async () => {
    const w = await world({ accounts: ['alpha', 'beta'], linked: ['alpha'], config: WITH_OLLAMA })
    await seed(w, 'alpha', [
      { id: ANA, name: 'Ana Test' },
      { id: BETO, name: 'Beto Test' },
    ])
    await started(w, 'alpha')
    const rootBefore = readFileSync(w.h.layout.configFile, 'utf8')

    const on = await w.api('PUT', url('alpha', ANA), { localOnly: true })
    expect(on).toEqual({
      status: 200,
      body: {
        id: ANA,
        excluded: false,
        localOnly: true,
        marks: { excluded: null, localOnly: 'account' },
        deletedMessages: 0,
      },
    })
    expect(readAccount(w, 'alpha')).toMatchObject({ localOnlyPatterns: [`id:${ANA}`] })
    expect(readFileSync(w.h.layout.configFile, 'utf8')).toBe(rootBefore)
    expect(existsSync(accountFile(w, 'beta'))).toBe(false)
    const listed = (await w.api('GET', url('alpha'))).body.items as Record<string, unknown>[]
    expect(listed.find((item) => item.id === ANA)).toMatchObject({ localOnly: true, marks: { localOnly: 'account' } })
    expect(listed.find((item) => item.id === BETO)).toMatchObject({ localOnly: false })

    // putting it again changes nothing; then it is removed
    await w.api('PUT', url('alpha', ANA), { localOnly: true })
    expect(readAccount(w, 'alpha').localOnlyPatterns).toEqual([`id:${ANA}`])
    const off = await w.api('PUT', url('alpha', ANA), { localOnly: false })
    expect(off.body).toMatchObject({ localOnly: false, marks: { localOnly: null } })
    expect(readAccount(w, 'alpha').localOnlyPatterns).toEqual([])
  })

  it('does not mistake a chat whose id contains another one (the exact id form)', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false, config: WITH_OLLAMA })
    await seed(w, 'alpha', [
      { id: NUMBER, name: 'Short Test' },
      { id: LONGER, name: 'Long Test' },
    ])
    await w.api('PUT', url('alpha', NUMBER), { localOnly: true })
    const items = (await w.api('GET', url('alpha'))).body.items as { id: string; localOnly: boolean }[]
    expect(items.find((i) => i.id === NUMBER)?.localOnly).toBe(true)
    expect(items.find((i) => i.id === LONGER)?.localOnly).toBe(false)
  })

  it('shows what a pattern or the installation marks as not removable, and answers 409 matchedByPattern', async () => {
    const w = await world({
      accounts: ['alpha'],
      linked: ['alpha'],
      start: false,
      config: { ...WITH_OLLAMA, excludePatterns: ['gym'], localOnlyPatterns: [`id:${BETO}`] },
    })
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ excludePatterns: ['ana'] }))
    await seed(w, 'alpha', [
      { id: ANA, name: 'Ana Test' },
      { id: BETO, name: 'Beto Test' },
      { id: GROUP, name: 'Gym Fuerza' },
    ])
    const items = (await w.api('GET', url('alpha'))).body.items as Record<string, unknown>[]
    const byId = (id: string) => items.find((i) => i.id === id)
    expect(byId(ANA)).toMatchObject({ excluded: true, marks: { excluded: 'pattern', localOnly: null } })
    expect(byId(GROUP)).toMatchObject({ excluded: true, marks: { excluded: 'pattern' } })
    expect(byId(BETO)).toMatchObject({ excluded: false, localOnly: true, marks: { localOnly: 'pattern' } })
    const before = readFileSync(accountFile(w, 'alpha'), 'utf8')
    for (const [cid, body] of [
      [ANA, { excluded: false }],
      [GROUP, { excluded: false }],
      [BETO, { localOnly: false }],
    ] as const) {
      expect(await w.api('PUT', url('alpha', cid), body)).toEqual({ status: 409, body: { error: 'matchedByPattern' } })
    }
    expect(readFileSync(accountFile(w, 'alpha'), 'utf8')).toBe(before)
  })

  it('asks to confirm before an exclusion deletes stored messages, then deletes them and nothing else', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha', [
      { id: ANA, name: 'Ana Test', messages: 3 },
      { id: BETO, name: 'Beto Test', messages: 2 },
    ])
    await started(w, 'alpha')
    const db = w.host.runtimeOf('alpha')?.db
    db?.prepare('INSERT INTO digest_pointer (id, pointer) VALUES (1, 42)').run()
    db?.prepare(
      'INSERT INTO digests (since, until, created_at, text, summarized, failed) VALUES (1, 2, 3, ?, 1, 0)',
    ).run('digest text')
    db?.prepare('INSERT INTO outbox (text, created_at) VALUES (?, 3)').run('queued part')

    const asked = await w.api('PUT', url('alpha', ANA), { excluded: true })
    expect(asked).toEqual({ status: 409, body: { error: 'confirmRequired', messages: 3 } })
    expect(existsSync(accountFile(w, 'alpha'))).toBe(false)
    expect(rows(w, 'alpha', 'SELECT id FROM messages')).toHaveLength(5)

    const done = await w.api('PUT', url('alpha', ANA), { excluded: true, confirmDelete: true })
    expect(done).toEqual({
      status: 200,
      body: {
        id: ANA,
        excluded: true,
        localOnly: false,
        marks: { excluded: 'account', localOnly: null },
        deletedMessages: 3,
      },
    })
    expect(readAccount(w, 'alpha').excludePatterns).toEqual([`id:${ANA}`])
    expect(rows(w, 'alpha', 'SELECT conversation_id FROM messages').every((r) => r.conversation_id === BETO)).toBe(true)
    expect(rows(w, 'alpha', 'SELECT id FROM conversations')).toEqual([{ id: BETO }])
    // participants stay (shared); the pointer, the digests and the outbox are untouched
    expect(
      rows(w, 'alpha', 'SELECT id FROM participants')
        .map((r) => r.id)
        .sort(),
    ).toEqual([ANA, BETO])
    expect(rows(w, 'alpha', 'SELECT pointer FROM digest_pointer')).toEqual([{ pointer: 42 }])
    expect(rows(w, 'alpha', 'SELECT text FROM digests')).toEqual([{ text: 'digest text' }])
    expect(rows(w, 'alpha', 'SELECT text FROM outbox')).toEqual([{ text: 'queued part' }])

    // it is not a stored chat any more: it shows in `unlisted`, where the mark can be removed
    const after = (await w.api('GET', url('alpha'))).body
    expect(ids(after)).toEqual([BETO])
    expect(after.total).toBe(1)
    expect(after.unlisted).toEqual([
      { id: ANA, excluded: true, localOnly: false, marks: { excluded: 'account', localOnly: null } },
    ])
  })

  it('needs no confirmation when nothing is stored, and excluding twice is harmless', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    const runtime = w.h.runtime('alpha')
    await runtime.capture.conversationMetadata({
      conversation: { id: GROUP, isGroup: true, name: 'Empty Group', participantId: null, address: 'g' },
    })
    runtime.close()
    expect((await w.api('PUT', url('alpha', GROUP), { excluded: true })).status).toBe(200)
    expect(await w.api('PUT', url('alpha', GROUP), { excluded: true })).toMatchObject({ status: 200 })
    expect(readAccount(w, 'alpha').excludePatterns).toEqual([`id:${GROUP}`])
    expect(rows(w, 'alpha', 'SELECT id FROM conversations')).toEqual([])
  })

  it('stops capturing the chat at once, and a later message of it stores nothing', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha', [{ id: ANA, name: 'Ana Test', messages: 2 }])
    await started(w, 'alpha')
    expect((await w.api('PUT', url('alpha', ANA), { excluded: true, confirmDelete: true })).status).toBe(200)
    await waitFor(() => expect(w.host.runtimeOf('alpha')?.config.digest.excludePatterns).toEqual([`id:${ANA}`]))
    const runtime = w.host.runtimeOf('alpha')
    if (runtime === undefined) throw new Error('no runtime')
    await seedMessages(runtime, [
      { id: 'later-1', text: SECRET_TEXT, conversationId: ANA, conversationName: 'Ana Test' },
    ])
    // other chats are still captured
    await seedMessages(runtime, [{ id: 'other-1', text: 'ok', conversationId: BETO, conversationName: 'Beto Test' }])
    expect(rows(w, 'alpha', 'SELECT conversation_id, id FROM messages')).toEqual([
      { conversation_id: BETO, id: 'other-1' },
    ])
    // The chat excluded by its id is not stored again: no content, and not even its name
    expect(rows(w, 'alpha', 'SELECT id FROM conversations')).toEqual([{ id: BETO }])
    expect((await w.api('GET', url('alpha'))).body.unlisted).toHaveLength(1)
  })

  it('removes an exclusion from the unlisted chat; an unknown chat is a 404', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    await seed(w, 'alpha', [{ id: ANA, name: 'Ana Test', messages: 1 }])
    await w.api('PUT', url('alpha', ANA), { excluded: true, confirmDelete: true })
    expect((await w.api('GET', url('alpha'))).body.unlisted).toHaveLength(1)
    const back = await w.api('PUT', url('alpha', ANA), { excluded: false })
    expect(back).toMatchObject({ status: 200, body: { excluded: false, marks: { excluded: null } } })
    expect(readAccount(w, 'alpha').excludePatterns).toEqual([])
    expect((await w.api('GET', url('alpha'))).body.unlisted).toEqual([])
    // nothing came back: un-excluding restores nothing
    expect(rows(w, 'alpha', 'SELECT id FROM messages')).toEqual([])
    expect(await w.api('PUT', url('alpha', ANA), { excluded: false })).toEqual({
      status: 404,
      body: { error: 'notFound' },
    })
    expect((await w.api('PUT', url('alpha', 'nobody@s.whatsapp.net'), { localOnly: true })).status).toBe(404)
  })

  it('works with no running unit (a temporary connection) and for an account with no database', async () => {
    const w = await world({ accounts: ['alpha', 'beta'], linked: ['alpha'], start: false })
    await seed(w, 'alpha', [{ id: ANA, name: 'Ana Test', messages: 2 }])
    expect(w.host.runtimeOf('alpha')).toBeUndefined()
    expect((await w.api('PUT', url('alpha', ANA), { excluded: true, confirmDelete: true })).body).toMatchObject({
      deletedMessages: 2,
    })
    expect(rows(w, 'alpha', 'SELECT id FROM messages')).toEqual([])
    const noDb = await w.api('PUT', url('beta', ANA), { excluded: true })
    expect(noDb).toEqual({ status: 404, body: { error: 'notFound' } })
    expect(existsSync(w.h.accountOf('beta').dbFile)).toBe(false)
  })

  it('refuses a body that is not what it expects', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    await seed(w, 'alpha', [{ id: ANA, name: 'Ana Test' }])
    for (const body of [
      {},
      { confirmDelete: true },
      { excluded: 'yes' },
      { localOnly: 1 },
      { excluded: true, extra: 1 },
      [],
      'x',
    ]) {
      expect(await w.api('PUT', url('alpha', ANA), body)).toEqual({ status: 400, body: { error: 'invalidRequest' } })
    }
    expect(existsSync(accountFile(w, 'alpha'))).toBe(false)
  })

  it('refuses to mark local only without an Ollama model, and writes nothing', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    await seed(w, 'alpha', [{ id: ANA, name: 'Ana Test' }])
    const reply = await w.api('PUT', url('alpha', ANA), { localOnly: true })
    expect(reply.status).toBe(422)
    expect(reply.body).toMatchObject({
      error: 'invalidConfig',
      issues: [{ option: 'provider.ollama.model', code: 'required' }],
    })
    expect(existsSync(accountFile(w, 'alpha'))).toBe(false)
  })

  it('keeps the other options of the file, and two marks at once both land', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], config: WITH_OLLAMA })
    await seed(w, 'alpha', [
      { id: ANA, name: 'Ana Test' },
      { id: BETO, name: 'Beto Test' },
    ])
    await started(w, 'alpha')
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ unreadOnly: true, excludePatterns: ['gym'] }))
    const replies = await Promise.all([
      w.api('PUT', url('alpha', ANA), { localOnly: true }),
      w.api('PUT', url('alpha', BETO), { localOnly: true }),
      w.api('PUT', url('alpha', ANA), { excluded: true, confirmDelete: true }),
    ])
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200])
    const file = readAccount(w, 'alpha')
    expect(file.unreadOnly).toBe(true)
    expect(file.excludePatterns).toEqual(['gym', `id:${ANA}`])
    expect([...(file.localOnlyPatterns as string[])].sort()).toEqual([`id:${ANA}`, `id:${BETO}`])
  })

  it('the settings API keeps refusing the privacy lists', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    expect((await w.api('PUT', `/api/accounts/alpha/settings`, { excludePatterns: ['x'] })).status).toBe(400)
    expect((await w.api('PUT', `/api/accounts/alpha/settings`, { localOnlyPatterns: ['x'] })).status).toBe(400)
  })

  it('keeps names, ids and texts out of the logs and the events', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], config: WITH_OLLAMA })
    await seed(w, 'alpha', [{ id: ANA, name: 'Ana Test', messages: 2 }])
    await started(w, 'alpha')
    await w.api('GET', url('alpha'))
    await w.api('PUT', url('alpha', ANA), { localOnly: true })
    await w.api('PUT', url('alpha', ANA), { excluded: true, confirmDelete: true })
    const logs = w.h.logs.join('\n')
    expect(logs).toContain('"event":"conversation.marked"')
    expect(logs).toContain('"event":"conversation.purged"')
    for (const secret of ['Ana Test', '9911963367943', SECRET_TEXT]) {
      expect(logs).not.toContain(secret)
      expect(JSON.stringify(w.sse)).not.toContain(secret)
    }
  })
})

const LID = '99900000001@lid'

describe('marks and the two ids of one person (a LID and the phone number)', () => {
  it('marks every known id of the chat, and a message under the other id is dropped (excluded)', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha', [
      { id: LID, name: 'Ana Test', messages: 2 },
      { id: BETO, name: 'Beto Test' },
    ])
    await started(w, 'alpha')
    w.h.connection.aliasPairs.push([LID, ANA])
    const asked = await w.api('PUT', url('alpha', LID), { excluded: true })
    expect(asked).toEqual({ status: 409, body: { error: 'confirmRequired', messages: 2 } })
    expect((await w.api('PUT', url('alpha', LID), { excluded: true, confirmDelete: true })).status).toBe(200)
    expect(readAccount(w, 'alpha').excludePatterns).toEqual([`id:${LID}`, `id:${ANA}`])
    await waitFor(() => expect(w.host.runtimeOf('alpha')?.config.digest.excludePatterns).toHaveLength(2))
    const runtime = w.host.runtimeOf('alpha')
    if (runtime === undefined) throw new Error('no runtime')
    // the same person now arrives under the phone number
    await seedMessages(runtime, [{ id: 'n1', text: SECRET_TEXT, conversationId: ANA, conversationName: 'Ana Test' }])
    await seedMessages(runtime, [{ id: 'n2', text: 'ok', conversationId: BETO, conversationName: 'Beto Test' }])
    expect(rows(w, 'alpha', 'SELECT DISTINCT conversation_id FROM messages')).toEqual([{ conversation_id: BETO }])
    // and the mark is removed from both
    expect((await w.api('PUT', url('alpha', LID), { excluded: false })).status).toBe(200)
    expect(readAccount(w, 'alpha').excludePatterns).toEqual([])
  })

  it('also deletes what is stored under the other id when excluding', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha', [
      { id: LID, name: 'Ana Test', messages: 2 },
      { id: ANA, name: 'Ana Test', messages: 3 },
    ])
    await started(w, 'alpha')
    w.h.connection.aliasPairs.push([LID, ANA])
    expect(await w.api('PUT', url('alpha', LID), { excluded: true })).toEqual({
      status: 409,
      body: { error: 'confirmRequired', messages: 5 },
    })
    const done = await w.api('PUT', url('alpha', LID), { excluded: true, confirmDelete: true })
    expect(done.body).toMatchObject({ deletedMessages: 5 })
    expect(rows(w, 'alpha', 'SELECT id FROM messages')).toEqual([])
  })

  it('an id learned LATER is covered: the mark of one id is put on the other before its first message', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], config: WITH_OLLAMA })
    await seed(w, 'alpha', [
      { id: LID, name: 'Ana Test', messages: 1 },
      { id: BETO, name: 'Beto Test', messages: 1 },
    ])
    await started(w, 'alpha')
    // nothing is known of an alias when the chats are marked
    await w.api('PUT', url('alpha', LID), { excluded: true, confirmDelete: true })
    await w.api('PUT', url('alpha', BETO), { localOnly: true })
    expect(readAccount(w, 'alpha')).toMatchObject({ excludePatterns: [`id:${LID}`], localOnlyPatterns: [`id:${BETO}`] })
    // content of the same person arrived under the phone number before the pair was known
    const runtime = w.host.runtimeOf('alpha')
    if (runtime === undefined) throw new Error('no runtime')
    await seedMessages(runtime, [{ id: 'early', text: SECRET_TEXT, conversationId: ANA, conversationName: 'Ana Test' }])
    expect(rows(w, 'alpha', 'SELECT id FROM messages WHERE conversation_id = ?'.replace('?', `'${ANA}'`))).toHaveLength(
      1,
    )

    // the platform learns the pairs: the host covers them, and what was stored under the new id is deleted
    await w.h.connection.learnAlias(LID, ANA)
    await w.h.connection.learnAlias('99900000002@lid', BETO)
    const file = readAccount(w, 'alpha')
    expect(file.excludePatterns).toEqual([`id:${LID}`, `id:${ANA}`])
    expect(file.localOnlyPatterns).toEqual([`id:${BETO}`, 'id:99900000002@lid'])
    expect(w.host.runtimeOf('alpha')?.config.digest.excludePatterns).toEqual([`id:${LID}`, `id:${ANA}`])
    expect(rows(w, 'alpha', `SELECT id FROM messages WHERE conversation_id = '${ANA}'`)).toEqual([])
    // and the next message under the number is not stored
    await seedMessages(runtime, [{ id: 'later', text: SECRET_TEXT, conversationId: ANA, conversationName: 'Ana Test' }])
    expect(rows(w, 'alpha', `SELECT id FROM messages WHERE conversation_id = '${ANA}'`)).toEqual([])
    // a pair that touches no mark changes nothing
    const before = readFileSync(accountFile(w, 'alpha'), 'utf8')
    await w.h.connection.learnAlias('99900000003@lid', '9912752183123@s.whatsapp.net')
    expect(readFileSync(accountFile(w, 'alpha'), 'utf8')).toBe(before)
    expect(w.h.logs.join('\n')).toContain('"event":"conversation.aliasCovered"')
  })
})

describe('applying a mark', () => {
  it('answers 503 notApplied and deletes nothing when the unit could not apply the change', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha', [{ id: ANA, name: 'Ana Test', messages: 2 }])
    await started(w, 'alpha')
    const runtime = w.host.runtimeOf('alpha')
    if (runtime === undefined) throw new Error('no runtime')
    runtime.reconfigure = () => {
      throw new Error('cannot reconfigure')
    }
    expect(await w.api('PUT', url('alpha', ANA), { excluded: true, confirmDelete: true })).toEqual({
      status: 503,
      body: { error: 'notApplied' },
    })
    // the file stays written, nothing was deleted
    expect(readAccount(w, 'alpha').excludePatterns).toEqual([`id:${ANA}`])
    expect(rows(w, 'alpha', 'SELECT id FROM messages')).toHaveLength(2)
  })

  it('refuses to exclude (409 busy) while a preview of the account runs, and allows it afterwards', async () => {
    let release: () => void = () => {}
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const summarizer = new FakeSummarizer(async () => {
      await wait
      return ok(SUMMARY)
    })
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], summarizer })
    await seed(w, 'alpha', [{ id: ANA, name: 'Ana Test', messages: 2, timestamp: Date.now() - 3_600_000 }])
    await started(w, 'alpha')
    expect((await w.api('POST', '/api/accounts/alpha/preview')).status).toBe(202)
    await until(() => summarizer.requests.length > 0, 'the preview to reach the summarizer')
    expect(await w.api('PUT', url('alpha', ANA), { excluded: true, confirmDelete: true })).toEqual({
      status: 409,
      body: { error: 'busy' },
    })
    expect(existsSync(accountFile(w, 'alpha'))).toBe(false)
    expect(rows(w, 'alpha', 'SELECT id FROM messages')).toHaveLength(2)
    release()
    await until(() => w.eventsOf('preview').length === 1, 'the preview')
    expect((await w.api('PUT', url('alpha', ANA), { excluded: true, confirmDelete: true })).status).toBe(200)
  })

  it('refuses to exclude (409 busy) while a digest of the account runs', async () => {
    let release: () => void = () => {}
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const summarizer = new FakeSummarizer(async () => {
      await wait
      return ok(SUMMARY)
    })
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], summarizer })
    await seed(w, 'alpha', [{ id: ANA, name: 'Ana Test', messages: 1, timestamp: Date.now() - 3_600_000 }])
    await started(w, 'alpha')
    w.h.connection.emit({ state: 'connected' })
    await until(() => w.host.daemonOf('alpha')?.settled === true, 'the connection to settle')
    expect((await w.api('POST', '/api/accounts/alpha/digest')).status).toBe(202)
    await until(() => w.host.isDigestBusy('alpha'), 'the digest to run')
    expect((await w.api('PUT', url('alpha', ANA), { excluded: true, confirmDelete: true })).body).toEqual({
      error: 'busy',
    })
    // a local-only mark is fine meanwhile: nothing is deleted
    release()
    await until(() => w.eventsOf('digest').some((e) => e.data.state === 'done'), 'the digest')
  })

  it('re-checks busy right at the deletion: a digest that started meanwhile keeps the data, the mark stays', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, 'alpha', [{ id: ANA, name: 'Ana Test', messages: 2 }])
    await started(w, 'alpha')
    let calls = 0
    // not busy at the first look, busy by the time of the deletion
    w.host.addBusyCheck(() => ++calls > 1)
    const reply = await w.api('PUT', url('alpha', ANA), { excluded: true, confirmDelete: true })
    expect(reply).toEqual({ status: 409, body: { error: 'busy' } })
    expect(readAccount(w, 'alpha').excludePatterns).toEqual([`id:${ANA}`])
    expect(w.host.runtimeOf('alpha')?.config.digest.excludePatterns).toEqual([`id:${ANA}`])
    expect(rows(w, 'alpha', 'SELECT id FROM messages')).toHaveLength(2)
  })

  it('compares ids without case and ignores spaces, as the matcher does', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false, config: WITH_OLLAMA })
    await seed(w, 'alpha', [{ id: GROUP, name: 'Gym', messages: 1 }])
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ localOnlyPatterns: [`ID: ${GROUP.toUpperCase()} `] }))
    const item = (await w.api('GET', url('alpha'))).body.items as Record<string, unknown>[]
    expect(item[0]).toMatchObject({ localOnly: true, marks: { localOnly: 'account' } })
    // removing takes the entry out although it is written differently, and adding does not repeat it
    await w.api('PUT', url('alpha', GROUP), { localOnly: true })
    expect(readAccount(w, 'alpha').localOnlyPatterns).toHaveLength(1)
    await w.api('PUT', url('alpha', GROUP), { localOnly: false })
    expect(readAccount(w, 'alpha').localOnlyPatterns).toEqual([])
  })

  it('a configuration with "id:" and nothing after is invalid', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ excludePatterns: ['id:'] }))
    expect(await w.api('GET', url('alpha'))).toEqual({ status: 422, body: { error: 'invalidConfig' } })
  })
})

describe('the running unit summarizer (RF-43, live)', () => {
  /** A fake Ollama: answers every chat with a valid summary and records the transcripts it was sent. */
  async function fakeOllama() {
    const requests: string[] = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        requests.push(body)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ message: { content: JSON.stringify(SUMMARY) } }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    return { requests, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
  }

  it('a local-only mark makes the NEXT digest of the same running unit use the local provider only for that chat', async () => {
    const ollama = await fakeOllama()
    try {
      // The external provider is a command that always fails: a chat that reaches it ends up failed.
      const w = await world({
        accounts: ['alpha'],
        linked: ['alpha'],
        realProviders: true,
        config: {
          ...BASE,
          provider: {
            primary: 'claude-cli',
            claudeCli: { command: 'false' },
            ollama: { model: 'llama-test', baseUrl: ollama.baseUrl },
          },
        },
      })
      const at = Date.now() - 3_600_000
      await seed(w, 'alpha', [
        { id: ANA, name: 'Ana Test', timestamp: at },
        { id: BETO, name: 'Beto Test', timestamp: at },
      ])
      await started(w, 'alpha')
      const previewOf = async (count: number) => {
        expect((await w.api('POST', '/api/accounts/alpha/preview')).status).toBe(202)
        await until(() => w.eventsOf('preview').length === count, 'the preview')
        return (await w.api('GET', '/api/accounts/alpha/preview')).body
      }
      expect(await previewOf(1)).toMatchObject({ summarized: 0, failed: 2 })
      expect(ollama.requests).toHaveLength(0)

      expect((await w.api('PUT', url('alpha', ANA), { localOnly: true })).status).toBe(200)
      expect(await previewOf(2)).toMatchObject({ summarized: 1, failed: 1 })
      expect(ollama.requests).toHaveLength(1)
      expect(ollama.requests[0]).toContain(SECRET_TEXT)
      expect(ollama.requests[0]).not.toContain('Beto Test')
    } finally {
      await ollama.close()
    }
  })
})
