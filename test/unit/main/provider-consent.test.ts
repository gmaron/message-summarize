import { mkdirSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { CONSENT_TEXT_VERSION, consentHostsKey } from '../../../src/domain/setup.js'
import {
  APP_MIGRATIONS,
  currentVersion,
  openAppDatabase,
  openDatabase,
  SqliteSetupRepository,
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
    return opened.installation.setup
      .consents(account)
      .map((c) => ({ kind: c.provider, hosts: c.hosts, acceptedAt: c.givenAt }))
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
      const consents = new SqliteSetupRepository(db, () => NOW)
      const two = consentHostsKey(['b.example', 'a.example', 'a.example'])
      expect(two).toBe('a.example,b.example')
      consents.recordConsent('alpha', 'generic-cli', CONSENT_TEXT_VERSION, two)
      expect(consents.findConsent('alpha', 'generic-cli', two, CONSENT_TEXT_VERSION)?.givenAt).toBe(
        new Date(NOW).toISOString(),
      )
      // another account, another kind, other hosts, another text: nothing
      expect(consents.findConsent('beta', 'generic-cli', two, CONSENT_TEXT_VERSION)).toBeNull()
      expect(consents.findConsent('alpha', 'ollama', two, CONSENT_TEXT_VERSION)).toBeNull()
      expect(consents.findConsent('alpha', 'generic-cli', 'a.example', CONSENT_TEXT_VERSION)).toBeNull()
      expect(consents.findConsent('alpha', 'generic-cli', two, CONSENT_TEXT_VERSION + 1)).toBeNull()
      expect(consents.consents('alpha')).toEqual([
        {
          provider: 'generic-cli',
          hosts: 'a.example,b.example',
          textVersion: CONSENT_TEXT_VERSION,
          givenAt: new Date(NOW).toISOString(),
        },
      ])
    } finally {
      db.close()
    }
  })

  it('accepting the same thing again adds no row and keeps its date', async () => {
    const h = await makeHarness({ config: base })
    const db = openAppDatabase(h.layout.appDbFile)
    try {
      let now = NOW
      const consents = new SqliteSetupRepository(db, () => now)
      expect(consents.recordConsent('default', 'anthropic', CONSENT_TEXT_VERSION, 'api.anthropic.com')).toBe(true)
      now += 86_400_000
      expect(consents.recordConsent('default', 'anthropic', CONSENT_TEXT_VERSION, 'api.anthropic.com')).toBe(false)
      expect(consents.consents('default')).toHaveLength(1)
      expect(consents.consents('default')[0]?.givenAt).toBe(new Date(NOW).toISOString())
    } finally {
      db.close()
    }
  })

  it('a consent is valid only for the current text and the exact hosts; fixed-host kinds also accept none recorded', async () => {
    const h = await makeHarness({ config: base })
    const db = openAppDatabase(h.layout.appDbFile)
    try {
      const consents = new SqliteSetupRepository(db, () => NOW)
      const V = CONSENT_TEXT_VERSION
      // a kind with fixed hosts: one recorded with no hosts (before the hosts were part of the key) still covers it
      consents.recordConsent('default', 'claude-cli', V, '')
      expect(consents.hasConsent('default', 'claude-cli', 'api.anthropic.com,claude.ai', V)).toBe(true)
      // ...but not an older text
      consents.recordConsent('default', 'anthropic', V - 1, 'api.anthropic.com')
      expect(consents.hasConsent('default', 'anthropic', 'api.anthropic.com', V)).toBe(false)
      // a kind that depends on what the user configures needs the exact key, never "none"
      consents.recordConsent('default', 'openai-compatible', V, '')
      consents.recordConsent('default', 'generic-cli', V, '')
      consents.recordConsent('default', 'ollama', V, '')
      expect(consents.hasConsent('default', 'openai-compatible', 'https://one.example', V)).toBe(false)
      expect(consents.hasConsent('default', 'generic-cli', 'cmd:abc', V)).toBe(false)
      expect(consents.hasConsent('default', 'ollama', 'http://10.0.0.5:11434', V)).toBe(false)
      consents.recordConsent('default', 'ollama', V, 'http://10.0.0.5:11434')
      expect(consents.hasConsent('default', 'ollama', 'http://10.0.0.5:11434', V)).toBe(true)
      expect(consents.hasConsent('default', 'ollama', 'http://10.0.0.6:11434', V)).toBe(false)
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
      installation.setup.recordConsent('alpha', 'anthropic', CONSENT_TEXT_VERSION, 'api.anthropic.com')
      installation.setup.recordConsent('beta', 'anthropic', CONSENT_TEXT_VERSION, 'api.anthropic.com')
      await installation.deleteAccount('alpha')
      expect(installation.setup.consents('alpha')).toEqual([])
      expect(installation.setup.consents('beta')).toHaveLength(1)
    } finally {
      installation.close()
    }
  })
})

describe('upgrading app.db from schema version 3 as released (RNF-02)', () => {
  it('rebuilds the consents table with the hosts in its key, keeping the rows, the accounts, the setup and the schedules', async () => {
    const h = await makeHarness({ config: base, accounts: [] })
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${h.layout.appDbFile}${suffix}`, { force: true })
    // the app.db that was released: version 3 (setup and consents with no hosts), with accounts, a schedule and consents
    const old = openDatabase(h.layout.appDbFile, { migrations: APP_MIGRATIONS.slice(0, 3) })
    expect(currentVersion(old)).toBe(3)
    old.exec(
      "INSERT INTO accounts (id, platform, created_at) VALUES ('alpha', 'whatsapp', '2026-01-01T00:00:00.000Z'), ('beta', 'whatsapp', '2026-01-02T00:00:00.000Z')",
    )
    old.exec(
      "INSERT INTO schedules (account_id, days, time, created_at) VALUES ('alpha', '1,2', '07:00', '2026-01-03T00:00:00.000Z')",
    )
    old.exec("INSERT INTO setup (id, step, account_id, completed_at, updated_at) VALUES (1, 'done', 'alpha', 'x', 'x')")
    old.exec(
      "INSERT INTO consents (account_id, provider, text_version, given_at) VALUES ('alpha', 'claude-cli', 1, '2026-01-04T00:00:00.000Z'), ('beta', 'ollama-remote', 1, '2026-01-05T00:00:00.000Z')",
    )
    old.close()
    for (const id of ['alpha', 'beta']) mkdirSync(h.accountOf(id).authDir, { recursive: true, mode: 0o700 })

    const upgraded = openAppDatabase(h.layout.appDbFile)
    try {
      expect(APP_MIGRATIONS).toHaveLength(4)
      expect(currentVersion(upgraded)).toBe(4)
      expect(upgraded.prepare('SELECT id FROM accounts ORDER BY id').all()).toEqual([{ id: 'alpha' }, { id: 'beta' }])
      expect(upgraded.prepare('SELECT days, time FROM schedules').all()).toEqual([{ days: '1,2', time: '07:00' }])
      expect(upgraded.prepare('SELECT step, account_id FROM setup').all()).toEqual([
        { step: 'done', account_id: 'alpha' },
      ])
      // the rows are all there, with an empty `hosts`
      expect(
        upgraded
          .prepare('SELECT account_id, provider, text_version, hosts, given_at FROM consents ORDER BY account_id')
          .all(),
      ).toEqual([
        {
          account_id: 'alpha',
          provider: 'claude-cli',
          text_version: 1,
          hosts: '',
          given_at: '2026-01-04T00:00:00.000Z',
        },
        {
          account_id: 'beta',
          provider: 'ollama-remote',
          text_version: 1,
          hosts: '',
          given_at: '2026-01-05T00:00:00.000Z',
        },
      ])
      // phase 3's table is gone for good: there is ONE consent table
      expect(
        upgraded.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'provider_consents'").get(),
      ).toEqual({ n: 0 })
      // the key now holds the hosts: the same consent for other hosts is another row, the same one twice is not
      const repository = new SqliteSetupRepository(upgraded, () => NOW)
      expect(repository.recordConsent('beta', 'openai-compatible', 2, 'https://one.example')).toBe(true)
      expect(repository.recordConsent('beta', 'openai-compatible', 2, 'https://two.example')).toBe(true)
      expect(repository.recordConsent('beta', 'openai-compatible', 2, 'https://one.example')).toBe(false)
      // and it works with the foreign key on: an unknown account is refused, deleting an account deletes its consents
      expect(() => repository.recordConsent('nobody', 'gemini', 2, '')).toThrow()
      upgraded.prepare("DELETE FROM accounts WHERE id = 'beta'").run()
      expect(upgraded.prepare("SELECT COUNT(*) AS n FROM consents WHERE account_id = 'beta'").get()).toEqual({ n: 0 })
      expect(upgraded.prepare("SELECT COUNT(*) AS n FROM consents WHERE account_id = 'alpha'").get()).toEqual({ n: 1 })
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
