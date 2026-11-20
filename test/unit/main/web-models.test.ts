import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { storeApiKey } from '../../../src/infrastructure/secrets/index.js'
import {
  MODEL_CACHE_MS,
  MODEL_FAILURE_MS,
  type ModelsView,
  modelCatalog,
  unknownModelIn,
} from '../../../src/main/web-models.js'
import { disposeHarnesses } from '../../support/cli-harness.js'
import { BASE, disposeWorlds, type World, world } from '../../support/web-world.js'

// The only server this file starts is a fake Ollama on 127.0.0.1; everything else goes through a fake fetch.

// Made up: shaped like a key, worth nothing.
const KEY = 'sk-test-AAAAAAAAAAAAAAAAAAAAAAAA-FAKE'

const servers: Server[] = []
afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** A fake Ollama: `/api/tags` answers `models` (or a 500). */
async function fakeOllama(models: string[] | 'fail') {
  const server = createServer((req, res) => {
    req.resume()
    if (models === 'fail') {
      res.statusCode = 500
      res.end('{}')
      return
    }
    res.end(JSON.stringify({ models: models.map((name) => ({ name })) }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

interface Answer {
  status?: number
  body?: unknown
  throws?: boolean
}
/** A fetch whose answer can change between calls, and that counts them. */
function scriptedFetch(answers: { current: Answer }) {
  const urls: string[] = []
  const fn = (async (input: unknown) => {
    urls.push(String(input))
    if (answers.current.throws) throw new Error(`connect failed with ${KEY}`)
    return new Response(JSON.stringify(answers.current.body ?? {}), { status: answers.current.status ?? 200 })
  }) as typeof fetch
  return { fn, urls }
}

const ANTHROPIC_OK = {
  data: [
    { id: 'claude-a', display_name: 'Claude A', created_at: '2025-01-01T00:00:00Z' },
    { id: 'claude-b', display_name: 'Claude B', created_at: '2026-01-01T00:00:00Z' },
  ],
}

async function catalogOf(w: World, fetchFn: typeof fetch, now: () => number = Date.now) {
  const catalog = modelCatalog({ ctx: w.h.ctx, installation: w.installation, host: w.host }, { fetchFn, now })
  const list = async (provider: string, body: Record<string, unknown> = {}, id = 'alpha'): Promise<ModelsView> => {
    const route = catalog.routes[0]
    if (route === undefined) throw new Error('no route')
    const result = await route.handler({ params: { id, provider }, query: new URLSearchParams(), body })
    return result.body as ModelsView
  }
  return { catalog, list }
}

describe('POST /api/accounts/:id/models/:provider', () => {
  it('is behind the token, and 404 for an account or a provider that does not exist', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect((await w.api('POST', '/api/accounts/alpha/models/claude-cli', {}, null)).status).toBe(401)
    expect((await w.api('POST', '/api/accounts/alpha/models/claude-cli', {}, 'wrong')).status).toBe(401)
    expect((await w.api('POST', '/api/accounts/ghost/models/claude-cli', {})).status).toBe(404)
    expect((await w.api('POST', '/api/accounts/alpha/models/nope', {})).status).toBe(404)
  })

  it('gives the fixed aliases of Claude Code, with no network', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect(await w.api('POST', '/api/accounts/alpha/models/claude-cli', {})).toEqual({
      status: 200,
      body: {
        provider: 'claude-cli',
        source: 'static',
        models: [
          { id: 'sonnet', name: 'Sonnet' },
          { id: 'opus', name: 'Opus' },
          { id: 'haiku', name: 'Haiku' },
        ],
      },
    })
  })

  it('gives the models installed on the Ollama of the account, or says why it cannot', async () => {
    const url = await fakeOllama(['qwen3:4b', 'llama3.2:latest'])
    const w = await world({
      accounts: ['alpha'],
      config: { ...BASE, provider: { primary: 'ollama', ollama: { baseUrl: url, model: 'qwen3:4b' } } },
    })
    const reply = await w.api('POST', '/api/accounts/alpha/models/ollama', {})
    expect(reply.body).toMatchObject({
      source: 'live',
      models: [{ id: 'qwen3:4b' }, { id: 'llama3.2:latest' }],
      origin: url,
    })
    expect(reply.body.error).toBeUndefined()

    const none = await fakeOllama([])
    expect((await w.api('POST', '/api/accounts/alpha/models/ollama', { baseUrl: none })).body).toMatchObject({
      models: [],
      error: 'empty',
    })
    const broken = await fakeOllama('fail')
    expect((await w.api('POST', '/api/accounts/alpha/models/ollama', { baseUrl: broken })).body).toMatchObject({
      models: [],
      error: 'unreachable',
    })
    expect((await w.api('POST', '/api/accounts/alpha/models/ollama', { baseUrl: 'not-a-url' })).body).toMatchObject({
      models: [],
      error: 'invalidAddress',
    })
  })
})

describe('the models of an API provider', () => {
  it('waits for a key: no request, no list', async () => {
    const w = await world({ accounts: ['alpha'] })
    const answers = { current: { body: ANTHROPIC_OK } }
    const { fn, urls } = scriptedFetch(answers)
    const { list } = await catalogOf(w, fn)
    expect(await list('anthropic')).toEqual({ provider: 'anthropic', source: 'live', models: [], error: 'noKey' })
    expect(urls).toEqual([])
  })

  it('asks with the saved key, sorts, caches for ten minutes per key, and never shows the key', async () => {
    const w = await world({ accounts: ['alpha'] })
    await storeApiKey(w.h.layout.secretsFile, 'anthropic', KEY)
    const answers = { current: { body: ANTHROPIC_OK } as Answer }
    const { fn, urls } = scriptedFetch(answers)
    let time = 1_000
    const { list } = await catalogOf(w, fn, () => time)
    const first = await list('anthropic')
    expect(first).toEqual({
      provider: 'anthropic',
      source: 'live',
      models: [
        { id: 'claude-b', name: 'Claude B' },
        { id: 'claude-a', name: 'Claude A' },
      ],
    })
    expect(JSON.stringify(first)).not.toContain(KEY)
    await list('anthropic')
    expect(urls).toHaveLength(1)
    // "Look again" asks again.
    await list('anthropic', { refresh: true })
    expect(urls).toHaveLength(2)
    time += MODEL_CACHE_MS - 1
    await list('anthropic')
    expect(urls).toHaveLength(2)
    time += 2
    await list('anthropic')
    expect(urls).toHaveLength(3)
    // Another key is another list.
    await storeApiKey(w.h.layout.secretsFile, 'anthropic', 'sk-test-BBBBBBBBBBBBBBBBBBBBBBBB-FAKE')
    await list('anthropic')
    expect(urls).toHaveLength(4)
  })

  it('has a fallback list for Anthropic only: Gemini shows the error, never a made-up list', async () => {
    const w = await world({ accounts: ['alpha'] })
    await storeApiKey(w.h.layout.secretsFile, 'gemini', KEY)
    await storeApiKey(w.h.layout.secretsFile, 'anthropic', KEY)
    const answers = { current: { status: 500 } as Answer }
    const { fn, urls } = scriptedFetch(answers)
    let time = 0
    const { list } = await catalogOf(w, fn, () => time)
    const failed = await list('gemini')
    expect(failed).toEqual({ provider: 'gemini', source: 'live', models: [], error: 'failed' })
    expect(JSON.stringify(failed)).not.toContain(KEY)
    await list('gemini')
    expect(urls).toHaveLength(1)
    time += MODEL_FAILURE_MS + 1
    answers.current = { throws: true }
    const unreachable = await list('gemini')
    expect(unreachable).toEqual({ provider: 'gemini', source: 'live', models: [], error: 'unreachable' })
    expect(JSON.stringify(unreachable)).not.toContain(KEY)
    expect(urls).toHaveLength(2)
    // A rejected key is said as such (the page tells the user to save the key again).
    time += MODEL_FAILURE_MS + 1
    answers.current = { status: 401 }
    expect(await list('gemini')).toEqual({ provider: 'gemini', source: 'live', models: [], error: 'rejected' })
    // Anthropic does have its known models, marked as such.
    const known = await list('anthropic')
    expect(known).toMatchObject({ provider: 'anthropic', source: 'fallback', error: 'rejected' })
    expect(known.models.map((m) => m.id)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'])
    expect(JSON.stringify(known)).not.toContain(KEY)
  })

  it('lists OpenAI filtered, and for a compatible server lets a name be typed when there is no list', async () => {
    const w = await world({ accounts: ['alpha'] })
    await storeApiKey(w.h.layout.secretsFile, 'openai', KEY)
    const answers = {
      current: {
        body: {
          data: [
            { id: 'gpt-4o', created: 2 },
            { id: 'whisper-1', created: 3 },
          ],
        },
      } as Answer,
    }
    const { fn } = scriptedFetch(answers)
    const { list } = await catalogOf(w, fn)
    expect(await list('openai')).toMatchObject({ source: 'live', models: [{ id: 'gpt-4o' }] })
    answers.current = { status: 500 }
    // OpenAI has no list of known models: the error, with nothing to choose and no typing box.
    expect(await list('openai', { refresh: true })).toEqual({
      provider: 'openai',
      source: 'live',
      models: [],
      error: 'failed',
      origin: 'https://api.openai.com',
    })

    const other = await world({
      accounts: ['alpha'],
      config: { ...BASE, provider: { primary: 'openai', openai: { baseUrl: 'http://localhost:1234/v1', model: 'm' } } },
    })
    const compat = scriptedFetch({ current: { status: 404 } })
    const { list: listCompat } = await catalogOf(other, compat.fn)
    expect(await listCompat('openai')).toEqual({
      provider: 'openai',
      source: 'live',
      models: [],
      error: 'failed',
      origin: 'http://localhost:1234',
      typing: true,
    })
    // The OpenAI key is never sent to it: only its own key (here none) is looked up.
    expect(compat.urls).toEqual(['http://localhost:1234/v1/models'])
  })
})

describe('a model must be one of the list', () => {
  it('accepts anything while no list is known, then only what the last list has', async () => {
    const w = await world({ accounts: ['alpha'] })
    await storeApiKey(w.h.layout.secretsFile, 'anthropic', KEY)
    const { fn } = scriptedFetch({ current: { body: ANTHROPIC_OK } })
    const { catalog, list } = await catalogOf(w, fn)
    expect(await catalog.accepts('alpha', 'anthropic', 'whatever')).toBe(true)
    await list('anthropic')
    expect(await catalog.accepts('alpha', 'anthropic', 'claude-a')).toBe(true)
    expect(await catalog.accepts('alpha', 'anthropic', 'claude-typo')).toBe(false)
    // Another provider's list is not this one's.
    expect(await catalog.accepts('alpha', 'gemini', 'claude-typo')).toBe(true)
  })

  it('checks Claude Code against its aliases, and Ollama against what is installed ("llama3.2" is "llama3.2:latest")', async () => {
    const url = await fakeOllama(['llama3.2:latest', 'qwen3:4b'])
    const w = await world({
      accounts: ['alpha'],
      config: { ...BASE, provider: { primary: 'ollama', ollama: { baseUrl: url, model: 'qwen3:4b' } } },
    })
    const { catalog, list } = await catalogOf(w, fetch)
    expect(await catalog.accepts('alpha', 'claude-cli', 'opus')).toBe(true)
    expect(await catalog.accepts('alpha', 'claude-cli', 'sonet')).toBe(false)
    await list('ollama')
    expect(await catalog.accepts('alpha', 'ollama', 'llama3.2')).toBe(true)
    expect(await catalog.accepts('alpha', 'ollama', 'qwen3:4b')).toBe(true)
    expect(await catalog.accepts('alpha', 'ollama', 'qwen3:40b')).toBe(false)
  })

  it('only checks a model that changes, not the one the account already holds', async () => {
    const w = await world({ accounts: ['alpha'] })
    const { catalog } = await catalogOf(w, fetch)
    const patch = { 'provider.claudeCli.model': 'claude-sonnet-5-5' }
    expect(
      await unknownModelIn({ models: catalog }, 'alpha', patch, {
        provider: { claudeCli: { model: 'claude-sonnet-5-5' } },
      }),
    ).toBeNull()
    expect(
      await unknownModelIn({ models: catalog }, 'alpha', patch, { provider: { claudeCli: { model: 'sonnet' } } }),
    ).toBe('provider.claudeCli.model')
    expect(await unknownModelIn({ models: catalog }, 'alpha', { 'provider.claudeCli.model': null }, null)).toBeNull()
  })

  it('is refused by the settings and by the wizard with the code unknownModel, and a listed one is saved', async () => {
    const url = await fakeOllama(['qwen3:4b'])
    const w = await world({
      accounts: [],
      config: { ...BASE, language: 'es', provider: { primary: null, ollama: { baseUrl: url } } },
    })
    // The wizard: the first step, then a typed model nobody listed (the page lists first, so a list is known).
    await w.api('PUT', '/api/setup', { from: 'you', accountId: 'alpha', ownerName: 'Ana' })
    await w.api('POST', '/api/accounts/alpha/models/ollama', {})
    const refused = await w.api('PUT', '/api/setup', {
      from: 'provider',
      provider: 'ollama',
      options: { model: 'qwen3:40b' },
    })
    expect(refused).toEqual({ status: 422, body: { error: 'unknownModel', option: 'provider.ollama.model' } })
    const accepted = await w.api('PUT', '/api/setup', {
      from: 'provider',
      provider: 'ollama',
      options: { model: 'qwen3:4b' },
    })
    expect(accepted.status).toBe(200)
    // The settings: the same rule, and the value already saved is left alone.
    const bad = await w.api('PUT', '/api/accounts/alpha/settings', { provider: { ollama: { model: 'qwen3:40b' } } })
    expect(bad).toEqual({ status: 422, body: { error: 'unknownModel', option: 'provider.ollama.model' } })
    const same = await w.api('PUT', '/api/accounts/alpha/settings', { provider: { ollama: { model: 'qwen3:4b' } } })
    expect(same.status).toBe(200)
  })
})

describe('the scope of what a save is checked against', () => {
  it('is the provider, the full address and the key: another key or another path is another list', async () => {
    const w = await world({ accounts: ['alpha'] })
    await storeApiKey(w.h.layout.secretsFile, 'anthropic', KEY)
    const { fn } = scriptedFetch({ current: { body: ANTHROPIC_OK } })
    const { catalog, list } = await catalogOf(w, fn)
    await list('anthropic')
    expect(await catalog.accepts('alpha', 'anthropic', 'claude-typo')).toBe(false)
    // Another key was saved: the list of the old one says nothing about it.
    await storeApiKey(w.h.layout.secretsFile, 'anthropic', 'sk-test-BBBBBBBBBBBBBBBBBBBBBBBB-FAKE')
    expect(await catalog.accepts('alpha', 'anthropic', 'claude-typo')).toBe(true)
  })

  it('expires with the cache: an old list no longer refuses anything', async () => {
    const w = await world({ accounts: ['alpha'] })
    await storeApiKey(w.h.layout.secretsFile, 'anthropic', KEY)
    const { fn } = scriptedFetch({ current: { body: ANTHROPIC_OK } })
    let time = 0
    const { catalog, list } = await catalogOf(w, fn, () => time)
    await list('anthropic')
    time += MODEL_CACHE_MS - 1
    expect(await catalog.accepts('alpha', 'anthropic', 'claude-typo')).toBe(false)
    time += 2
    expect(await catalog.accepts('alpha', 'anthropic', 'claude-typo')).toBe(true)
  })

  it('tells two compatible servers apart by the whole address, path included', async () => {
    const w = await world({
      accounts: ['alpha'],
      config: {
        ...BASE,
        provider: { primary: 'openai', openai: { baseUrl: 'http://localhost:1234/a/v1', model: 'm' } },
      },
    })
    const { fn } = scriptedFetch({ current: { body: { data: [{ id: 'only-here' }] } } })
    const { catalog, list } = await catalogOf(w, fn)
    expect((await list('openai')).models).toEqual([{ id: 'only-here' }])
    expect(await catalog.accepts('alpha', 'openai', 'typo')).toBe(false)
    // The same host, another path: nothing is known about it.
    expect(await catalog.accepts('alpha', 'openai', 'typo', 'http://localhost:1234/b/v1')).toBe(true)
    expect(await catalog.accepts('alpha', 'openai', 'typo', 'http://localhost:1234/a/v1/')).toBe(false)
  })
})

describe('an address and a model changed in the same save', () => {
  it('Ollama: the model is checked at the NEW address, so moving to another server and its model is not refused', async () => {
    const first = await fakeOllama(['one:latest'])
    const second = await fakeOllama(['two:latest'])
    const w = await world({
      accounts: ['alpha'],
      config: { ...BASE, provider: { primary: 'ollama', ollama: { baseUrl: first, model: 'one:latest' } } },
    })
    await w.api('POST', '/api/accounts/alpha/models/ollama', {})
    // Nothing is known about the new server yet: it is accepted (the test of the connection decides).
    const moved = await w.api('PUT', '/api/accounts/alpha/settings', {
      provider: { ollama: { baseUrl: second, model: 'two:latest' } },
    })
    expect(moved.status).toBe(200)
    // Once the new server was listed, its own list rules: a model of an old one is refused there.
    await w.api('POST', '/api/accounts/alpha/models/ollama', {})
    const third = await fakeOllama(['three:latest'])
    await w.api('POST', '/api/accounts/alpha/models/ollama', { baseUrl: third })
    const wrong = await w.api('PUT', '/api/accounts/alpha/settings', {
      provider: { ollama: { baseUrl: third, model: 'one:latest' } },
    })
    expect(wrong).toEqual({ status: 422, body: { error: 'unknownModel', option: 'provider.ollama.model' } })
    const right = await w.api('PUT', '/api/accounts/alpha/settings', {
      provider: { ollama: { baseUrl: third, model: 'three:latest' } },
    })
    expect(right.status).toBe(200)
  })

  it('a compatible server: a typed model at a new address is not checked against the list of OpenAI', async () => {
    const w = await world({ accounts: ['alpha'] })
    await storeApiKey(w.h.layout.secretsFile, 'openai', KEY)
    const { fn } = scriptedFetch({ current: { body: { data: [{ id: 'gpt-4o', created: 1 }] } } })
    const { catalog, list } = await catalogOf(w, fn)
    await list('openai')
    expect(await catalog.accepts('alpha', 'openai', 'my-local-model')).toBe(false)
    const patch = { 'provider.openai.baseUrl': 'http://localhost:1234/v1', 'provider.openai.model': 'my-local-model' }
    expect(await unknownModelIn({ models: catalog }, 'alpha', patch, null)).toBeNull()
    // The same model at OpenAI's own address is still refused.
    expect(
      await unknownModelIn({ models: catalog }, 'alpha', { 'provider.openai.model': 'my-local-model' }, null),
    ).toBe('provider.openai.model')
  })

  it('a resumed wizard does not check again the model the account already holds', async () => {
    const url = await fakeOllama(['qwen3:4b'])
    const w = await world({
      accounts: [],
      config: { ...BASE, provider: { primary: null, ollama: { baseUrl: url } } },
    })
    await w.api('PUT', '/api/setup', { from: 'you', accountId: 'alpha', ownerName: 'Ana' })
    await w.api('POST', '/api/accounts/alpha/models/ollama', {})
    const step = { from: 'provider', provider: 'ollama', options: { model: 'qwen3:4b' } }
    expect((await w.api('PUT', '/api/setup', step)).status).toBe(200)
    // The model is gone from the server, and the user goes back and continues: the one that was saved is not refused.
    await w.api('PUT', '/api/setup', { goto: 'provider' })
    const emptied = await fakeOllama(['other:latest'])
    await w.api('PUT', '/api/accounts/alpha/settings', {
      provider: { ollama: { baseUrl: emptied, model: 'other:latest' } },
    })
    await w.api('POST', '/api/accounts/alpha/models/ollama', {})
    await w.api('PUT', '/api/accounts/alpha/settings', { provider: { ollama: { baseUrl: url, model: 'qwen3:4b' } } })
    expect((await w.api('PUT', '/api/setup', step)).status).toBe(200)
  })
})

describe('what the models route may be asked', () => {
  it('lists the server the account uses when no address is given (the daemon resolves it, the page does not guess)', async () => {
    const url = await fakeOllama(['inherited:latest'])
    const w = await world({
      accounts: ['alpha'],
      config: { ...BASE, provider: { primary: 'ollama', ollama: { baseUrl: url, model: 'inherited:latest' } } },
    })
    expect((await w.api('POST', '/api/accounts/alpha/models/ollama', {})).body).toMatchObject({
      models: [{ id: 'inherited:latest' }],
      origin: url,
    })
  })

  it('asks a server that is not on this machine only after the agreement, and never with credentials in the address', async () => {
    const w = await world({ accounts: ['alpha'] })
    const urls: string[] = []
    const fn = (async (input: unknown) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ models: [{ name: 'remote:latest' }] }))
    }) as typeof fetch
    const { list } = await catalogOf(w, fn)
    const remote = 'http://192.0.2.7:11434'
    expect(await list('ollama', { baseUrl: remote })).toMatchObject({ models: [], error: 'consentRequired' })
    expect(urls).toEqual([])
    // An agreement for another recipient is not this one's.
    expect(await list('ollama', { baseUrl: remote, consent: 'openai' })).toMatchObject({ error: 'consentRequired' })
    expect(urls).toEqual([])
    expect(await list('ollama', { baseUrl: remote, consent: 'ollama-remote' })).toMatchObject({
      models: [{ id: 'remote:latest' }],
    })
    expect(urls).toEqual([`${remote}/api/tags`])
    expect(
      await list('ollama', { baseUrl: 'http://user:secret@192.0.2.7:11434', consent: 'ollama-remote' }),
    ).toMatchObject({
      error: 'invalidAddress',
    })
    expect(urls).toHaveLength(1)
  })

  it('is a POST only, takes an address for Ollama only, and checks its body', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect((await w.api('GET', '/api/accounts/alpha/models/claude-cli')).status).not.toBe(200)
    expect(
      (await w.api('POST', '/api/accounts/alpha/models/anthropic', { baseUrl: 'http://127.0.0.1:1' })).status,
    ).toBe(400)
    expect((await w.api('POST', '/api/accounts/alpha/models/ollama', { baseUrl: 7 })).status).toBe(400)
    expect((await w.api('POST', '/api/accounts/alpha/models/ollama', { refresh: 'yes' })).status).toBe(400)
    expect((await w.api('POST', '/api/accounts/alpha/models/ollama', { consent: 1 })).status).toBe(400)
  })

  it('cannot be triggered from another site: a foreign Origin is refused before anything is asked', async () => {
    const url = await fakeOllama(['x:latest'])
    const w = await world({
      accounts: ['alpha'],
      config: { ...BASE, provider: { primary: 'ollama', ollama: { baseUrl: url, model: 'x:latest' } } },
    })
    const token = readFileSync(w.h.layout.webTokenFile, 'utf8').trim()
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: w.port,
          path: '/api/accounts/alpha/models/ollama',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: 'https://evil.example',
            'Content-Type': 'application/json',
          },
          agent: false,
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end('{}')
    })
    expect(status).toBe(403)
  })
})

describe('an emptied Ollama address means the one the installation gives', () => {
  it("lists that server and checks the model against it, not against the account's old address", async () => {
    const installation = await fakeOllama(['inst:latest'])
    const own = await fakeOllama(['own:latest'])
    const w = await world({
      accounts: ['alpha'],
      config: { ...BASE, provider: { primary: 'ollama', ollama: { baseUrl: installation, model: 'inst:latest' } } },
    })
    writeFileSync(
      w.h.accountOf('alpha').configFile,
      JSON.stringify({ provider: { ollama: { baseUrl: own, model: 'own:latest' } } }),
    )
    // As it is saved, the account's own address is the one in force.
    expect((await w.api('POST', '/api/accounts/alpha/models/ollama', {})).body).toMatchObject({
      models: [{ id: 'own:latest' }],
      origin: own,
    })
    // The field is emptied: the page says so, and the list is the installation's.
    expect((await w.api('POST', '/api/accounts/alpha/models/ollama', { inherit: true })).body).toMatchObject({
      models: [{ id: 'inst:latest' }],
      origin: installation,
    })
    // The save that clears the address and picks a model is checked against that list.
    const wrong = await w.api('PUT', '/api/accounts/alpha/settings', {
      provider: { ollama: { baseUrl: null, model: 'other:latest' } },
    })
    expect(wrong).toEqual({ status: 422, body: { error: 'unknownModel', option: 'provider.ollama.model' } })
    const right = await w.api('PUT', '/api/accounts/alpha/settings', {
      provider: { ollama: { baseUrl: null, model: 'inst:latest' } },
    })
    expect(right.status).toBe(200)
  })

  it('takes inherit as a flag for Ollama only', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect((await w.api('POST', '/api/accounts/alpha/models/anthropic', { inherit: true })).status).toBe(400)
    expect((await w.api('POST', '/api/accounts/alpha/models/ollama', { inherit: 'yes' })).status).toBe(400)
  })
})

describe('the address Ollama has when the wizard field is emptied', () => {
  it("is said by the daemon (the installation's, here a server that is not on this machine), never assumed local", async () => {
    const w = await world({
      accounts: [],
      config: { ...BASE, provider: { primary: null, ollama: { baseUrl: 'http://192.0.2.7:11434' } } },
    })
    expect((await w.api('GET', '/api/setup')).body.ollamaBaseUrl).toBe('http://192.0.2.7:11434')
    await w.api('PUT', '/api/setup', { from: 'you', accountId: 'alpha', ownerName: 'Ana' })
    // The account's own value does not count for what an emptied field gives.
    writeFileSync(
      w.h.accountOf('alpha').configFile,
      JSON.stringify({ ownerName: 'Ana', provider: { ollama: { baseUrl: 'http://127.0.0.1:9' } } }),
    )
    expect((await w.api('GET', '/api/setup')).body.ollamaBaseUrl).toBe('http://192.0.2.7:11434')
    const plain = await world({ accounts: [] })
    expect((await plain.api('GET', '/api/setup')).body.ollamaBaseUrl).toBe('http://127.0.0.1:11434')
  })
})
