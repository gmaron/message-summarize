import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../../../src/domain/result.js'
import { makeSchedule } from '../../../src/domain/schedule.js'
import { nextRunOf } from '../../../src/infrastructure/scheduling/croner-scheduler.js'
import { disposeHarnesses, FakeSummarizer, SUMMARY, seedMessages, until, waitFor } from '../../support/cli-harness.js'
import { BASE, disposeWorlds, type World, world } from '../../support/web-world.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

const url = (id: string) => `/api/accounts/${id}/settings`
const started = (w: World, id: string) => until(() => w.host.daemonOf(id) !== undefined, `the unit of ${id}`)
const accountFile = (w: World, id: string) => w.h.accountOf(id).configFile
const readAccount = (w: World, id: string) =>
  JSON.parse(readFileSync(accountFile(w, id), 'utf8')) as Record<string, unknown>
const configOf = (w: World, id: string) => w.host.runtimeOf(id)?.config
const named = (w: World, event: string) =>
  w.h.logs.map((l) => JSON.parse(l) as { event: string }).filter((e) => e.event === event)

/** The last `accounts` snapshot's view of an account. */
function latest(w: World, id: string): Record<string, unknown> | undefined {
  const accounts = w.eventsOf('accounts').at(-1)?.data.accounts as Record<string, unknown>[] | undefined
  return accounts?.find((a) => a.id === id)
}

describe('GET and PUT /api/accounts/:id/settings (RF-73)', () => {
  it('is behind the token and only for an account that exists', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect((await w.api('GET', url('alpha'), undefined, null)).status).toBe(401)
    expect((await w.api('PUT', url('alpha'), {}, null)).status).toBe(401)
    expect(await w.api('GET', url('ghost'))).toEqual({ status: 404, body: { error: 'notFound' } })
    expect((await w.api('PUT', url('ghost'), {})).status).toBe(404)
    expect((await w.api('GET', '/api/accounts/..%2Fx/settings')).status).toBe(404)
  })

  it('says the effective values, where each comes from, and what can be chosen', async () => {
    const w = await world({
      accounts: ['alpha'],
      config: { ...BASE, hideRest: true, provider: { primary: 'claude-cli', claudeCli: { model: 'opus' } } },
    })
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ unreadOnly: true, language: 'es' }))
    const reply = await w.api('GET', url('alpha'))
    expect(reply.status).toBe(200)
    expect(reply.body.values).toEqual({
      language: 'es',
      timezone: 'UTC',
      ownerName: null,
      unreadOnly: true,
      flagUnsaved: false,
      hideRest: true,
      maxCharsPerConversation: 24000,
      defaultWindowHours: 24,
      concurrency: 4,
      provider: {
        primary: 'claude-cli',
        backup: null,
        claudeCli: { model: 'opus', timeoutMs: 180000 },
        ollama: { baseUrl: 'http://127.0.0.1:11434', model: null },
      },
    })
    expect(reply.body.sources).toMatchObject({
      unreadOnly: 'account',
      language: 'account',
      hideRest: 'installation',
      timezone: 'installation',
      'provider.primary': 'installation',
      'provider.claudeCli.model': 'installation',
      flagUnsaved: 'default',
      maxCharsPerConversation: 'default',
      'provider.ollama.model': 'default',
    })
    expect(reply.body.options).toEqual({ providers: ['claude-cli', 'ollama'], languages: ['es', 'en'] })
  })

  it('writes the patch into the ACCOUNT file only, answers with the new settings and leaves other accounts alone', async () => {
    const w = await world({ accounts: ['alpha', 'beta'] })
    const rootBefore = readFileSync(w.h.layout.configFile, 'utf8')
    const reply = await w.api('PUT', url('alpha'), {
      unreadOnly: true,
      flagUnsaved: true,
      maxCharsPerConversation: 5000,
      language: 'es',
      provider: { claudeCli: { model: 'opus' } },
    })
    expect(reply.status).toBe(200)
    expect(reply.body.values).toMatchObject({
      unreadOnly: true,
      language: 'es',
      provider: { claudeCli: { model: 'opus' } },
    })
    expect(reply.body.sources).toMatchObject({
      unreadOnly: 'account',
      'provider.claudeCli.model': 'account',
      hideRest: 'default',
    })
    expect(readAccount(w, 'alpha')).toEqual({
      unreadOnly: true,
      flagUnsaved: true,
      maxCharsPerConversation: 5000,
      language: 'es',
      provider: { claudeCli: { model: 'opus' } },
    })
    expect(readFileSync(w.h.layout.configFile, 'utf8')).toBe(rootBefore)
    // Same as a fresh GET, and the other account is as it was.
    expect((await w.api('GET', url('alpha'))).body).toEqual(reply.body)
    const beta = await w.api('GET', url('beta'))
    expect(beta.body.values).toMatchObject({ unreadOnly: false, language: 'en' })
    expect(beta.body.sources).toMatchObject({ unreadOnly: 'default' })
  })

  it('a partial patch keeps what was set before, and null gives the value back to the installation', async () => {
    const w = await world({ accounts: ['alpha'] })
    await w.api('PUT', url('alpha'), {
      hideRest: true,
      ownerName: 'Ana Test',
      provider: { claudeCli: { model: 'opus' } },
    })
    const reply = await w.api('PUT', url('alpha'), {
      hideRest: null,
      ownerName: null,
      provider: { claudeCli: { model: null } },
    })
    expect(reply.status).toBe(200)
    expect(readAccount(w, 'alpha')).toEqual({})
    expect(reply.body.sources).toMatchObject({ hideRest: 'default', ownerName: 'default' })
    // For the provider, null is a choice of its own: "none", stored as such.
    const none = await w.api('PUT', url('alpha'), { provider: { primary: null } })
    expect(none.status).toBe(200)
    expect(readAccount(w, 'alpha')).toEqual({ provider: { primary: null } })
    expect((none.body.values as { provider: { primary: unknown } }).provider.primary).toBeNull()
    // An empty patch is a no-op that answers with the settings.
    expect((await w.api('PUT', url('alpha'), {})).status).toBe(200)
  })

  it('refuses a value that is not valid with 422 and the option and code of each problem, and writes nothing', async () => {
    const w = await world({ accounts: ['alpha'] })
    await w.api('PUT', url('alpha'), { hideRest: true })
    const before = readFileSync(accountFile(w, 'alpha'), 'utf8')
    const reply = await w.api('PUT', url('alpha'), {
      timezone: 'Mars/Olympus',
      language: 'fr',
      maxCharsPerConversation: 0,
      defaultWindowHours: 1.5,
      concurrency: -2,
      provider: { primary: 'gpt', ollama: { model: '' } },
      ownerName: '  ',
    })
    expect(reply.status).toBe(422)
    expect(reply.body.error).toBe('invalidConfig')
    const issues = reply.body.issues as { option: string; code: string; allowed?: string[]; file?: string }[]
    expect(issues).toEqual(
      expect.arrayContaining([
        { option: 'timezone', code: 'invalidTimezone' },
        { option: 'language', code: 'notOneOf', allowed: ['es', 'en'] },
        { option: 'maxCharsPerConversation', code: 'notPositive' },
        { option: 'concurrency', code: 'notPositive' },
        { option: 'provider.primary', code: 'notOneOf', allowed: ['claude-cli', 'ollama'] },
        { option: 'provider.ollama.model', code: 'emptyString' },
        { option: 'ownerName', code: 'emptyString' },
      ]),
    )
    // The file the problem comes from is not part of what the page sees.
    expect(issues.every((issue) => issue.file === undefined)).toBe(true)
    expect(readFileSync(accountFile(w, 'alpha'), 'utf8')).toBe(before)
    // The result as a whole must be valid: a backup needs a primary, Ollama needs a model.
    const noModel = await w.api('PUT', url('alpha'), { provider: { backup: 'ollama' } })
    expect(noModel.body.issues).toEqual([{ option: 'provider.ollama.model', code: 'required' }])
  })

  it('answers 400 for a body that is not an object, a key that is not editable, or a value of the wrong type', async () => {
    const w = await world({ accounts: ['alpha'] })
    const bad: unknown[] = [
      [],
      'x',
      null,
      { nope: 1 },
      { excludePatterns: ['x'] },
      { localOnlyPatterns: ['x'] },
      { promptFile: 'p.txt' },
      { schedules: [] },
      { web: { port: 1 } },
      { provider: { claudeCli: { command: 'rm' } } },
      { provider: { ollama: { numCtx: 1 } } },
      { provider: 'claude-cli' },
      { provider: { nope: 1 } },
      { unreadOnly: 'yes' },
      { hideRest: 1 },
      { maxCharsPerConversation: '5' },
      { language: 1 },
      { timezone: true },
      { 'provider.primary': 'ollama' },
      { __proto__x: 1 },
    ]
    for (const body of bad) {
      expect(await w.api('PUT', url('alpha'), body), JSON.stringify(body)).toEqual({
        status: 400,
        body: { error: 'invalidRequest' },
      })
    }
    expect(existsSync(accountFile(w, 'alpha'))).toBe(false)
  })

  it('keeps the privacy lists of the account file untouched', async () => {
    const w = await world({
      accounts: ['alpha'],
      config: { ...BASE, provider: { primary: 'claude-cli', ollama: { model: 'llama3' } } },
    })
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ localOnlyPatterns: ['Family'], excludePatterns: ['Spam'] }))
    expect((await w.api('PUT', url('alpha'), { hideRest: true })).status).toBe(200)
    expect(readAccount(w, 'alpha')).toEqual({
      localOnlyPatterns: ['Family'],
      excludePatterns: ['Spam'],
      hideRest: true,
    })
  })

  it('reports the issues on GET when a hand edit made the configuration invalid', async () => {
    const w = await world({ accounts: ['alpha'] })
    writeFileSync(accountFile(w, 'alpha'), '{ "hideRest": ')
    expect(await w.api('GET', url('alpha'))).toEqual({
      status: 422,
      body: { error: 'invalidConfig', issues: [{ option: '(config)', code: 'invalidJson' }] },
    })
    const put = await w.api('PUT', url('alpha'), { hideRest: true })
    expect(put.status).toBe(422)
    expect(readFileSync(accountFile(w, 'alpha'), 'utf8')).toBe('{ "hideRest": ')
  })
})

describe('a change of the settings applies to the running unit without reconnecting (RF-73, RF-62)', () => {
  const connectionCalls = (w: World) => w.h.connection.calls.filter((call) => call === 'start' || call === 'stop')

  it('through the API: language, time zone, unreadOnly and provider, the socket untouched', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], config: BASE })
    await started(w, 'alpha')
    w.h.connection.emit({ state: 'connected' })
    const runtime = w.host.runtimeOf('alpha')
    expect(runtime?.config).toMatchObject({ language: 'en', timezone: 'UTC' })
    const daemon = w.host.daemonOf('alpha') as unknown as { scheduler: { timezone: string } }
    const reply = await w.api('PUT', url('alpha'), {
      language: 'es',
      timezone: 'America/Argentina/Buenos_Aires',
      unreadOnly: true,
      provider: { primary: 'ollama', ollama: { model: 'llama3' } },
    })
    expect(reply.status).toBe(200)
    // Applied by the time the answer is here: the same unit, the same runtime, the new values.
    expect(w.host.runtimeOf('alpha')).toBe(runtime)
    expect(runtime?.config).toMatchObject({
      language: 'es',
      timezone: 'America/Argentina/Buenos_Aires',
      digest: { unreadOnly: true },
      provider: { primary: 'ollama' },
    })
    expect(daemon.scheduler.timezone).toBe('America/Argentina/Buenos_Aires')
    expect(connectionCalls(w)).toEqual(['start'])
    expect(named(w, 'config.applied')).toHaveLength(1)
    // The accounts event goes out with the new time zone and language.
    await waitFor(() =>
      expect(latest(w, 'alpha')).toMatchObject({ timezone: 'America/Argentina/Buenos_Aires', language: 'es' }),
    )
  })

  it('moves the next run with the time zone, keeping the same schedules', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], config: BASE })
    const made = makeSchedule([0, 1, 2, 3, 4, 5, 6], '09:00')
    if (!made.ok) throw new Error('schedule')
    w.installation.schedules.add('alpha', made.value)
    await started(w, 'alpha')
    await until(
      () => (w.host.daemonOf('alpha') as unknown as { scheduler: { count: number } }).scheduler.count === 1,
      'the schedule',
    )
    const daemon = w.host.daemonOf('alpha') as unknown as {
      scheduler: {
        expressions: string[]
        nextRuns(from: Date): { next: Date | null }[]
        generationOf(e: string): number | undefined
      }
    }
    const expression = daemon.scheduler.expressions[0] as string
    const utc = daemon.scheduler.nextRuns(new Date())[0]?.next?.getTime()
    expect(utc).toBe(nextRunOf(expression, 'UTC', new Date())?.getTime())
    await waitFor(() => expect(latest(w, 'alpha')?.nextRun).toBe(utc))

    const reply = await w.api('PUT', url('alpha'), { timezone: 'America/Argentina/Buenos_Aires' })
    expect(reply.status).toBe(200)
    const buenosAires = nextRunOf(expression, 'America/Argentina/Buenos_Aires', new Date())?.getTime()
    expect(buenosAires).not.toBe(utc)
    expect(daemon.scheduler.expressions).toEqual([expression])
    expect(daemon.scheduler.nextRuns(new Date())[0]?.next?.getTime()).toBe(buenosAires)
    await waitFor(() => expect(latest(w, 'alpha')?.nextRun).toBe(buenosAires))
    expect(connectionCalls(w)).toEqual(['start'])
  })

  it('a digest in progress keeps the configuration it started with, and the next one uses the new one', async () => {
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const summarizer = new FakeSummarizer(async () => {
      await gate
      return ok(SUMMARY)
    })
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], config: BASE, summarizer })
    const runtime = w.h.runtime('alpha')
    try {
      await seedMessages(runtime, [{ id: 'a-1', text: 'dinner on friday', timestamp: Date.now() - 3_600_000 }])
    } finally {
      runtime.close()
    }
    await started(w, 'alpha')
    w.h.connection.emit({ state: 'connected' })
    await until(() => w.host.daemonOf('alpha')?.settled === true, 'the connection to settle')
    expect((await w.api('POST', `/api/accounts/alpha/digest`)).status).toBe(202)
    await until(() => w.summarizer().requests.length === 1, 'the digest to reach the summarizer')

    expect((await w.api('PUT', url('alpha'), { language: 'es' })).status).toBe(200)
    open()
    await until(() => w.h.connection.sent.length > 0, 'the first delivery')
    expect(w.h.connection.sent.join('\n')).toContain('WhatsApp summary')
    expect(w.h.connection.sent.join('\n')).not.toContain('Resumen WhatsApp')

    const again = w.h.runtime('alpha')
    try {
      await new Promise((resolve) => setTimeout(resolve, 20))
      await seedMessages(again, [{ id: 'a-2', text: 'lunch on saturday', timestamp: Date.now() }])
    } finally {
      again.close()
    }
    const sentBefore = w.h.connection.sent.length
    expect((await w.api('POST', `/api/accounts/alpha/digest`)).status).toBe(202)
    await until(() => w.h.connection.sent.length > sentBefore, 'the second delivery')
    expect(w.h.connection.sent.slice(sentBefore).join('\n')).toContain('Resumen WhatsApp')
    expect(connectionCalls(w)).toEqual(['start'])
  })

  it('a config file edited by hand is applied by the next look, with the socket untouched', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], config: BASE })
    await started(w, 'alpha')
    w.h.connection.emit({ state: 'connected' })
    const runtime = w.host.runtimeOf('alpha')
    writeFileSync(
      accountFile(w, 'alpha'),
      JSON.stringify({ language: 'es', unreadOnly: true, timezone: 'America/Montevideo' }),
    )
    await waitFor(() => expect(configOf(w, 'alpha')).toMatchObject({ language: 'es', timezone: 'America/Montevideo' }))
    expect(w.host.runtimeOf('alpha')).toBe(runtime)
    expect(configOf(w, 'alpha')?.digest.unreadOnly).toBe(true)
    expect((w.host.daemonOf('alpha') as unknown as { scheduler: { timezone: string } }).scheduler.timezone).toBe(
      'America/Montevideo',
    )

    // The installation's file counts too, for an option the account does not set.
    writeFileSync(w.h.layout.configFile, JSON.stringify({ ...BASE, hideRest: true }))
    await waitFor(() => expect(configOf(w, 'alpha')?.digest.hideRest).toBe(true))
    await waitFor(() => expect(latest(w, 'alpha')).toMatchObject({ timezone: 'America/Montevideo', language: 'es' }))
    expect(connectionCalls(w)).toEqual(['start'])
  })

  it('an invalid hand edit keeps the last valid configuration, logs once, shows the issues, and a fix applies', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], config: BASE })
    await started(w, 'alpha')
    w.h.connection.emit({ state: 'connected' })
    expect((await w.api('PUT', url('alpha'), { language: 'es' })).status).toBe(200)
    writeFileSync(
      accountFile(w, 'alpha'),
      JSON.stringify({ language: 'es', timezone: 'Mars/Olympus', maxCharsPerConversation: 0 }),
    )
    await waitFor(() => expect(named(w, 'account.configInvalid')).toHaveLength(1))
    await waitFor(() => expect(latest(w, 'alpha')?.configValid).toBe(false))
    expect(latest(w, 'alpha')?.configIssues).toEqual(
      expect.arrayContaining([
        { option: 'timezone', code: 'invalidTimezone' },
        { option: 'maxCharsPerConversation', code: 'notPositive' },
      ]),
    )
    // Still the last valid one, and quiet: the same problem is not logged on every look.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(configOf(w, 'alpha')).toMatchObject({ language: 'es', timezone: 'UTC' })
    expect(named(w, 'account.configInvalid')).toHaveLength(1)
    expect(w.host.daemonOf('alpha')?.blocked).toBeNull()

    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ language: 'en', timezone: 'America/Montevideo' }))
    await waitFor(() => expect(configOf(w, 'alpha')).toMatchObject({ language: 'en', timezone: 'America/Montevideo' }))
    await waitFor(() => expect(latest(w, 'alpha')).toMatchObject({ configValid: true, configIssues: [] }))
    expect(connectionCalls(w)).toEqual(['start'])
  })

  it('an idle account that config kept from starting is started by the next look once the file is fixed', async () => {
    const w = await world({ accounts: ['beta'], linked: ['beta'], config: BASE, start: false })
    writeFileSync(accountFile(w, 'beta'), '{ "language": ')
    await w.host.start()
    expect(w.host.daemonOf('beta')).toBeUndefined()
    expect(w.host.accountState('beta')?.state).toBe('idle')
    expect((await w.api('GET', '/api/accounts')).body.accounts).toMatchObject([{ id: 'beta', configValid: false }])
    writeFileSync(accountFile(w, 'beta'), JSON.stringify({ language: 'es' }))
    await started(w, 'beta')
    expect(w.host.runtimeOf('beta')?.config.language).toBe('es')
    expect(w.h.connection.calls.filter((call) => call === 'start')).toHaveLength(1)
  })

  it('serializes refreshes: an older read is never applied after a newer one, and a PUT waits for a look in progress', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], config: BASE })
    await started(w, 'alpha')
    // The first read of the files is slow (as if the disk stalled): without a queue, the second would finish first.
    const host = w.host as unknown as { loadConfig(root: string, account: string): Promise<unknown> }
    const real = host.loadConfig.bind(host)
    let calls = 0
    host.loadConfig = async (root, account) => {
      const mine = ++calls
      const result = await real(root, account)
      if (mine === 1) await new Promise((resolve) => setTimeout(resolve, 250))
      return result
    }
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ language: 'es' }))
    const look = w.host.reloadConfig('alpha') // reads { language: 'es' }, slowly
    await until(() => calls === 1, 'the first read to start')
    // The PUT goes in while that look is in progress: it adds to the file, and applies what the FILE says by the time it answers.
    const reply = await w.api('PUT', url('alpha'), { unreadOnly: true })
    expect(reply.status).toBe(200)
    expect(configOf(w, 'alpha')).toMatchObject({ language: 'es', digest: { unreadOnly: true } })
    await look
    expect(configOf(w, 'alpha')).toMatchObject({ language: 'es', digest: { unreadOnly: true } })

    // Two refreshes with files that differ: the last one written wins, whatever the order they finish in.
    calls = 0
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ language: 'es', hideRest: true }))
    const older = w.host.reloadConfig('alpha')
    await until(() => calls === 1, 'the older read to start')
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ language: 'en', flagUnsaved: true, ownerName: 'Test' }))
    await Promise.all([older, w.host.reloadConfig('alpha')])
    expect(configOf(w, 'alpha')).toMatchObject({ language: 'en', digest: { hideRest: false, flagUnsaved: true } })
    await new Promise((resolve) => setTimeout(resolve, 100)) // the periodic looks do not undo it either
    expect(configOf(w, 'alpha')).toMatchObject({ language: 'en', digest: { hideRest: false, flagUnsaved: true } })
  })

  it('an invalid edit that ADDS privacy entries makes the unit stricter, never looser', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], config: BASE })
    await started(w, 'alpha')
    const runtime = w.host.runtimeOf('alpha')
    if (runtime === undefined) throw new Error('no runtime')
    const messages = () => (runtime.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
    expect(runtime?.config.localOnlyPatterns).toEqual([])
    // Invalid (a bad time zone, and no Ollama model for the local-only list) but it does add entries.
    writeFileSync(
      accountFile(w, 'alpha'),
      JSON.stringify({
        timezone: 'Mars/Olympus',
        localOnlyPatterns: ['Family'],
        excludePatterns: ['Spam'],
        hideRest: true,
      }),
    )
    await waitFor(() => expect(named(w, 'account.configInvalid')).toHaveLength(1))
    await waitFor(() => expect(runtime?.config.localOnlyPatterns).toEqual(['Family']))
    // The rest is the last valid configuration.
    expect(runtime?.config).toMatchObject({ timezone: 'UTC', digest: { excludePatterns: ['Spam'], hideRest: false } })
    // An excluded chat is not captured any more.
    if (runtime === undefined) throw new Error('no runtime')
    await seedMessages(runtime, [
      { id: 's1', text: 'buy now', conversationName: 'Spam Group', timestamp: Date.now() - 1000 },
    ])
    expect(messages()).toBe(0)
    await seedMessages(runtime, [
      { id: 'f1', text: 'hello', conversationName: 'Ana Test', timestamp: Date.now() - 900 },
    ])
    expect(messages()).toBe(1)

    // A further invalid edit adds more; one that REMOVES entries does not loosen anything while it is invalid.
    writeFileSync(
      accountFile(w, 'alpha'),
      JSON.stringify({ timezone: 'Mars/Olympus', localOnlyPatterns: ['Work'], excludePatterns: 'Spam' }),
    )
    await waitFor(() => expect(runtime?.config.localOnlyPatterns).toEqual(['Family', 'Work']))
    expect(runtime?.config.digest.excludePatterns).toEqual(['Spam'])
    // Not JSON at all: nothing is added, nothing is lost.
    writeFileSync(accountFile(w, 'alpha'), '{ "localOnlyPatterns": ')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(runtime?.config.localOnlyPatterns).toEqual(['Family', 'Work'])
    expect(w.h.connection.calls.filter((call) => call === 'start')).toHaveLength(1)
  })

  it('a configuration that cannot be applied is logged once, and applied when it can', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], config: BASE })
    await started(w, 'alpha')
    const daemon = w.host.daemonOf('alpha')
    if (daemon === undefined) throw new Error('no daemon')
    const real = daemon.applyConfig.bind(daemon)
    daemon.applyConfig = () => {
      throw new Error('boom')
    }
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ language: 'es' }))
    await waitFor(() => expect(named(w, 'config.reloadFailed')).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 200)) // many looks later, still one line
    expect(named(w, 'config.reloadFailed')).toHaveLength(1)
    daemon.applyConfig = real
    await waitFor(() => expect(configOf(w, 'alpha')?.language).toBe('es'))
  })

  it('refuses an Ollama address that is not an http(s) URL with invalidUrl', async () => {
    const w = await world({ accounts: ['alpha'] })
    const reply = await w.api('PUT', url('alpha'), { provider: { ollama: { baseUrl: 'ollama.lan:11434' } } })
    expect(reply.status).toBe(422)
    expect(reply.body.issues).toEqual([{ option: 'provider.ollama.baseUrl', code: 'invalidUrl' }])
    const lan = await w.api('PUT', url('alpha'), { provider: { ollama: { baseUrl: 'http://192.168.1.20:11434' } } })
    expect(lan.status).toBe(200)
  })
})
