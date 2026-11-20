import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CONSENT_TEXT_VERSION } from '../../../src/domain/setup.js'
import { classifyProviderError } from '../../../src/main/provider-test.js'
import { disposeHarnesses } from '../../support/cli-harness.js'
import { isWindows } from '../../support/platform.js'
import { BASE, disposeWorlds, type World, world } from '../../support/web-world.js'

// The only server this file starts is a fake OpenAI-compatible one on 127.0.0.1: nothing leaves the machine.

const VALID = { resumen: 'A made-up chat.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' }
// Made up: shaped like a key, worth nothing.
const KEY = 'sk-test-AAAAAAAAAAAAAAAAAAAAAAAA-FAKE'
const OTHER_KEY = 'sk-test-BBBBBBBBBBBBBBBBBBBBBBBB-FAKE'

let dir: string
const servers: Server[] = []

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'msum-api-providers-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** A fake OpenAI-compatible server that records the Authorization header of each call. */
async function fakeServer(status = 200) {
  const authorizations: Array<string | undefined> = []
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      authorizations.push(req.headers.authorization)
      res.statusCode = status
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID) } }] }))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, authorizations }
}

const settingsUrl = (id: string) => `/api/accounts/${id}/settings`
const secretsOf = (w: World) => w.h.layout.secretsFile
const accountOf = (w: World, id: string) =>
  JSON.parse(readFileSync(w.h.accountOf(id).configFile, 'utf8')) as Record<string, unknown>

describe('the API keys (RNF-04)', () => {
  it('are behind the token on every route', async () => {
    const w = await world({ accounts: ['alpha'] })
    for (const [method, path, body] of [
      ['GET', '/api/accounts/alpha/keys', undefined],
      ['PUT', '/api/accounts/alpha/keys/anthropic', { key: KEY }],
      ['DELETE', '/api/accounts/alpha/keys/anthropic', undefined],
    ] as const) {
      expect((await w.api(method, path, body, null)).status, `${method} ${path}`).toBe(401)
      expect((await w.api(method, path, body, 'wrong')).status, `${method} ${path}`).toBe(401)
    }
    expect(existsSync(secretsOf(w))).toBe(false)
  })

  it('are stored in the installation file like `msum secret set`, and never come back', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect((await w.api('GET', '/api/accounts/alpha/keys')).body).toEqual({
      keys: {
        openai: { present: false },
        'openai-compatible': { present: false },
        anthropic: { present: false },
        gemini: { present: false },
      },
    })
    const put = await w.api('PUT', '/api/accounts/alpha/keys/anthropic', { key: `  ${KEY}\n` })
    expect(put).toEqual({
      status: 200,
      body: { stored: true, key: { present: true, source: 'file' }, overriddenBy: null },
    })
    expect(JSON.parse(readFileSync(secretsOf(w), 'utf8'))).toEqual({ anthropic: KEY })
    if (!isWindows) expect(statSync(secretsOf(w)).mode & 0o777).toBe(0o600)
    const listed = await w.api('GET', '/api/accounts/alpha/keys')
    expect(listed.body.keys).toMatchObject({ anthropic: { present: true, source: 'file' }, gemini: { present: false } })
    // The answer says that there is a key and where from, never a path or the key.
    expect(JSON.stringify([put, listed])).not.toContain(KEY)
    expect(JSON.stringify(listed)).not.toContain(w.h.layout.dataDir)
    // Another key of the file is kept.
    expect((await w.api('PUT', '/api/accounts/alpha/keys/gemini', { key: OTHER_KEY })).status).toBe(200)
    expect(JSON.parse(readFileSync(secretsOf(w), 'utf8'))).toEqual({ anthropic: KEY, gemini: OTHER_KEY })
    expect(await w.api('DELETE', '/api/accounts/alpha/keys/anthropic')).toEqual({
      status: 200,
      body: { removed: true, key: { present: false } },
    })
    expect(await w.api('DELETE', '/api/accounts/alpha/keys/anthropic')).toEqual({
      status: 200,
      body: { removed: false, key: { present: false } },
    })
    expect(JSON.parse(readFileSync(secretsOf(w), 'utf8'))).toEqual({ gemini: OTHER_KEY })
  })

  it('say where a key comes from when the environment or the account has one, and that the environment wins', async () => {
    const w = await world({ accounts: ['alpha'] })
    Object.assign(w.h.ctx.env, { GEMINI_API_KEY: OTHER_KEY })
    writeFileSync(w.h.accountOf('alpha').secretsFile, JSON.stringify({ anthropic: KEY }))
    const keys = (await w.api('GET', '/api/accounts/alpha/keys')).body.keys
    expect(keys).toMatchObject({
      gemini: { present: true, source: 'env', name: 'GEMINI_API_KEY' },
      anthropic: { present: true, source: 'accountFile' },
    })
    expect(JSON.stringify(keys)).not.toContain(KEY)
    expect(JSON.stringify(keys)).not.toContain(OTHER_KEY)
    // The writes answer with what the account has now: the environment wins over the file just written...
    expect((await w.api('PUT', '/api/accounts/alpha/keys/gemini', { key: KEY })).body).toEqual({
      stored: true,
      key: { present: true, source: 'env', name: 'GEMINI_API_KEY' },
      overriddenBy: 'env',
    })
    // ...and so does the key of the account's own file.
    expect((await w.api('PUT', '/api/accounts/alpha/keys/anthropic', { key: OTHER_KEY })).body).toMatchObject({
      key: { present: true, source: 'accountFile' },
      overriddenBy: 'accountFile',
    })
    expect(await w.api('DELETE', '/api/accounts/alpha/keys/anthropic')).toMatchObject({
      body: { removed: true, key: { present: true, source: 'accountFile' } },
    })
    // An account that does not exist, or that this daemon does not run, has no keys to write.
    expect((await w.api('PUT', '/api/accounts/nope/keys/gemini', { key: KEY })).status).toBe(404)
  })

  it('refuse what is not a key, and a provider that takes none', async () => {
    const w = await world({ accounts: ['alpha'] })
    for (const body of [
      {},
      { key: 5 },
      { key: '' },
      { key: '   ' },
      { key: 'two words' },
      { key: 'a\nb' },
      { key: 'x'.repeat(5000) },
    ]) {
      const reply = await w.api('PUT', '/api/accounts/alpha/keys/openai', body)
      expect(reply, JSON.stringify(body).slice(0, 40)).toEqual({ status: 400, body: { error: 'invalidKey' } })
    }
    expect((await w.api('PUT', '/api/accounts/alpha/keys/openai', 'text')).status).toBe(400)
    for (const provider of ['claude-cli', 'ollama', 'nope', '..']) {
      expect((await w.api('PUT', `/api/accounts/alpha/keys/${provider}`, { key: KEY })).status, provider).toBe(404)
      expect((await w.api('DELETE', `/api/accounts/alpha/keys/${provider}`)).status, provider).toBe(404)
    }
    expect(existsSync(secretsOf(w))).toBe(false)
    expect((await w.api('GET', '/api/accounts/nope/keys')).status).toBe(404)
  })

  it('leave a secrets file that is not valid as it is, and say so without its path or the key', async () => {
    const w = await world({ accounts: ['alpha'] })
    writeFileSync(secretsOf(w), 'not json at all')
    if (!isWindows) chmodSync(secretsOf(w), 0o600)
    const reply = await w.api('PUT', '/api/accounts/alpha/keys/openai', { key: KEY })
    expect(reply).toEqual({ status: 409, body: { error: 'invalidSecretsFile' } })
    expect(readFileSync(secretsOf(w), 'utf8')).toBe('not json at all')
    expect(JSON.stringify(reply)).not.toContain(KEY)
  })
})

describe('the address of OpenAI (RNF-01)', () => {
  it.each([
    'ftp://example.com/v1',
    'file:///etc/passwd',
    'not a url',
    'localhost:1234/v1',
    'https://user:pass@example.com/v1',
    'https://user@example.com/v1',
    'http://localhost:1234/v1#frag',
    'http://localhost:1234/v1#',
  ])('refuses %s with invalidUrl', async (baseUrl) => {
    const w = await world({ accounts: ['alpha'] })
    const reply = await w.api('PUT', settingsUrl('alpha'), { provider: { openai: { baseUrl } } })
    expect(reply.status).toBe(422)
    expect(reply.body.issues).toEqual([{ option: 'provider.openai.baseUrl', code: 'invalidUrl' }])
    expect(existsSync(w.h.accountOf('alpha').configFile)).toBe(false)
  })

  it.each(['http://localhost:1234/v1', 'https://openrouter.ai/api/v1', 'http://192.168.1.5:8080'])(
    'accepts %s',
    async (baseUrl) => {
      const w = await world({ accounts: ['alpha'] })
      const reply = await w.api('PUT', settingsUrl('alpha'), { provider: { openai: { baseUrl, model: 'm' } } })
      expect(reply.status).toBe(200)
      expect(reply.body.values).toMatchObject({ provider: { openai: { baseUrl, model: 'm' } } })
    },
  )

  it('is refused in the wizard too, and only OpenAI and Ollama have one', async () => {
    const w = await world({ accounts: [] })
    await w.api('PUT', '/api/setup', { from: 'you', accountId: 'alpha', ownerName: 'Test Owner' })
    const bad = await w.api('PUT', '/api/setup', {
      from: 'provider',
      provider: 'openai',
      consent: true,
      options: { model: 'm', baseUrl: 'https://u:p@example.com' },
    })
    expect(bad.status).toBe(422)
    for (const provider of ['anthropic', 'gemini']) {
      const reply = await w.api('PUT', '/api/setup', {
        from: 'provider',
        provider,
        consent: true,
        options: { model: 'm', baseUrl: 'http://localhost:1/v1' },
      })
      expect(reply, provider).toEqual({ status: 400, body: { error: 'invalidRequest' } })
    }
  })
})

describe('the consent to an API provider (RNF-02)', () => {
  it.each([
    ['openai', { provider: { primary: 'openai', openai: { model: 'm' } } }, 'openai'],
    ['anthropic', { provider: { primary: 'anthropic', anthropic: { model: 'm' } } }, 'anthropic'],
    ['gemini', { provider: { primary: 'gemini', gemini: { model: 'm' } } }, 'gemini'],
    ['a backup', { provider: { backup: 'gemini', gemini: { model: 'm' } } }, 'gemini'],
    // Even on this machine: the server could be anything, and it gets the key.
    [
      'a compatible server on localhost',
      { provider: { primary: 'openai', openai: { model: 'm', baseUrl: 'http://127.0.0.1:1234/v1' } } },
      'openai-compatible',
    ],
  ])('is asked for before choosing %s', async (_name, patch, key) => {
    const w = await world({ accounts: ['alpha'] })
    const reply = await w.api('PUT', settingsUrl('alpha'), patch)
    const baseUrl = (patch.provider as { openai?: { baseUrl?: string } }).openai?.baseUrl
    // A server of the user's choice comes with its origin: the page shows it and records the agreement for it.
    expect(reply).toEqual({
      status: 409,
      body: {
        error: 'consentRequired',
        provider: key,
        ...(key === 'openai-compatible' ? { origin: new URL(baseUrl ?? '').origin } : {}),
      },
    })
    expect(existsSync(w.h.accountOf('alpha').configFile)).toBe(false)
    // Recorded through the endpoint of the page (with the address it is about to save), the same change goes through.
    const recorded = await w.api('POST', '/api/accounts/alpha/consents', {
      provider: key,
      ...(baseUrl === undefined ? {} : { baseUrl }),
    })
    // (the endpoint records against the saved configuration with that address, but a model is not needed for it)
    expect(recorded.status).toBe(201)
    expect((await w.api('PUT', settingsUrl('alpha'), patch)).status).toBe(200)
  })

  it('is asked again when the address of OpenAI changes, even from one compatible server to another', async () => {
    const w = await world({ accounts: ['alpha'] })
    const first = { provider: { primary: 'openai', openai: { model: 'm', baseUrl: 'http://127.0.0.1:1234/v1' } } }
    expect((await w.api('PUT', settingsUrl('alpha'), first)).status).toBe(409)
    w.installation.setup.recordConsent('alpha', 'openai-compatible', CONSENT_TEXT_VERSION, 'http://127.0.0.1:1234')
    expect((await w.api('PUT', settingsUrl('alpha'), first)).status).toBe(200)
    // Another path on the same origin is the same recipient.
    const samePlace = await w.api('PUT', settingsUrl('alpha'), {
      provider: { openai: { baseUrl: 'http://127.0.0.1:1234/other' } },
    })
    expect(samePlace.status).toBe(200)
    // Another port, another host, or back to OpenAI itself: new agreement.
    for (const baseUrl of ['http://127.0.0.1:9999/v1', 'https://openrouter.ai/api/v1', null]) {
      const reply = await w.api('PUT', settingsUrl('alpha'), { provider: { openai: { baseUrl } } })
      expect(reply.status, String(baseUrl)).toBe(409)
      expect(reply.body.error).toBe('consentRequired')
    }
    expect(accountOf(w, 'alpha')).toMatchObject({ provider: { openai: { baseUrl: 'http://127.0.0.1:1234/other' } } })
    // The consent for a compatible server does not cover OpenAI itself.
    expect((await w.api('PUT', settingsUrl('alpha'), { provider: { openai: { baseUrl: null } } })).body).toEqual({
      error: 'consentRequired',
      provider: 'openai',
    })
  })

  it('is not asked when only the model changes, and a consent of one kind does not cover another', async () => {
    const w = await world({ accounts: ['alpha'] })
    w.installation.setup.recordConsent('alpha', 'anthropic', CONSENT_TEXT_VERSION)
    const patch = { provider: { primary: 'anthropic', anthropic: { model: 'm1' } } }
    expect((await w.api('PUT', settingsUrl('alpha'), patch)).status).toBe(200)
    expect((await w.api('PUT', settingsUrl('alpha'), { provider: { anthropic: { model: 'm2' } } })).status).toBe(200)
    expect(
      (await w.api('PUT', settingsUrl('alpha'), { provider: { backup: 'gemini', gemini: { model: 'g' } } })).body,
    ).toEqual({
      error: 'consentRequired',
      provider: 'gemini',
    })
  })

  it('is listed in the wizard once given, by the key that applies to the address now', async () => {
    const w = await world({ accounts: [] })
    await w.api('PUT', '/api/setup', { from: 'you', accountId: 'alpha', ownerName: 'Test Owner' })
    const refused = await w.api('PUT', '/api/setup', {
      from: 'provider',
      provider: 'gemini',
      options: { model: 'gemini-test' },
    })
    expect(refused).toEqual({ status: 409, body: { error: 'consentRequired', provider: 'gemini' } })
    const chosen = await w.api('PUT', '/api/setup', {
      from: 'provider',
      provider: 'gemini',
      consent: true,
      options: { model: 'gemini-test' },
    })
    expect(chosen.status).toBe(200)
    expect(chosen.body.consents).toEqual(['gemini'])
    expect(accountOf(w, 'alpha')).toMatchObject({ provider: { primary: 'gemini', gemini: { model: 'gemini-test' } } })
  })

  it('does not record a consent for a kind that does not apply to the address', async () => {
    const w = await world({ accounts: ['alpha'] })
    // The account has OpenAI's own address: `openai-compatible` does not apply to it.
    expect((await w.api('POST', '/api/accounts/alpha/consents', { provider: 'openai-compatible' })).status).toBe(400)
    expect((await w.api('POST', '/api/accounts/alpha/consents', { provider: 'openai' })).status).toBe(201)
    expect(w.installation.setup.consents('alpha')).toHaveLength(1)
  })
})

describe('POST /api/setup/test-provider with an API provider (RF-41)', () => {
  const wizard = async (w: World) => {
    expect(
      (await w.api('PUT', '/api/setup', { from: 'you', accountId: 'alpha', ownerName: 'Test Owner' })).status,
    ).toBe(200)
  }

  it('tries a key that was just typed without saving it, and the key is in no answer, file or log', async () => {
    const fake = await fakeServer()
    const w = await world({ accounts: [] })
    await wizard(w)
    const body = {
      provider: 'openai',
      consent: 'openai-compatible',
      keyProvider: 'openai-compatible',
      key: KEY,
      options: { model: 'm', baseUrl: fake.url },
    }
    const reply = await w.api('POST', '/api/setup/test-provider', body)
    expect(reply.status).toBe(200)
    expect(reply.body.ok).toBe(true)
    expect(fake.authorizations).toEqual([`Bearer ${KEY}`])
    // Not saved anywhere, and nothing else changed.
    expect(existsSync(secretsOf(w))).toBe(false)
    expect(existsSync(w.h.accountOf('alpha').secretsFile)).toBe(false)
    expect(Object.keys(w.h.ctx.env)).not.toContain('MSUM_OPENAI_API_KEY')
    expect(JSON.stringify(reply)).not.toContain(KEY)
    expect(w.h.logs.join('\n')).not.toContain(KEY)
    // Without it, the server is called with no key at all.
    const without = await w.api('POST', '/api/setup/test-provider', { ...body, key: undefined })
    expect(without.body.ok).toBe(true)
    expect(fake.authorizations[1]).toBeUndefined()
  })

  it('uses the stored key when none is typed, and a typed key wins over it', async () => {
    const fake = await fakeServer()
    const w = await world({ accounts: [] })
    await wizard(w)
    // `openai-compatible` is the slot for any server that is not OpenAI itself.
    expect((await w.api('PUT', '/api/accounts/alpha/keys/openai-compatible', { key: OTHER_KEY })).status).toBe(200)
    const body = { provider: 'openai', consent: 'openai-compatible', options: { model: 'm', baseUrl: fake.url } }
    expect((await w.api('POST', '/api/setup/test-provider', body)).body.ok).toBe(true)
    expect(
      (await w.api('POST', '/api/setup/test-provider', { ...body, key: KEY, keyProvider: 'openai-compatible' })).body
        .ok,
    ).toBe(true)
    expect(fake.authorizations).toEqual([`Bearer ${OTHER_KEY}`, `Bearer ${KEY}`])
    // The typed one was not saved over the stored one.
    expect(JSON.parse(readFileSync(secretsOf(w), 'utf8'))).toEqual({ 'openai-compatible': OTHER_KEY })
  })

  it('says noKey for OpenAI itself without a key, before any call, and rejected when the server refuses the key', async () => {
    const w = await world({ accounts: [] })
    await wizard(w)
    expect(
      (await w.api('POST', '/api/setup/test-provider', { provider: 'openai', consent: true, options: { model: 'm' } }))
        .body,
    ).toEqual({ ok: false, error: 'noKey' })
    const fake = await fakeServer(401)
    const refused = await w.api('POST', '/api/setup/test-provider', {
      provider: 'openai',
      consent: 'openai-compatible',
      keyProvider: 'openai-compatible',
      key: KEY,
      options: { model: 'm', baseUrl: fake.url },
    })
    expect(refused.body).toEqual({ ok: false, error: 'rejected' })
    expect(JSON.stringify(refused)).not.toContain(KEY)
  })

  it('needs the consent before it sends anything, also for a server on localhost', async () => {
    const fake = await fakeServer()
    const w = await world({ accounts: [] })
    await wizard(w)
    const body = { provider: 'openai', key: KEY, options: { model: 'm', baseUrl: fake.url } }
    expect(await w.api('POST', '/api/setup/test-provider', body)).toEqual({
      status: 409,
      body: { error: 'consentRequired', provider: 'openai-compatible', origin: new URL(fake.url).origin },
    })
    expect(fake.authorizations).toEqual([])
  })

  it('refuses a key that is not a key, and a key for a provider that takes none, without echoing it', async () => {
    const w = await world({ accounts: [] })
    await wizard(w)
    const bad = await w.api('POST', '/api/setup/test-provider', {
      provider: 'openai',
      consent: true,
      key: `${KEY} extra words`,
      options: { model: 'm' },
    })
    expect(bad).toEqual({ status: 400, body: { error: 'invalidKey' } })
    const none = await w.api('POST', '/api/setup/test-provider', {
      provider: 'ollama',
      key: KEY,
      options: { model: 'm' },
    })
    expect(none).toEqual({ status: 400, body: { error: 'invalidRequest' } })
    expect(JSON.stringify([bad, none])).not.toContain(KEY)
    expect(w.h.logs.join('\n')).not.toContain(KEY)
  })
})

describe('the key never leaves in any answer, file of the account or log', () => {
  it('goes through the whole flow without showing up where it should not', async () => {
    const fake = await fakeServer()
    const w = await world({ accounts: ['alpha'] })
    const replies: unknown[] = []
    const call = async (method: string, path: string, body?: unknown) => {
      const reply = await w.api(method, path, body)
      replies.push(reply)
      return reply
    }
    await call('PUT', '/api/accounts/alpha/keys/openai-compatible', { key: KEY })
    await call('GET', '/api/accounts/alpha/keys')
    await call('PUT', '/api/accounts/alpha/keys/openai-compatible', { key: `${KEY} spaced` })
    await call('PUT', settingsUrl('alpha'), {
      provider: { primary: 'openai', openai: { model: 'm', baseUrl: fake.url } },
    })
    await call('POST', '/api/accounts/alpha/consents', { provider: 'openai-compatible', baseUrl: fake.url })
    await call('PUT', settingsUrl('alpha'), {
      provider: { primary: 'openai', openai: { model: 'm', baseUrl: fake.url } },
    })
    await call('GET', settingsUrl('alpha'))
    await call('GET', '/api/setup')
    await call('GET', '/api/accounts')
    await call('POST', '/api/setup/test-provider', {
      provider: 'openai',
      consent: 'openai-compatible',
      keyProvider: 'openai-compatible',
      key: OTHER_KEY,
      options: { model: 'm', baseUrl: fake.url },
    })
    expect(replies.some((reply) => (reply as { status: number }).status === 200)).toBe(true)
    const everything = JSON.stringify(replies)
    for (const secret of [KEY, OTHER_KEY]) {
      expect(everything).not.toContain(secret)
      expect(w.h.logs.join('\n')).not.toContain(secret)
      expect(readFileSync(w.h.layout.configFile, 'utf8')).not.toContain(secret)
      expect(readFileSync(w.h.accountOf('alpha').configFile, 'utf8')).not.toContain(secret)
    }
    // The stored key is only in the secrets file.
    expect(readFileSync(secretsOf(w), 'utf8')).toContain(KEY)
  })
})

describe('the agreement names its recipient (RNF-02)', () => {
  const wizard = async (w: World) => {
    await w.api('PUT', '/api/setup', { from: 'you', accountId: 'alpha', ownerName: 'Test Owner' })
  }
  const OPENROUTER = 'https://openrouter.ai/api/v1'
  // The installation points `openai` somewhere else; the page does not know and sends no address.
  const inherited = () => world({ accounts: [], config: { ...BASE, provider: { openai: { baseUrl: OPENROUTER } } } })

  it('tells the page the address of OpenAI that is in force, inherited or not', async () => {
    const plain = await world({ accounts: [] })
    expect((await plain.api('GET', '/api/setup')).body.openaiBaseUrl).toBe('https://api.openai.com/v1')
    const w = await inherited()
    expect((await w.api('GET', '/api/setup')).body.openaiBaseUrl).toBe(OPENROUTER)
    await wizard(w)
    expect((await w.api('GET', '/api/setup')).body.openaiBaseUrl).toBe(OPENROUTER)
  })

  it('does not take the agreement to OpenAI for an inherited compatible server, in the wizard, the test or the key', async () => {
    const w = await inherited()
    await wizard(w)
    for (const consent of [true, 'openai']) {
      const step = await w.api('PUT', '/api/setup', {
        from: 'provider',
        provider: 'openai',
        consent,
        options: { model: 'm' },
      })
      expect(step, String(consent)).toEqual({
        status: 409,
        body: { error: 'consentRequired', provider: 'openai-compatible', origin: new URL(OPENROUTER).origin },
      })
      const tested = await w.api('POST', '/api/setup/test-provider', {
        provider: 'openai',
        consent,
        key: KEY,
        keyProvider: 'openai',
        options: { model: 'm' },
      })
      expect(tested, String(consent)).toEqual({
        status: 409,
        body: { error: 'consentRequired', provider: 'openai-compatible', origin: new URL(OPENROUTER).origin },
      })
    }
    expect(w.installation.setup.consents('alpha')).toEqual([])
    expect(accountOf(w, 'alpha')).not.toHaveProperty('provider')
  })

  it('does not send a typed key to the inherited server under the name of the key of OpenAI', async () => {
    const fake = await fakeServer()
    const w = await world({ accounts: [], config: { ...BASE, provider: { openai: { baseUrl: fake.url } } } })
    await wizard(w)
    // The consent is recorded for that server, so only the key check is left to stop it.
    w.installation.setup.recordConsent('alpha', 'openai-compatible', CONSENT_TEXT_VERSION, new URL(fake.url).origin)
    for (const keyProvider of [undefined, 'openai']) {
      const body = { provider: 'openai', key: KEY, keyProvider, options: { model: 'm' } }
      expect(await w.api('POST', '/api/setup/test-provider', body), String(keyProvider)).toEqual({
        status: 400,
        body: { error: 'invalidRequest' },
      })
    }
    expect(fake.authorizations).toEqual([])
    const ok = await w.api('POST', '/api/setup/test-provider', {
      provider: 'openai',
      key: KEY,
      keyProvider: 'openai-compatible',
      options: { model: 'm' },
    })
    expect(ok.body.ok).toBe(true)
    expect(fake.authorizations).toEqual([`Bearer ${KEY}`])
  })

  it('takes the key of the recipient, `true` for the ones whose recipient is fixed, and the key of another as a refusal', async () => {
    const w = await world({ accounts: [] })
    await wizard(w)
    const gemini = { from: 'provider', provider: 'gemini', options: { model: 'g' } }
    expect((await w.api('PUT', '/api/setup', { ...gemini, consent: 'openai' })).status).toBe(409)
    expect((await w.api('PUT', '/api/setup', { ...gemini, consent: 'gemini' })).status).toBe(200)
  })
})

describe('what the test says of a key the server refuses (RF-41)', () => {
  const wizard = async (w: World) => {
    await w.api('PUT', '/api/setup', { from: 'you', accountId: 'alpha', ownerName: 'Test Owner' })
  }

  it('says noKey, not rejected, when the server answers 401 and no key was sent', async () => {
    const fake = await fakeServer(401)
    const w = await world({ accounts: [] })
    await wizard(w)
    const body = { provider: 'openai', consent: 'openai-compatible', options: { model: 'm', baseUrl: fake.url } }
    expect((await w.api('POST', '/api/setup/test-provider', body)).body).toEqual({ ok: false, error: 'noKey' })
    expect(fake.authorizations).toEqual([undefined])
    const typed = await w.api('POST', '/api/setup/test-provider', {
      ...body,
      key: KEY,
      keyProvider: 'openai-compatible',
    })
    expect(typed.body).toEqual({ ok: false, error: 'rejected' })
  })

  it('classifies the 400 of Gemini for a key it does not know as rejected, and no other 400', () => {
    expect(classifyProviderError('gemini answered 400: API key not valid. Please pass a valid API key.')).toBe(
      'rejected',
    )
    expect(classifyProviderError('gemini answered 400: Request contains an invalid argument.')).toBe('failed')
    expect(classifyProviderError('anthropic answered 400: API key not valid')).toBe('failed')
    expect(classifyProviderError('openai answered 401: nope')).toBe('rejected')
    expect(classifyProviderError('anthropic answered 403: nope')).toBe('rejected')
  })
})

describe('what the daemon does not run, and the address of Ollama that goes back to the inherited one', () => {
  it('keys of an account that this daemon does not run are 422 restricted, for the listing and both writes', async () => {
    const w = await world({ accounts: ['alpha', 'beta'], only: 'alpha' })
    expect((await w.api('GET', '/api/accounts/alpha/keys')).status).toBe(200)
    const restricted = { status: 422, body: { error: 'restricted' } }
    expect(await w.api('GET', '/api/accounts/beta/keys')).toEqual(restricted)
    expect(await w.api('PUT', '/api/accounts/beta/keys/gemini', { key: KEY })).toEqual(restricted)
    expect(await w.api('DELETE', '/api/accounts/beta/keys/gemini')).toEqual(restricted)
    expect(existsSync(secretsOf(w))).toBe(false)
  })

  const REMOTE = 'http://10.0.0.5:11434'
  const LOCAL = 'http://127.0.0.1:11434'

  it('asks for the agreement again when removing the address of the account brings back a remote one, and only then', async () => {
    const w = await world({
      accounts: ['alpha'],
      config: { ...BASE, provider: { primary: 'ollama', ollama: { model: 'm', baseUrl: REMOTE } } },
    })
    const url = settingsUrl('alpha')
    // Nothing of the account's own yet: removing it changes nothing in force, so nothing is asked.
    expect((await w.api('PUT', url, { provider: { ollama: { baseUrl: null } } })).status).toBe(200)
    // The account keeps its own local address (recorded as consent-free: it is on this machine)...
    expect((await w.api('PUT', url, { provider: { ollama: { baseUrl: LOCAL } } })).status).toBe(200)
    // ...and going back to the remote installation's one is a new recipient.
    const back = await w.api('PUT', url, { provider: { ollama: { baseUrl: null } } })
    expect(back).toEqual({
      status: 409,
      body: { error: 'consentRequired', provider: 'ollama-remote', origin: new URL(REMOTE).origin },
    })
    expect(accountOf(w, 'alpha')).toMatchObject({ provider: { ollama: { baseUrl: LOCAL } } })
    expect(
      (await w.api('POST', '/api/accounts/alpha/consents', { provider: 'ollama-remote', baseUrl: REMOTE })).status,
    ).toBe(201)
    expect((await w.api('PUT', url, { provider: { ollama: { baseUrl: null } } })).status).toBe(200)
  })
})

describe('the agreement is for the destination that was shown, also when the address is emptied (RNF-02)', () => {
  const OPENROUTER = 'https://openrouter.ai/api/v1'
  const OWN = 'http://127.0.0.1:1234/v1'
  const OPENAI_ORIGIN = 'https://api.openai.com'
  const choose = { provider: { primary: 'openai', openai: { model: 'm' } } }
  const clear = { provider: { primary: 'openai', openai: { model: 'm', baseUrl: null } } }
  const consents = '/api/accounts/alpha/consents'
  const hostsOf = (w: World) => w.installation.setup.consents('alpha').map((c) => `${c.provider}:${c.hosts}`)
  const installationWith = (baseUrl: string) =>
    world({ accounts: ['alpha'], config: { ...BASE, provider: { openai: { baseUrl } } } })

  it('names the origin of the inherited server in the 409, and records only an explicit address for it', async () => {
    const w = await installationWith(OPENROUTER)
    const asked = await w.api('PUT', settingsUrl('alpha'), choose)
    expect(asked).toEqual({
      status: 409,
      body: { error: 'consentRequired', provider: 'openai-compatible', origin: new URL(OPENROUTER).origin },
    })
    // Without an address the agreement would be for whatever is in force: refused, nothing recorded.
    expect((await w.api('POST', consents, { provider: 'openai-compatible' })).status).toBe(400)
    // An address that makes the key not apply (OpenAI itself) is refused too.
    expect((await w.api('POST', consents, { provider: 'openai-compatible', baseUrl: OPENAI_ORIGIN })).status).toBe(400)
    expect(hostsOf(w)).toEqual([])
    // With the origin the 409 gave, it is recorded for that server, and the same save goes through (no second 409).
    expect((await w.api('POST', consents, { provider: 'openai-compatible', baseUrl: asked.body.origin })).status).toBe(
      201,
    )
    expect(hostsOf(w)).toEqual([`openai-compatible:${new URL(OPENROUTER).origin}`])
    expect((await w.api('PUT', settingsUrl('alpha'), choose)).status).toBe(200)
  })

  it('clearing an address of the account brings back the installation one: asked for that one, once', async () => {
    const w = await installationWith(OPENROUTER)
    // The account has a server of its own, with its agreement.
    await w.api('POST', consents, { provider: 'openai-compatible', baseUrl: OWN })
    expect(
      (
        await w.api('PUT', settingsUrl('alpha'), {
          provider: { primary: 'openai', openai: { model: 'm', baseUrl: OWN } },
        })
      ).status,
    ).toBe(200)
    // Emptying the field: the destination is now the installation's, which was never shown or agreed to.
    const asked = await w.api('PUT', settingsUrl('alpha'), clear)
    expect(asked).toEqual({
      status: 409,
      body: { error: 'consentRequired', provider: 'openai-compatible', origin: new URL(OPENROUTER).origin },
    })
    expect(hostsOf(w)).toEqual([`openai-compatible:${new URL(OWN).origin}`])
    expect((await w.api('POST', consents, { provider: 'openai-compatible', baseUrl: asked.body.origin })).status).toBe(
      201,
    )
    expect((await w.api('PUT', settingsUrl('alpha'), clear)).status).toBe(200)
    expect(hostsOf(w).sort()).toEqual(
      [`openai-compatible:${new URL(OWN).origin}`, `openai-compatible:${new URL(OPENROUTER).origin}`].sort(),
    )
  })

  it('does not trap the user with an own address of OpenAI itself, nor when emptying one that was a server', async () => {
    // The account says api.openai.com although the installation says another server.
    const own = await installationWith(OPENROUTER)
    expect(
      (await own.api('PUT', settingsUrl('alpha'), { provider: { openai: { baseUrl: `${OPENAI_ORIGIN}/v1` } } })).status,
    ).toBe(200)
    const asked = await own.api('PUT', settingsUrl('alpha'), choose)
    expect(asked).toEqual({ status: 409, body: { error: 'consentRequired', provider: 'openai' } })
    expect((await own.api('POST', consents, { provider: 'openai', baseUrl: OPENAI_ORIGIN })).status).toBe(201)
    expect((await own.api('PUT', settingsUrl('alpha'), choose)).status).toBe(200)

    // The account had a server and empties it: OpenAI itself is the destination, and recording needs the address the page sends.
    const back = await world({ accounts: ['alpha'] })
    await back.api('POST', consents, { provider: 'openai-compatible', baseUrl: OWN })
    await back.api('PUT', settingsUrl('alpha'), {
      provider: { primary: 'openai', openai: { model: 'm', baseUrl: OWN } },
    })
    expect((await back.api('PUT', settingsUrl('alpha'), clear)).body).toEqual({
      error: 'consentRequired',
      provider: 'openai',
    })
    expect((await back.api('POST', consents, { provider: 'openai', baseUrl: OPENAI_ORIGIN })).status).toBe(201)
    expect((await back.api('PUT', settingsUrl('alpha'), clear)).status).toBe(200)
  })
})
