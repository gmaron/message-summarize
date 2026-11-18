import { mkdirSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_MIGRATIONS,
  consentHostsKey,
  currentVersion,
  openAppDatabase,
  openDatabase,
  SqliteProviderConsents,
} from '../../../src/infrastructure/persistence/sqlite/index.js'
import { openInstallation } from '../../../src/main/accounts.js'
import { runMain } from '../../../src/main/app.js'
import { disposeHarnesses, type Harness, makeHarness, NOW } from '../../support/cli-harness.js'

afterEach(disposeHarnesses)

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const text = (h: Harness) => h.out.join('\n')

/** What the installation has recorded for an account. */
async function consentsOf(h: Harness, account = 'default') {
  const opened = await openInstallation({ layout: h.layout, clock: h.ctx.clock })
  if (!opened.ok) throw new Error('could not open')
  try {
    return opened.installation.consents.list(account)
  } finally {
    opened.installation.close()
  }
}

const base = { language: 'en', provider: { primary: 'ollama', ollama: { model: 'qwen3:4b' } } }

describe('the consent repository (RNF-02)', () => {
  it('records and finds a consent by account, kind and hosts, whatever the order of the hosts', async () => {
    const h = await makeHarness({ config: base, accounts: ['alpha', 'beta'] })
    const db = openAppDatabase(h.layout.appDbFile)
    try {
      const consents = new SqliteProviderConsents(db, () => NOW)
      expect(consentHostsKey(['b.example', 'a.example', 'a.example'])).toBe('a.example,b.example')
      consents.record('alpha', 'claude-cli', ['b.example', 'a.example'])
      expect(consents.find('alpha', 'claude-cli', ['a.example', 'b.example'])).toBe(new Date(NOW).toISOString())
      // another account, another kind, other hosts: nothing
      expect(consents.find('beta', 'claude-cli', ['a.example', 'b.example'])).toBeNull()
      expect(consents.find('alpha', 'openai', ['a.example', 'b.example'])).toBeNull()
      expect(consents.find('alpha', 'claude-cli', ['a.example'])).toBeNull()
      expect(consents.list('alpha')).toEqual([
        { kind: 'claude-cli', hosts: 'a.example,b.example', acceptedAt: new Date(NOW).toISOString() },
      ])
    } finally {
      db.close()
    }
  })

  it('accepting the same thing again moves its date instead of adding a row, and an empty list is a key too', async () => {
    const h = await makeHarness({ config: base })
    const db = openAppDatabase(h.layout.appDbFile)
    try {
      let now = NOW
      const consents = new SqliteProviderConsents(db, () => now)
      consents.record('default', 'generic-cli', [])
      now += 86_400_000
      consents.record('default', 'generic-cli', [])
      expect(consents.list('default')).toEqual([
        { kind: 'generic-cli', hosts: '', acceptedAt: new Date(NOW + 86_400_000).toISOString() },
      ])
      expect(consents.find('default', 'generic-cli', [])).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('the consents of an account go with the account: deleting it (unlink) deletes them', async () => {
    const h = await makeHarness({ config: base, accounts: ['alpha', 'beta'] })
    const opened = await openInstallation({ layout: h.layout, clock: h.ctx.clock })
    if (!opened.ok) throw new Error('could not open')
    const { installation } = opened
    try {
      installation.consents.record('alpha', 'anthropic', ['api.anthropic.com'])
      installation.consents.record('beta', 'anthropic', ['api.anthropic.com'])
      await installation.deleteAccount('alpha')
      expect(installation.consents.list('alpha')).toEqual([])
      expect(installation.consents.list('beta')).toHaveLength(1)
    } finally {
      installation.close()
    }
  })
})

describe('upgrading app.db from schema version 2 (RNF-02)', () => {
  it('adds the consents table and keeps the accounts and the schedules', async () => {
    const h = await makeHarness({ config: base, accounts: [] })
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${h.layout.appDbFile}${suffix}`, { force: true })
    // the app.db of the commit before consents: version 2, with accounts and a schedule
    const old = openDatabase(h.layout.appDbFile, { migrations: APP_MIGRATIONS.slice(0, 2) })
    expect(currentVersion(old)).toBe(2)
    old.exec(
      "INSERT INTO accounts (id, platform, created_at) VALUES ('alpha', 'whatsapp', '2026-01-01T00:00:00.000Z'), ('beta', 'whatsapp', '2026-01-02T00:00:00.000Z')",
    )
    old.exec(
      "INSERT INTO schedules (account_id, days, time, created_at) VALUES ('alpha', '1,2', '07:00', '2026-01-03T00:00:00.000Z')",
    )
    old.close()
    for (const id of ['alpha', 'beta']) mkdirSync(h.accountOf(id).authDir, { recursive: true, mode: 0o700 })

    const upgraded = openAppDatabase(h.layout.appDbFile)
    try {
      expect(APP_MIGRATIONS).toHaveLength(3)
      expect(currentVersion(upgraded)).toBe(3)
      expect(upgraded.prepare('SELECT id FROM accounts ORDER BY id').all()).toEqual([{ id: 'alpha' }, { id: 'beta' }])
      expect(upgraded.prepare('SELECT days, time FROM schedules').all()).toEqual([{ days: '1,2', time: '07:00' }])
      expect(upgraded.prepare('SELECT COUNT(*) AS n FROM provider_consents').get()).toEqual({ n: 0 })
      // and it works, with the foreign key on
      const consents = new SqliteProviderConsents(upgraded, () => NOW)
      consents.record('beta', 'gemini', ['generativelanguage.googleapis.com'])
      expect(consents.list('beta')).toHaveLength(1)
      expect(() => consents.record('nobody', 'gemini', [])).toThrow()
      upgraded.prepare("DELETE FROM accounts WHERE id = 'beta'").run()
      expect(upgraded.prepare('SELECT COUNT(*) AS n FROM provider_consents').get()).toEqual({ n: 0 })
    } finally {
      upgraded.close()
    }
  })
})

describe('msum provider use records the consent', () => {
  it('records it when the user confirms, for the account of the single-account installation', async () => {
    const h = await makeHarness({ config: base, confirm: true })
    expect(await run(h, 'provider', 'use', 'anthropic', '--model', 'claude-sonnet-5-5')).toBe(0)
    expect(await consentsOf(h)).toEqual([
      { kind: 'anthropic', hosts: 'api.anthropic.com', acceptedAt: new Date(h.clock.now()).toISOString() },
    ])
  })

  it('records it with --yes too', async () => {
    const h = await makeHarness({ config: base, confirm: false })
    expect(await run(h, 'provider', 'use', 'gemini', '--model', 'gemini-x', '--yes')).toBe(0)
    expect((await consentsOf(h)).map((c) => [c.kind, c.hosts])).toEqual([
      ['gemini', 'generativelanguage.googleapis.com'],
    ])
  })

  it('records nothing when it is cancelled, or refused, or invalid', async () => {
    const cancelled = await makeHarness({ config: base, confirm: false })
    expect(await run(cancelled, 'provider', 'use', 'anthropic', '--model', 'm')).toBe(1)
    expect(await consentsOf(cancelled)).toEqual([])
    const invalid = await makeHarness({ config: base })
    expect(await run(invalid, 'provider', 'use', 'anthropic', '--yes')).toBe(2)
    expect(await run(invalid, 'provider', 'use', 'gemini-cli', '--yes')).toBe(1)
    expect(await consentsOf(invalid)).toEqual([])
  })

  it('records nothing for Ollama: the chats do not leave the machine', async () => {
    const h = await makeHarness({ config: { language: 'en' } })
    expect(await run(h, 'provider', 'use', 'ollama', '--model', 'qwen3:4b')).toBe(0)
    expect(await consentsOf(h)).toEqual([])
  })

  it('for the generic CLI the consent is keyed by the command that was shown: changing it needs a new consent', async () => {
    const { createHash } = await import('node:crypto')
    const { writeFileSync } = await import('node:fs')
    const keyOf = (command: string[]) => `cmd:${createHash('sha256').update(JSON.stringify(command)).digest('hex')}`
    const h = await makeHarness({
      config: {
        language: 'en',
        provider: { primary: 'ollama', ollama: { model: 'm' }, genericCli: { command: ['tool', '{{prompt}}'] } },
      },
    })
    expect(await run(h, 'provider', 'use', 'generic-cli', '--yes')).toBe(0)
    // the command is shown as the list it is, with the placeholder literally
    expect(text(h)).toContain('["tool","{{prompt}}"]')
    expect((await consentsOf(h)).map((c) => c.hosts)).toEqual([keyOf(['tool', '{{prompt}}'])])

    // a command changed by hand has no consent: doctor warns, and `use` records the new one beside the old
    writeFileSync(
      h.account.configFile,
      JSON.stringify({
        provider: { primary: 'generic-cli', genericCli: { command: ['tool', '--other', '{{prompt}}'] } },
      }),
    )
    h.out.length = 0
    await run(h, 'doctor')
    expect(text(h)).toContain('no recorded consent for sending chats to whatever your command contacts (generic-cli)')
    h.out.length = 0
    expect(await run(h, 'provider', 'use', 'generic-cli', '--yes')).toBe(0)
    expect((await consentsOf(h)).map((c) => c.hosts).sort()).toEqual(
      [keyOf(['tool', '{{prompt}}']), keyOf(['tool', '--other', '{{prompt}}'])].sort(),
    )
  })

  it('is for the account chosen', async () => {
    const h = await makeHarness({
      config: {
        language: 'en',
        provider: { primary: 'ollama', ollama: { model: 'm' }, genericCli: { command: ['tool'] } },
      },
      accounts: ['default', 'work'],
    })
    expect(await run(h, 'provider', 'use', 'generic-cli', '--account', 'work', '--yes')).toBe(0)
    expect(await consentsOf(h, 'default')).toEqual([])
    expect((await consentsOf(h, 'work')).map((c) => [c.kind, c.hosts.slice(0, 4)])).toEqual([['generic-cli', 'cmd:']])
  })

  it('a new base URL of a compatible server needs a new consent: the origin is what was accepted', async () => {
    const h = await makeHarness({ config: base })
    const use = (url: string) =>
      run(h, 'provider', 'use', 'openai-compatible', '--base-url', url, '--model', 'm', '--yes')
    expect(await use('https://one.example/v1')).toBe(0)
    expect((await consentsOf(h)).map((c) => c.hosts)).toEqual(['https://one.example'])
    // the same server with another path is the same origin; another server is not
    expect(await use('https://one.example/other')).toBe(0)
    expect(await use('https://two.example/v1')).toBe(0)
    expect((await consentsOf(h)).map((c) => c.hosts)).toEqual(['https://one.example', 'https://two.example'])

    // and doctor notices a base URL changed by hand: no consent for that origin
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      h.account.configFile,
      JSON.stringify({
        provider: { primary: 'openai', openai: { model: 'm', baseUrl: 'https://three.example/v1' } },
      }),
    )
    h.out.length = 0
    await run(h, 'doctor')
    expect(text(h)).toContain(
      '[warn] LLM provider: no recorded consent for sending chats to the server in provider.openai.baseUrl (three.example)',
    )
  })
})

describe('Ollama on another machine: doctor and the consent', () => {
  const remote = (baseUrl: string) => ({
    language: 'en',
    provider: { primary: 'ollama', ollama: { model: 'm', baseUrl } },
  })

  it('warns that the chats go to that server, and that there is no consent for it, without blocking', async () => {
    const h = await makeHarness({ config: remote('http://192.168.1.50:11434') })
    await run(h, 'doctor')
    expect(text(h)).toContain('[warn] LLM provider: Ollama is at http://192.168.1.50:11434, which is not this machine')
    expect(text(h)).toContain('no recorded consent for sending chats to http://192.168.1.50:11434 (ollama)')
    expect(text(h)).toContain('loopback address')
  })

  it('does not warn for a loopback address or the Docker host', async () => {
    for (const url of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://host.docker.internal:11434']) {
      const h = await makeHarness({ config: remote(url) })
      await run(h, 'doctor')
      expect(text(h), url).not.toContain('not this machine')
      expect(text(h), url).not.toContain('no recorded consent')
    }
  })

  it('warns too when Ollama is only the one of the "local only" chats, and says it in Spanish', async () => {
    const h = await makeHarness({
      config: {
        language: 'es',
        localOnlyPatterns: ['banco'],
        provider: { primary: 'claude-cli', ollama: { model: 'm', baseUrl: 'http://10.0.0.5:11434' } },
      },
    })
    await run(h, 'doctor')
    expect(text(h)).toContain('Ollama está en http://10.0.0.5:11434, que no es esta máquina')
  })

  it('a different origin needs a new consent', async () => {
    const h = await makeHarness({ config: remote('http://192.168.1.50:11434'), confirm: true })
    await run(h, 'provider', 'use', 'ollama')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      h.account.configFile,
      JSON.stringify({ provider: { ollama: { baseUrl: 'http://192.168.1.60:11434' } } }),
    )
    h.out.length = 0
    await run(h, 'doctor')
    expect(text(h)).toContain('no recorded consent for sending chats to http://192.168.1.60:11434 (ollama)')
  })
})

describe('msum doctor and the consent: visible, never blocking', () => {
  it('warns for a provider chosen by hand that sends the chats out, with how to review it', async () => {
    const h = await makeHarness({ config: { language: 'en', provider: { primary: 'claude-cli' } } })
    await run(h, 'doctor')
    expect(text(h)).toContain(
      '[warn] LLM provider: no recorded consent for sending chats to api.anthropic.com, claude.ai',
    )
    expect(text(h)).toContain('msum provider use claude-cli')
    expect(text(h)).toContain('works without it')
    // the provider itself is fine: the consent is a warning, not a failure
    expect(text(h)).toContain('[ok]   LLM provider: claude-cli')
    expect(text(h)).not.toContain('[fail] LLM provider')
  })

  it('warns for the backup too, and says it in Spanish', async () => {
    const h = await makeHarness({
      config: {
        language: 'es',
        provider: { primary: 'ollama', backup: 'gemini', ollama: { model: 'm' }, gemini: { model: 'g' } },
      },
      env: { GEMINI_API_KEY: 'k-gemini-0000000000' },
    })
    await run(h, 'doctor')
    expect(text(h)).toContain(
      'no hay consentimiento registrado para enviar chats a generativelanguage.googleapis.com (gemini)',
    )
    expect(text(h).match(/no hay consentimiento registrado/g)).toHaveLength(1)
  })

  it('does not warn for Ollama, a disabled preset or when nothing was chosen', async () => {
    for (const provider of [{ primary: 'ollama', ollama: { model: 'm' } }, { primary: 'gemini-cli' }, {}]) {
      const h = await makeHarness({ config: { language: 'en', provider } })
      await run(h, 'doctor')
      expect(text(h)).not.toContain('no recorded consent')
    }
  })

  it('stops warning once the guided path recorded it', async () => {
    const h = await makeHarness({ config: base, confirm: true, env: { ANTHROPIC_API_KEY: 'sk-ant-0123456789ABCDEF' } })
    await run(h, 'provider', 'use', 'anthropic', '--model', 'claude-sonnet-5-5')
    h.out.length = 0
    await run(h, 'doctor')
    expect(text(h)).not.toContain('no recorded consent')
  })

  it('never blocks a digest: one runs with no consent recorded', async () => {
    const h = await makeHarness({ config: { language: 'en', provider: { primary: 'claude-cli' } } })
    expect(await run(h, 'digest', '--dry-run')).toBe(0)
    expect(h.err.join('\n')).not.toContain('consent')
  })
})

describe('msum provider ls shows the consent', () => {
  it('says "none recorded" for a configured provider that has none, and the date once it has one', async () => {
    const h = await makeHarness({ config: { language: 'en', provider: { primary: 'claude-cli' } } })
    await run(h, 'provider', 'ls')
    expect(text(h)).toContain('Consent to send your chats: none recorded')
    // once, for the configured provider only (the others have no role here)
    expect(text(h).match(/Consent to send your chats/g)).toHaveLength(1)

    const fresh = await makeHarness({ config: base, confirm: true })
    await run(fresh, 'provider', 'use', 'anthropic', '--model', 'claude-sonnet-5-5')
    fresh.out.length = 0
    await run(fresh, 'provider', 'ls')
    expect(text(fresh)).toContain(
      `Consent to send your chats: recorded on ${new Date(fresh.clock.now()).toISOString().slice(0, 10)}.`,
    )
  })

  it('shows nothing about consent for Ollama', async () => {
    const h = await makeHarness({ config: base })
    await run(h, 'provider', 'ls')
    expect(text(h)).not.toContain('Consent to send')
  })
})
