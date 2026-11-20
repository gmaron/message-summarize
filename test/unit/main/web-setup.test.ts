import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { makeSchedule } from '../../../src/domain/schedule.js'
import { CONSENT_TEXT_VERSION, consentHostsKey } from '../../../src/domain/setup.js'
import { PROVIDER_INFO } from '../../../src/infrastructure/llm/index.js'
import { openInstallation } from '../../../src/main/accounts.js'
import { TEST_TRANSCRIPT } from '../../../src/main/provider-test.js'
import { disposeHarnesses, until } from '../../support/cli-harness.js'
import { CLAUDE_HELP } from '../../support/fake-cli.js'
import { allowSubprocess } from '../../support/network-guard.js'
import { isWindows } from '../../support/platform.js'
// On Windows the tests that run the fake CLI are skipped: it is a script with a shebang, and the adapters spawn without
// a shell (RF-49), so Windows cannot execute it (a .cmd wrapper would need `shell: true`, which the rule forbids).
// The behavior they check is cross-platform code; it is covered on Linux and macOS.
import { BASE, disposeWorlds, type World, world } from '../../support/web-world.js'

// The only subprocess this file spawns is the fake `claude` script it writes below (a node script that prints canned
// JSON and never touches the network), and the only server is a fake Ollama on 127.0.0.1.

const VALID = { resumen: 'A made-up chat.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' }
const SECRET_NAME = 'Zulema-Privada'
const SECRET_NUMBER = '5491100000009'

let dir: string
const revoke: Array<() => void> = []
const servers: Server[] = []
let seq = 0

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'msum-setup-test-')))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
  for (const undo of revoke.splice(0)) undo()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

interface Call {
  argv: string[]
  cwd: string
  cwdEntries: string[]
  stdin: string
}

type Mode = 'ok' | 'hang' | 'bad' | 'fail' | 'slow'

/** A fake `claude` whose behavior is read from a file at each call, and that records what it was given. */
function fakeClaude(initial: Mode = 'ok') {
  seq += 1
  const file = join(dir, `claude-${seq}`)
  const record = join(dir, `calls-${seq}.jsonl`)
  const modeFile = join(dir, `mode-${seq}`)
  writeFileSync(record, '')
  writeFileSync(modeFile, initial)
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs')
// RF-49: the daemon runs the CLI only after checking with --help that it has the flags that turn the tools off.
const first = process.argv[2]
if (first === '--help') { process.stdout.write(${JSON.stringify(CLAUDE_HELP)}); process.exit(0) }
if (first === '--version') { process.stdout.write('claude 9.9.9 (fake)\\n'); process.exit(0) }
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (stdin += d))
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({
    argv: process.argv.slice(2), cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), stdin,
  }) + '\\n')
  const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8')
  const good = { is_error: false, subtype: 'success', structured_output: ${JSON.stringify(VALID)} }
  if (mode === 'hang') { setInterval(() => {}, 1000); return }
  if (mode === 'fail') { process.stderr.write('boom'); process.exitCode = 2; return }
  if (mode === 'bad') { process.stdout.write(JSON.stringify({ is_error: false, structured_output: { resumen: 1 } })); return }
  if (mode === 'slow') { setTimeout(() => process.stdout.write(JSON.stringify(good)), 800); return }
  process.stdout.write(JSON.stringify(good))
})
`,
  )
  chmodSync(file, 0o755)
  revoke.push(allowSubprocess(file))
  return {
    file,
    setMode: (mode: Mode) => writeFileSync(modeFile, mode),
    calls: (): Call[] =>
      readFileSync(record, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call),
  }
}

type OllamaHandler = (body: Record<string, unknown>, res: ServerResponse) => void

async function fakeOllama(handler: OllamaHandler) {
  const requests: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      requests.push(body)
      handler(body, res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

const answer = (res: ServerResponse, content: unknown) =>
  res.end(
    JSON.stringify({
      message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) },
    }),
  )

const rootOf = (w: World) => JSON.parse(readFileSync(w.h.layout.configFile, 'utf8')) as Record<string, unknown>
const accountOf = (w: World, id: string) =>
  JSON.parse(readFileSync(w.h.accountOf(id).configFile, 'utf8')) as Record<string, unknown>
const get = (w: World) => w.api('GET', '/api/setup')
const put = (w: World, body: unknown) => w.api('PUT', '/api/setup', body)

/** A world whose environment lets a fake binary run (the harness's is empty) and whose tests are short. */
async function testWorld(options: Parameters<typeof world>[0] = {}, timeoutMs = 5_000): Promise<World> {
  const w = await world(options)
  Object.assign(w.h.ctx.env, { PATH: process.env.PATH ?? '' })
  Object.assign(w.h.ctx, { web: { ...w.h.ctx.web, providerTestTimeoutMs: timeoutMs } })
  return w
}

/** Moves a fresh wizard up to the "provider" step with account `alpha`. */
async function toProvider(w: World, id = 'alpha') {
  const named = await put(w, { from: 'you', accountId: id, ownerName: SECRET_NAME, language: 'en' })
  expect(named.status).toBe(200)
  expect(named.body.step).toBe('provider')
}

describe('the setup state (RF-70)', () => {
  it('is behind the token on every route', async () => {
    const w = await world({ accounts: [] })
    for (const [method, path, body] of [
      ['GET', '/api/setup', undefined],
      ['PUT', '/api/setup', { from: 'you', ownerName: 'Ana', language: 'es' }],
      ['POST', '/api/setup/skip', undefined],
      ['POST', '/api/setup/test-provider', { provider: 'ollama' }],
      ['POST', '/api/accounts/alpha/consents', { provider: 'claude-cli' }],
    ] as const) {
      expect((await w.api(method, path, body, null)).status, `${method} ${path}`).toBe(401)
      expect((await w.api(method, path, body, 'wrong')).status, `${method} ${path}`).toBe(401)
    }
    expect(w.installation.setup.get()).toBeNull()
    expect(rootOf(w).language).toBe('en')
  })

  it('starts at the first step on an installation with nothing linked', async () => {
    const w = await world({ accounts: [] })
    expect(await get(w)).toEqual({
      status: 200,
      body: {
        completed: false,
        step: 'you',
        account: null,
        linked: false,
        language: 'en',
        freshInstall: false,
        consents: [],
        openaiBaseUrl: 'https://api.openai.com/v1',
        ollamaBaseUrl: 'http://127.0.0.1:11434',
      },
    })
  })

  it('counts an installation that already has a linked account as completed, and keeps it so', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    const first = await get(w)
    expect(first.body).toMatchObject({ completed: true, account: null })
    // Decided once: unlinking later does not bring the wizard back.
    rmSync(w.h.accountOf('alpha').authDir, { recursive: true, force: true })
    expect((await get(w)).body.completed).toBe(true)
    expect(w.installation.setup.get()?.completedAt).not.toBeNull()
  })

  it('does not count an account that is not linked as an installation that is set up', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect((await get(w)).body).toMatchObject({ completed: false, step: 'you' })
  })

  it('skipping marks it completed, and a completed wizard does not move', async () => {
    const w = await world({ accounts: [] })
    expect((await w.api('POST', '/api/setup/skip')).body.completed).toBe(true)
    expect(await put(w, { from: 'you', ownerName: 'Ana', language: 'es' })).toEqual({
      status: 409,
      body: { error: 'setupCompleted' },
    })
    expect(rootOf(w).language).toBe('en')
    expect((await get(w)).body.completed).toBe(true)
  })

  it('refuses a step that is not the current one, a bad body and a jump forward', async () => {
    const w = await world({ accounts: [] })
    expect(await put(w, { from: 'provider' })).toEqual({ status: 409, body: { error: 'wrongStep' } })
    expect((await put(w, { from: 'nonsense' })).status).toBe(400)
    expect((await put(w, 'text')).status).toBe(400)
    expect((await put(w, { goto: 'link' })).status).toBe(400)
    expect((await put(w, { goto: 'you' })).status).toBe(400)
    expect((await put(w, { from: 'language', language: 'es' })).status).toBe(400)
    expect((await get(w)).body.step).toBe('you')
  })
})

/** The first step with the language the page sends (the browser's), for the account `alpha`. */
const you = (w: World, language: unknown, extra: Record<string, unknown> = {}) =>
  put(w, { from: 'you', accountId: 'alpha', ownerName: 'Ana', language, ...extra })

/** What `msum init` writes for the language: the one a fresh install still has. */
const FRESH = { ...BASE, language: 'es' }

describe('what the daemon calls a fresh install', () => {
  it('is no account, no progress and the init language: only then the page may speak the browser language', async () => {
    const fresh = await world({ accounts: [], config: FRESH })
    expect((await get(fresh)).body).toMatchObject({ freshInstall: true, language: 'es' })
    // Progress: the first step is saved, so it is not fresh any more (nor after going back to it).
    await you(fresh, 'en')
    expect((await get(fresh)).body.freshInstall).toBe(false)
    await put(fresh, { goto: 'you' })
    expect((await get(fresh)).body.freshInstall).toBe(false)
  })

  it('is not when the language is not the init one, when an account exists, or when the wizard is over', async () => {
    expect((await get(await world({ accounts: [], config: { ...BASE, language: 'en' } }))).body.freshInstall).toBe(
      false,
    )
    expect((await get(await world({ accounts: ['alpha'], config: FRESH }))).body.freshInstall).toBe(false)
    const over = await world({ accounts: [], config: FRESH })
    await w_skip(over)
    expect((await get(over)).body.freshInstall).toBe(false)
  })
})

const w_skip = (w: World) => w.api('POST', '/api/setup/skip')

describe('the first step takes the browser language only on a fresh install', () => {
  it('writes only `language`, keeps every other key and the 0600 mode, and the page hears it from /api/info', async () => {
    const config = { ...FRESH, hideRest: true, excludePatterns: ['id:keep'], web: { port: 9999 } }
    const w = await world({ accounts: [], config })
    chmodSync(w.h.layout.configFile, 0o600)
    const before = rootOf(w)
    expect((await w.api('GET', '/api/info')).body.language).toBe('es')
    const reply = await you(w, 'en')
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ step: 'provider', language: 'en' })
    expect(rootOf(w)).toEqual({ ...before, language: 'en' })
    if (!isWindows) expect(statSync(w.h.layout.configFile).mode & 0o777).toBe(0o600)
    expect((await w.api('GET', '/api/info')).body.language).toBe('en')
  })

  it('takes the time zone of the browser on a fresh install, with the language', async () => {
    const w = await world({ accounts: [], config: FRESH })
    const reply = await you(w, 'en', { timezone: 'America/Argentina/Buenos_Aires' })
    expect(reply.status).toBe(200)
    expect(rootOf(w)).toMatchObject({ language: 'en', timezone: 'America/Argentina/Buenos_Aires' })
  })

  it('takes the time zone alone when the browser language is the init one', async () => {
    const w = await world({ accounts: [], config: FRESH })
    expect((await you(w, 'es', { timezone: 'Europe/Madrid' })).status).toBe(200)
    expect(rootOf(w)).toMatchObject({ language: 'es', timezone: 'Europe/Madrid' })
  })

  it('ignores a time zone that is not a valid IANA name, and refuses one that is not text', async () => {
    const w = await world({ accounts: [], config: FRESH })
    const before = readFileSync(w.h.layout.configFile, 'utf8')
    expect((await you(w, 'es', { timezone: 'Mars/Olympus' })).status).toBe(200)
    expect(readFileSync(w.h.layout.configFile, 'utf8')).toBe(before)
    const other = await world({ accounts: [], config: FRESH })
    expect((await you(other, 'es', { timezone: 7 })).status).toBe(400)
    expect(other.installation.accounts()).toEqual([])
  })

  it('leaves the time zone alone when it is not a fresh install', async () => {
    const existing = await world({ accounts: ['alpha'], config: FRESH })
    const before = readFileSync(existing.h.layout.configFile, 'utf8')
    expect((await you(existing, 'en', { timezone: 'Europe/Madrid' })).status).toBe(200)
    expect(readFileSync(existing.h.layout.configFile, 'utf8')).toBe(before)
    // Back to the first step after it was saved: the zone the user may have set in the settings stays.
    const w = await world({ accounts: [], config: FRESH })
    expect((await you(w, 'en', { timezone: 'Europe/Madrid' })).status).toBe(200)
    writeFileSync(w.h.layout.configFile, `${JSON.stringify({ ...rootOf(w), timezone: 'Asia/Tokyo' })}\n`)
    await put(w, { goto: 'you' })
    expect((await you(w, 'en', { timezone: 'Europe/Madrid' })).status).toBe(200)
    expect(rootOf(w).timezone).toBe('Asia/Tokyo')
  })

  it('keeps an installation language that is not the init default, whatever the browser says', async () => {
    const w = await world({ accounts: [], config: { ...BASE, language: 'en' } })
    const before = readFileSync(w.h.layout.configFile, 'utf8')
    expect((await you(w, 'es')).status).toBe(200)
    expect(readFileSync(w.h.layout.configFile, 'utf8')).toBe(before)
  })

  it('keeps the language when an account already exists (an existing installation, an English browser)', async () => {
    const w = await world({ accounts: ['alpha'], config: FRESH })
    const before = readFileSync(w.h.layout.configFile, 'utf8')
    expect((await you(w, 'en')).status).toBe(200)
    expect(readFileSync(w.h.layout.configFile, 'utf8')).toBe(before)
    expect(rootOf(w).language).toBe('es')
  })

  it('does not change it when the user goes back to the first step and continues', async () => {
    const w = await world({ accounts: [], config: FRESH })
    expect((await you(w, 'en')).status).toBe(200)
    // The user picks Spanish in the settings (the file says so), then goes back and continues with an English browser.
    writeFileSync(w.h.layout.configFile, `${JSON.stringify({ ...rootOf(w), language: 'es' })}\n`)
    expect((await put(w, { goto: 'you' })).body).toMatchObject({ step: 'you', account: 'alpha' })
    expect((await you(w, 'en')).status).toBe(200)
    expect(rootOf(w).language).toBe('es')
  })

  it('leaves the language alone when the body brings none', async () => {
    const w = await world({ accounts: [], config: FRESH })
    const before = readFileSync(w.h.layout.configFile, 'utf8')
    expect((await you(w, undefined)).status).toBe(200)
    expect(readFileSync(w.h.layout.configFile, 'utf8')).toBe(before)
  })

  it('refuses a language that does not exist and changes nothing, not even the account', async () => {
    const w = await world({ accounts: [], config: FRESH })
    const before = readFileSync(w.h.layout.configFile, 'utf8')
    expect((await you(w, 'fr')).status).toBe(400)
    expect((await you(w, 3)).status).toBe(400)
    expect(readFileSync(w.h.layout.configFile, 'utf8')).toBe(before)
    expect(w.installation.accounts()).toEqual([])
    expect((await get(w)).body.step).toBe('you')
  })

  it('writes no language when the account of the step is refused', async () => {
    // Ollama without a model is not valid on its own: the account's file cannot be written, and nothing else is.
    const w = await world({ accounts: [], config: { ...FRESH, provider: { primary: 'ollama' } } })
    const reply = await you(w, 'en')
    expect(reply.status).toBe(422)
    expect(rootOf(w)).toEqual({ ...FRESH, provider: { primary: 'ollama' } })
  })

  it('does not rewrite a file that is not valid JSON', async () => {
    const w = await world({ accounts: [] })
    writeFileSync(w.h.layout.configFile, '{ not json')
    const reply = await you(w, 'en')
    expect(reply.status).toBeGreaterThanOrEqual(400)
    expect(readFileSync(w.h.layout.configFile, 'utf8')).toBe('{ not json')
  })

  it('creates the file, as `msum init` would, when there is none', async () => {
    const w = await world({ accounts: [] })
    rmSync(w.h.layout.configFile)
    expect(existsSync(w.h.layout.configFile)).toBe(false)
    expect((await you(w, 'en')).status).toBe(200)
    const created = rootOf(w)
    expect(created.language).toBe('en')
    expect(created.provider).toMatchObject({ primary: null })
  })
})

describe('the first step creates the account', () => {
  it('creates `default`, writes the owner name into ITS file and moves on', async () => {
    const w = await world({ accounts: [] })
    const reply = await put(w, { from: 'you', ownerName: `  ${SECRET_NAME}  ` })
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ step: 'provider', account: 'default', linked: false })
    expect(w.installation.accounts().map((row) => row.id)).toEqual(['default'])
    expect(accountOf(w, 'default')).toEqual({ ownerName: SECRET_NAME })
    expect(rootOf(w)).not.toHaveProperty('ownerName')
  })

  it('takes the id given, validated like POST /api/accounts, and a name that is not blank', async () => {
    const w = await world({ accounts: [] })
    expect(await put(w, { from: 'you', accountId: '../x', ownerName: 'Ana' })).toEqual({
      status: 400,
      body: { error: 'invalidAccountId' },
    })
    expect((await put(w, { from: 'you', ownerName: '   ' })).status).toBe(400)
    expect((await put(w, { from: 'you', ownerName: 'x'.repeat(81) })).status).toBe(400)
    expect((await put(w, { from: 'you', ownerName: 'Ana', accountId: 7 })).status).toBe(400)
    expect(w.installation.accounts()).toEqual([])
    expect((await put(w, { from: 'you', accountId: 'casa', ownerName: 'Ana' })).body).toMatchObject({
      account: 'casa',
    })
  })

  it('adopts an account of the command line that is not linked, and refuses one that is', async () => {
    const w = await world({ accounts: ['alpha', 'beta'] })
    // The wizard state is decided at the first look, before any account is linked.
    await get(w)
    w.linked('beta')
    expect(await put(w, { from: 'you', accountId: 'beta', ownerName: 'Ana' })).toEqual({
      status: 409,
      body: { error: 'accountExists' },
    })
    const adopted = await put(w, { from: 'you', accountId: 'alpha', ownerName: 'Ana' })
    expect(adopted.body).toMatchObject({ account: 'alpha', step: 'provider' })
    expect(accountOf(w, 'alpha')).toEqual({ ownerName: 'Ana' })
    expect(w.installation.accounts().map((row) => row.id)).toEqual(['alpha', 'beta'])
  })

  it('going back and continuing again edits the name, and the account cannot change', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w, 'alpha')
    expect((await put(w, { goto: 'you' })).body).toMatchObject({ step: 'you', account: 'alpha' })
    expect((await put(w, { from: 'you', accountId: 'beta', ownerName: 'Ana' })).status).toBe(400)
    expect((await put(w, { from: 'you', ownerName: 'Ana B' })).body).toMatchObject({ step: 'provider' })
    expect(accountOf(w, 'alpha')).toEqual({ ownerName: 'Ana B' })
    expect(w.installation.accounts().map((row) => row.id)).toEqual(['alpha'])
  })

  it('forgets an account that was deleted meanwhile and asks for the name again', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w, 'alpha')
    await w.installation.deleteAccount('alpha')
    expect((await get(w)).body).toMatchObject({ step: 'you', account: null })
  })
})

describe('the provider step and the consent (RF-41, RNF-02)', () => {
  it('does not record anything for Ollama, and needs a model', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w)
    const missing = await put(w, { from: 'provider', provider: 'ollama' })
    expect(missing.status).toBe(422)
    expect(missing.body).toMatchObject({ error: 'invalidConfig', issues: [{ code: 'required' }] })
    expect((await put(w, { from: 'provider', provider: 'ollama', options: { baseUrl: 'ftp://x' } })).status).toBe(422)
    const saved = await put(w, {
      from: 'provider',
      provider: 'ollama',
      options: { model: 'qwen3:4b', baseUrl: 'http://127.0.0.1:11434' },
    })
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ step: 'link', consents: [] })
    expect(accountOf(w, 'alpha')).toMatchObject({
      provider: { primary: 'ollama', ollama: { model: 'qwen3:4b', baseUrl: 'http://127.0.0.1:11434' } },
    })
    expect(w.installation.setup.consents('alpha')).toEqual([])
  })

  it('refuses an external provider without the consent, and writes and records nothing', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w)
    const before = readFileSync(w.h.accountOf('alpha').configFile, 'utf8')
    expect(await put(w, { from: 'provider', provider: 'claude-cli' })).toEqual({
      status: 409,
      body: { error: 'consentRequired', provider: 'claude-cli' },
    })
    expect((await put(w, { from: 'provider', provider: 'claude-cli', consent: 'yes' })).status).toBe(409)
    expect(readFileSync(w.h.accountOf('alpha').configFile, 'utf8')).toBe(before)
    expect(w.installation.setup.consents('alpha')).toEqual([])
    expect((await get(w)).body.step).toBe('provider')
  })

  it('records the consent (account, provider, version, time) and saves the choice', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w)
    const saved = await put(w, {
      from: 'provider',
      provider: 'claude-cli',
      options: { model: 'opus' },
      consent: true,
    })
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ step: 'link', consents: ['claude-cli'] })
    expect(accountOf(w, 'alpha')).toMatchObject({ provider: { primary: 'claude-cli', claudeCli: { model: 'opus' } } })
    const [row] = w.installation.setup.consents('alpha')
    expect(row).toMatchObject({ provider: 'claude-cli', textVersion: CONSENT_TEXT_VERSION })
    expect(Number.isNaN(Date.parse(row?.givenAt ?? ''))).toBe(false)
  })

  it('does not record a consent for a choice that cannot be saved', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w)
    const reply = await put(w, { from: 'provider', provider: 'claude-cli', options: { model: 7 }, consent: true })
    expect(reply.status).toBe(400)
    writeFileSync(w.h.accountOf('alpha').configFile, '{ broken')
    const broken = await put(w, { from: 'provider', provider: 'claude-cli', consent: true })
    expect(broken.status).toBe(422)
    expect(w.installation.setup.consents('alpha')).toEqual([])
  })

  it('a provider that is not one of ours is a bad request', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w)
    expect((await put(w, { from: 'provider', provider: 'generic-cli' })).status).toBe(400)
    expect((await put(w, { from: 'provider', provider: 'ollama', options: 'x' })).status).toBe(400)
  })
})

describe('the settings ask for the consent too (RNF-02)', () => {
  const url = '/api/accounts/alpha/settings'

  it('answers 409 consentRequired for an external provider without consent, then lets it through once recorded', async () => {
    const w = await world({
      accounts: ['alpha'],
      config: { language: 'en', timezone: 'UTC', provider: { primary: 'ollama', ollama: { model: 'qwen3:4b' } } },
    })
    const file = w.h.accountOf('alpha').configFile
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null
    for (const option of ['primary', 'backup']) {
      expect(await w.api('PUT', url, { provider: { [option]: 'claude-cli' } })).toEqual({
        status: 409,
        body: { error: 'consentRequired', provider: 'claude-cli' },
      })
    }
    expect(existsSync(file) ? readFileSync(file, 'utf8') : null).toBe(before)
    expect(await w.api('POST', '/api/accounts/alpha/consents', { provider: 'claude-cli' })).toEqual({
      status: 201,
      body: { provider: 'claude-cli', textVersion: CONSENT_TEXT_VERSION },
    })
    const retried = await w.api('PUT', url, { provider: { primary: 'claude-cli' } })
    expect(retried.status).toBe(200)
    expect((retried.body.values as { provider: { primary: string } }).provider.primary).toBe('claude-cli')
    // The consent belongs to the account: another one still needs its own.
    await w.installation.createAccount('beta')
    expect((await w.api('PUT', '/api/accounts/beta/settings', { provider: { primary: 'claude-cli' } })).status).toBe(
      409,
    )
  })

  it('does not ask for Ollama, for clearing the provider, or for editing what the file already holds', async () => {
    const w = await world({ accounts: ['alpha'] })
    // BASE already has claude-cli as the primary (set by hand): editing its model is not a change of provider.
    expect((await w.api('PUT', url, { provider: { claudeCli: { model: 'opus' } } })).status).toBe(200)
    expect((await w.api('PUT', url, { provider: { primary: 'ollama', ollama: { model: 'qwen3:4b' } } })).status).toBe(
      200,
    )
    expect((await w.api('PUT', url, { provider: { backup: null } })).status).toBe(200)
    expect((await w.api('PUT', url, { provider: { primary: null } })).status).toBe(200)
  })

  it('records consents only for external providers and only for accounts that exist', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect((await w.api('POST', '/api/accounts/alpha/consents', { provider: 'ollama' })).status).toBe(400)
    expect((await w.api('POST', '/api/accounts/alpha/consents', { provider: 'nope' })).status).toBe(400)
    expect((await w.api('POST', '/api/accounts/alpha/consents', {})).status).toBe(400)
    expect((await w.api('POST', '/api/accounts/ghost/consents', { provider: 'claude-cli' })).status).toBe(404)
    expect(w.installation.setup.consents('alpha')).toEqual([])
    // Twice is one row.
    await w.api('POST', '/api/accounts/alpha/consents', { provider: 'claude-cli' })
    await w.api('POST', '/api/accounts/alpha/consents', { provider: 'claude-cli' })
    expect(w.installation.setup.consents('alpha')).toHaveLength(1)
  })
})

describe('the whole wizard, and resuming it', () => {
  it('goes through every step, can be closed halfway and resumed, and ends completed', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w)
    expect((await put(w, { from: 'provider', provider: 'claude-cli', consent: true })).body.step).toBe('link')
    // Closed here: the state is in app.db, so another connection (another run of the daemon) finds it.
    const reopened = await openInstallation({ layout: w.h.layout, clock: w.h.clock })
    if (!reopened.ok) throw new Error('could not reopen')
    try {
      expect(reopened.installation.setup.get()).toMatchObject({ step: 'link', account: 'alpha', completedAt: null })
      // Recorded with what was disclosed (the hosts of Claude Code) and the current text.
      expect(
        reopened.installation.setup.hasConsent(
          'alpha',
          'claude-cli',
          consentHostsKey(PROVIDER_INFO['claude-cli'].hosts),
          CONSENT_TEXT_VERSION,
        ),
      ).toBe(true)
    } finally {
      reopened.installation.close()
    }
    // Not linked: it cannot continue.
    expect(await put(w, { from: 'link' })).toEqual({ status: 409, body: { error: 'notLinked' } })
    w.linked('alpha')
    expect((await get(w)).body).toMatchObject({ step: 'link', linked: true })
    expect((await put(w, { from: 'link' })).body.step).toBe('done')
    expect((await put(w, { goto: 'link' })).body.step).toBe('link')
    expect((await put(w, { from: 'link' })).body.step).toBe('done')
    // Nothing is asked about the schedules: they appear when the wizard completes.
    expect(w.installation.schedules.list('alpha')).toEqual([])
    const done = await put(w, { from: 'done' })
    expect(done.body).toMatchObject({ completed: true })
    expect((await get(w)).body.completed).toBe(true)
    expect(
      w.installation.schedules
        .list('alpha')
        .map((row) => [row.schedule.hour, row.schedule.minute, row.schedule.days.length]),
    ).toEqual([
      [9, 0, 7],
      [18, 0, 7],
    ])
  })

  it('skipping the wizard creates no schedules', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w)
    expect((await w.api('POST', '/api/setup/skip')).body.completed).toBe(true)
    expect(w.installation.schedules.list('alpha')).toEqual([])
  })

  it('does not finish with an account that is not linked, even if the stored step says done', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w)
    w.installation.setup.save('done', 'alpha')
    expect(await put(w, { from: 'done' })).toEqual({ status: 409, body: { error: 'notLinked' } })
    expect(w.installation.schedules.list('alpha')).toEqual([])
    expect((await get(w)).body.completed).toBe(false)
  })

  it('keeps the schedules the account already has when the wizard completes', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w)
    await put(w, { from: 'provider', provider: 'claude-cli', consent: true })
    w.linked('alpha')
    await put(w, { from: 'link' })
    const own = makeSchedule([1], '07:30')
    if (!own.ok) throw new Error('bad schedule')
    w.installation.schedules.add('alpha', own.value)
    expect((await put(w, { from: 'done' })).body).toMatchObject({ completed: true })
    expect(w.installation.schedules.list('alpha')).toHaveLength(1)
  })

  it.each([
    ['language', 'you'],
    ['name', 'you'],
    ['transcription', 'link'],
    ['schedule', 'link'],
  ])('resumes a wizard saved at the old step %s at %s, without crashing', async (old, expected) => {
    const w = await world({ accounts: [] })
    await toProvider(w)
    // What an installation of an older version has stored (the step column is plain text).
    w.installation.setup.save(old as never, 'alpha')
    expect((await get(w)).body).toMatchObject({ step: expected })
    // ...and it goes on from there: the old name is not a step to send, the new one is.
    expect((await put(w, { from: old })).status).toBe(400)
  })
})

describe('POST /api/setup/test-provider (RF-41, RF-49)', () => {
  const claude = { provider: 'claude-cli', consent: true }

  const withClaude = async (initial: Mode = 'ok', timeoutMs = 5_000) => {
    const fake = fakeClaude(initial)
    const w = await testWorld(
      {
        accounts: [],
        config: { ...BASE, provider: { primary: null, claudeCli: { command: fake.file, model: 'sonnet' } } },
      },
      timeoutMs,
    )
    await toProvider(w)
    return { w, fake }
  }

  it('needs an account to be set up first', async () => {
    const w = await testWorld({ accounts: [] })
    expect(await w.api('POST', '/api/setup/test-provider', { provider: 'ollama', options: { model: 'm' } })).toEqual({
      status: 409,
      body: { error: 'wrongStep' },
    })
  })

  it.skipIf(isWindows)(
    'makes a real call as the daemon does: without tools, in an empty directory, with a made-up chat only',
    async () => {
      const { w, fake } = await withClaude()
      const configBefore = readFileSync(w.h.accountOf('alpha').configFile, 'utf8')
      const reply = await w.api('POST', '/api/setup/test-provider', claude)
      expect(reply.status).toBe(200)
      expect(reply.body.ok).toBe(true)
      expect(typeof reply.body.ms).toBe('number')
      const [call] = fake.calls()
      expect(call?.argv).toEqual(
        expect.arrayContaining(['-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--safe-mode']),
      )
      expect(call?.argv[call.argv.indexOf('--tools') + 1]).toBe('')
      expect(call?.cwdEntries).toEqual([])
      expect(call?.stdin).toBe(TEST_TRANSCRIPT)
      // Nothing of the user in what was sent (stdin or arguments), and nothing saved by the test.
      const sent = `${call?.stdin}\n${call?.argv.join('\n')}`
      for (const secret of [SECRET_NAME, SECRET_NUMBER, 'alpha']) expect(sent).not.toContain(secret)
      expect(readFileSync(w.h.accountOf('alpha').configFile, 'utf8')).toBe(configBefore)
      expect(w.installation.setup.consents('alpha')).toEqual([])
    },
  )

  it.skipIf(isWindows)('does not run the claude test without the consent, ticked or recorded', async () => {
    const { w, fake } = await withClaude()
    expect(await w.api('POST', '/api/setup/test-provider', { provider: 'claude-cli' })).toEqual({
      status: 409,
      body: { error: 'consentRequired', provider: 'claude-cli' },
    })
    expect((await w.api('POST', '/api/setup/test-provider', { provider: 'claude-cli', consent: 'true' })).status).toBe(
      409,
    )
    expect(fake.calls()).toEqual([])
    w.installation.setup.recordConsent('alpha', 'claude-cli', CONSENT_TEXT_VERSION)
    expect((await w.api('POST', '/api/setup/test-provider', { provider: 'claude-cli' })).body.ok).toBe(true)
  })

  it.skipIf(isWindows)('reports the codes: timeout, missing command, invalid summary, failed', async () => {
    const { w, fake } = await withClaude('hang', 300)
    expect((await w.api('POST', '/api/setup/test-provider', claude)).body).toEqual({ ok: false, error: 'timeout' })
    fake.setMode('bad')
    expect((await w.api('POST', '/api/setup/test-provider', claude)).body).toEqual({
      ok: false,
      error: 'invalidSummary',
    })
    fake.setMode('fail')
    expect((await w.api('POST', '/api/setup/test-provider', claude)).body).toEqual({ ok: false, error: 'failed' })
    const missing = join(dir, 'does-not-exist')
    revoke.push(allowSubprocess(missing))
    writeFileSync(
      w.h.layout.configFile,
      JSON.stringify({ ...BASE, provider: { primary: null, claudeCli: { command: missing } } }),
    )
    expect((await w.api('POST', '/api/setup/test-provider', claude)).body).toEqual({ ok: false, error: 'notFound' })
  })

  it.skipIf(isWindows)('never waits longer than its limit, whatever the timeout of the configuration', async () => {
    const fake = fakeClaude('hang')
    const w = await testWorld(
      {
        accounts: [],
        config: { ...BASE, provider: { primary: null, claudeCli: { command: fake.file, timeoutMs: 600_000 } } },
      },
      250,
    )
    await toProvider(w)
    const started = Date.now()
    expect((await w.api('POST', '/api/setup/test-provider', claude)).body).toEqual({ ok: false, error: 'timeout' })
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it.skipIf(isWindows)('runs one test at a time', async () => {
    const { w, fake } = await withClaude('slow', 5_000)
    const first = w.api('POST', '/api/setup/test-provider', claude)
    await until(() => fake.calls().length === 1, 'the first test to reach the program')
    expect(await w.api('POST', '/api/setup/test-provider', claude)).toEqual({
      status: 409,
      body: { error: 'testRunning' },
    })
    expect((await first).body.ok).toBe(true)
    expect((await w.api('POST', '/api/setup/test-provider', claude)).body.ok).toBe(true)
    expect(fake.calls()).toHaveLength(2)
  })

  it('tests Ollama against the address given, with only the made-up chat, and needs no consent', async () => {
    const ollama = await fakeOllama((_body, res) => answer(res, VALID))
    const w = await testWorld({ accounts: [] })
    await toProvider(w)
    const reply = await w.api('POST', '/api/setup/test-provider', {
      provider: 'ollama',
      options: { baseUrl: ollama.url, model: 'qwen3:4b' },
    })
    expect(reply.body.ok).toBe(true)
    expect(ollama.requests).toHaveLength(1)
    const messages = ollama.requests[0]?.messages as { role: string; content: string }[]
    expect(ollama.requests[0]?.model).toBe('qwen3:4b')
    expect(messages.find((m) => m.role === 'user')?.content).toBe(TEST_TRANSCRIPT)
    expect(JSON.stringify(ollama.requests[0])).not.toContain(SECRET_NAME)
    expect(w.installation.setup.consents('alpha')).toEqual([])
  })

  it('reports Ollama problems: invalid summary, timeout, unreachable, a missing model', async () => {
    let mode: 'bad' | 'hang' | 'text' = 'bad'
    const ollama = await fakeOllama((_body, res) => {
      if (mode === 'hang') return
      if (mode === 'text') return answer(res, 'not json')
      answer(res, { resumen: 3 })
    })
    const w = await testWorld({ accounts: [] }, 300)
    await toProvider(w)
    const options = { baseUrl: ollama.url, model: 'm' }
    const test = () => w.api('POST', '/api/setup/test-provider', { provider: 'ollama', options })
    expect((await test()).body).toEqual({ ok: false, error: 'invalidSummary' })
    mode = 'text'
    expect((await test()).body).toEqual({ ok: false, error: 'invalidSummary' })
    mode = 'hang'
    expect((await test()).body).toEqual({ ok: false, error: 'timeout' })
    const closed = await fakeOllama(() => {})
    const dead = closed.url
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(
      (await w.api('POST', '/api/setup/test-provider', { provider: 'ollama', options: { baseUrl: dead, model: 'm' } }))
        .body,
    ).toEqual({ ok: false, error: 'unreachable' })
    const missing = await w.api('POST', '/api/setup/test-provider', { provider: 'ollama' })
    expect(missing.status).toBe(422)
    expect(missing.body).toMatchObject({ error: 'invalidConfig' })
  })

  it('a bad body is a bad request', async () => {
    const w = await testWorld({ accounts: [] })
    await toProvider(w)
    expect((await w.api('POST', '/api/setup/test-provider', { provider: 'nope' })).status).toBe(400)
    expect(
      (await w.api('POST', '/api/setup/test-provider', { provider: 'ollama', options: { model: 3 } })).status,
    ).toBe(400)
    expect((await w.api('POST', '/api/setup/test-provider')).status).toBe(400)
  })
})

describe('a backup of the installation never joins a test (RNF-02)', () => {
  it.skipIf(isWindows)('a failed Ollama test is not hidden by a backup that was never agreed to', async () => {
    const fake = fakeClaude('ok')
    const ollama = await fakeOllama((_body, res) => answer(res, { resumen: 3 }))
    const w = await testWorld({
      accounts: [],
      config: {
        ...BASE,
        provider: {
          primary: 'ollama',
          backup: 'claude-cli',
          ollama: { model: 'm' },
          claudeCli: { command: fake.file },
        },
      },
    })
    await toProvider(w)
    const reply = await w.api('POST', '/api/setup/test-provider', {
      provider: 'ollama',
      options: { baseUrl: ollama.url, model: 'm' },
    })
    expect(reply.body).toEqual({ ok: false, error: 'invalidSummary' })
    expect(fake.calls()).toEqual([])
  })
})

describe('an Ollama that is not on this machine needs the consent too (RNF-02)', () => {
  const REMOTE = 'http://10.0.0.5:11434'

  it('the wizard asks for it, writes nothing without it and records it under `ollama-remote`', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w)
    const before = readFileSync(w.h.accountOf('alpha').configFile, 'utf8')
    const body = { from: 'provider', provider: 'ollama', options: { model: 'm', baseUrl: REMOTE } }
    expect(await put(w, body)).toEqual({
      status: 409,
      body: { error: 'consentRequired', provider: 'ollama-remote', origin: new URL(REMOTE).origin },
    })
    expect(readFileSync(w.h.accountOf('alpha').configFile, 'utf8')).toBe(before)
    // The consent of Claude is not the consent of this host.
    w.installation.setup.recordConsent('alpha', 'claude-cli', CONSENT_TEXT_VERSION)
    expect((await put(w, body)).status).toBe(409)
    // `true` does not say who receives the text of an address that comes from the configuration or from the page: the
    // agreement names its recipient.
    expect((await put(w, { ...body, consent: true })).status).toBe(409)
    expect((await put(w, { ...body, consent: 'claude-cli' })).status).toBe(409)
    const saved = await put(w, { ...body, consent: 'ollama-remote' })
    expect(saved.body).toMatchObject({ step: 'link', consents: ['claude-cli', 'ollama-remote'] })
    expect(accountOf(w, 'alpha')).toMatchObject({ provider: { primary: 'ollama', ollama: { baseUrl: REMOTE } } })
  })

  it('does not ask for loopback addresses', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w)
    const saved = await put(w, {
      from: 'provider',
      provider: 'ollama',
      options: { model: 'm', baseUrl: 'http://localhost:11434' },
    })
    expect(saved.status).toBe(200)
    expect(w.installation.setup.consents('alpha')).toEqual([])
  })

  it('the test of a remote Ollama is refused without the consent', async () => {
    const w = await testWorld({ accounts: [] })
    await toProvider(w)
    const test = { provider: 'ollama', options: { model: 'm', baseUrl: REMOTE } }
    expect(await w.api('POST', '/api/setup/test-provider', test)).toEqual({
      status: 409,
      body: { error: 'consentRequired', provider: 'ollama-remote', origin: new URL(REMOTE).origin },
    })
    expect((await w.api('POST', '/api/setup/test-provider', { ...test, consent: true })).status).toBe(409)
    expect((await w.api('POST', '/api/setup/test-provider', { ...test, consent: 'ollama-remote' })).status).toBe(200)
  })

  it('the settings ask for it when Ollama is chosen with that address, or when the address of a chosen one changes to it', async () => {
    const url = '/api/accounts/alpha/settings'
    const w = await world({
      accounts: ['alpha'],
      config: { language: 'en', timezone: 'UTC', provider: { primary: 'ollama', ollama: { model: 'm' } } },
    })
    const remote = { provider: { ollama: { baseUrl: REMOTE } } }
    expect(await w.api('PUT', url, remote)).toEqual({
      status: 409,
      body: { error: 'consentRequired', provider: 'ollama-remote', origin: new URL(REMOTE).origin },
    })
    expect((await w.api('PUT', url, { provider: { backup: 'ollama', ollama: { baseUrl: REMOTE } } })).body).toEqual({
      error: 'consentRequired',
      provider: 'ollama-remote',
      origin: new URL(REMOTE).origin,
    })
    // Local addresses and unrelated edits go through.
    expect((await w.api('PUT', url, { provider: { ollama: { baseUrl: 'http://127.0.0.1:1234' } } })).status).toBe(200)
    expect((await w.api('PUT', url, { unreadOnly: true })).status).toBe(200)
    // The consent is for the server that is disclosed: with the address the page is about to save. Without it the address
    // in force is a local one, and there is nothing to record.
    expect((await w.api('POST', '/api/accounts/alpha/consents', { provider: 'ollama-remote' })).status).toBe(400)
    expect(w.installation.setup.consents('alpha')).toEqual([])
    expect(
      (await w.api('POST', '/api/accounts/alpha/consents', { provider: 'ollama-remote', baseUrl: REMOTE })).status,
    ).toBe(201)
    // Recorded under the kind of the table, with the origin that was disclosed.
    expect(w.installation.setup.consents('alpha')).toMatchObject([
      { provider: 'ollama', hosts: new URL(REMOTE).origin, textVersion: CONSENT_TEXT_VERSION },
    ])
    expect((await w.api('PUT', url, remote)).status).toBe(200)
    // Another server needs its own consent.
    expect((await w.api('PUT', url, { provider: { ollama: { baseUrl: 'http://192.168.1.99:11434' } } })).body).toEqual({
      error: 'consentRequired',
      provider: 'ollama-remote',
      origin: 'http://192.168.1.99:11434',
    })
  })

  it('the wizard offers only the providers it can set up: the rest of the table is chosen with `msum provider use`', async () => {
    const w = await world({ accounts: [] })
    await toProvider(w)
    for (const provider of ['generic-cli', 'gemini-cli', 'codex-cli', 'nope']) {
      expect(await put(w, { from: 'provider', provider, consent: true })).toEqual({
        status: 400,
        body: { error: 'invalidRequest' },
      })
      expect((await w.api('POST', '/api/setup/test-provider', { provider, consent: true })).status).toBe(400)
    }
    // nothing was chosen and nothing was recorded, and the wizard is still on its step
    expect((await get(w)).body).toMatchObject({ step: 'provider', consents: [] })
    expect(w.installation.setup.consents('alpha')).toEqual([])
  })

  it('does not ask while Ollama is not one of the providers in use', async () => {
    const w = await world({ accounts: ['alpha'] })
    const reply = await w.api('PUT', '/api/accounts/alpha/settings', { provider: { ollama: { baseUrl: REMOTE } } })
    expect(reply.status).toBe(200)
  })
})
