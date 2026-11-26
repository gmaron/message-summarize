import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliverPending } from '../../../src/application/deliver-pending.js'
import { WhatsAppSelfChatDelivery } from '../../../src/infrastructure/whatsapp/self-chat-delivery.js'
import { runMain } from '../../../src/main/app.js'
import { maskAccount } from '../../../src/main/context.js'
import { writeBlocked } from '../../../src/main/installation/blocked.js'
import { acquireDaemonLock } from '../../../src/main/installation/daemon-lock.js'
import {
  BA,
  disposeHarnesses,
  type Harness,
  ME,
  makeHarness,
  NOW,
  OTHER,
  seedMessages,
  waitFor,
} from '../../support/cli-harness.js'
import { isWindows } from '../../support/platform.js'

afterEach(() => {
  vi.restoreAllMocks()
  disposeHarnesses()
})

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const text = (lines: string[]) => lines.join('\n')
const CONFIG = { language: 'en', timezone: BA, schedules: [], provider: { primary: 'claude-cli' } }
const session = (id: string) => JSON.stringify({ me: { id } })

/** Binds an account to a number and gives it a registered session. */
function link(h: Harness, id: string, jid: string): void {
  const runtime = h.runtime(id)
  runtime.identity.bind(jid)
  runtime.close()
  writeFileSync(join(h.accountOf(id).authDir, 'creds.json'), session(jid))
}

/** Every file under a directory with its content: to prove an account was not touched. */
function snapshot(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else found.push(`${path}\n${readFileSync(path).toString('latin1')}`)
    }
  }
  walk(dir)
  return found.sort()
}

describe('msum accounts', () => {
  it('lists id, platform and state, with the number masked', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta', 'gamma'] })
    link(h, 'alpha', ME)
    await writeBlocked(h.accountOf('beta').blockedFile, 'forbidden', NOW)
    expect(await run(h, 'accounts')).toBe(0)
    const output = text(h.out)
    expect(output).toMatch(/^ {2}alpha\s+whatsapp\s+linked \(\+99\*+1432\)$/m)
    expect(output).toMatch(/^ {2}beta\s+whatsapp\s+blocked: WhatsApp refused the connection/m)
    expect(output).toMatch(/^ {2}gamma\s+whatsapp\s+not linked$/m)
    expect(output).toContain(maskAccount(ME))
    expect(output).not.toContain('9913174261432')
    expect(output).not.toContain('creds')
  })

  it('says so when there are no accounts, and creates nothing', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: [] })
    expect(await run(h, 'accounts')).toBe(0)
    expect(text(h.out)).toContain('There are no accounts yet')
    expect(readdirSync(h.layout.accountsDir)).toEqual([])
  })

  it('reports an account whose directory is gone, in Spanish when the config says so', async () => {
    const h = await makeHarness({ config: { ...CONFIG, language: 'es' }, accounts: ['alpha', 'beta'] })
    rmSync(h.accountOf('beta').dir, { recursive: true })
    expect(await run(h, 'accounts')).toBe(0)
    expect(text(h.out)).toMatch(/^ {2}beta\s+whatsapp\s+falta el directorio$/m)
    expect(text(h.out)).toMatch(/^ {2}alpha\s+whatsapp\s+sin vincular$/m)
  })
})

describe('choosing the account', () => {
  it('uses the only account when no --account is given', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['solo'] })
    const runtime = h.runtime('solo')
    await seedMessages(runtime, [{ id: 'm1', text: 'hello there' }])
    runtime.close()
    expect(await run(h, 'digest', '--dry-run')).toBe(0)
    expect(h.summarizer.requests.length).toBe(1)
  })

  it('asks for --account, listing the ids, when there are several (digest, unlink, link)', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    for (const command of [['digest'], ['unlink', '--yes'], ['link']]) {
      h.err.length = 0
      expect(await run(h, ...command), command.join(' ')).toBe(2)
      expect(text(h.err)).toContain('--account <id>')
      expect(text(h.err)).toContain('alpha, beta')
    }
    expect(h.connection.calls).toEqual([])
    expect(existsSync(h.accountOf('alpha').dir)).toBe(true)
    expect(existsSync(h.accountOf('beta').dir)).toBe(true)
  })

  it('refuses an unknown account for digest, unlink, daemon, status and doctor, and lists the known ones', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha'] })
    for (const command of [['digest'], ['unlink', '--yes'], ['daemon'], ['status'], ['doctor']]) {
      h.err.length = 0
      expect(await run(h, ...command, '--account', 'nope'), command[0]).toBe(2)
      expect(text(h.err)).toContain('There is no account "nope"')
      expect(text(h.err)).toContain('alpha')
    }
    expect(existsSync(h.accountOf('nope').dir)).toBe(false)
  })

  it('refuses an id that is not a safe directory name before touching anything', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha'] })
    for (const id of ['../alpha', 'a/b', 'Alpha', '..']) {
      h.err.length = 0
      expect(await run(h, 'link', `--account=${id}`), id).toBe(2)
      expect(text(h.err)).toContain('is not valid')
    }
    expect(readdirSync(h.layout.accountsDir)).toEqual(['alpha'])
  })

  it('digest works on the chosen account only', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    for (const [id, secret] of [
      ['alpha', 'ALPHA-ONLY-TEXT'],
      ['beta', 'BETA-ONLY-TEXT'],
    ] as const) {
      const runtime = h.runtime(id)
      await seedMessages(runtime, [{ id: `${id}1`, text: secret }])
      runtime.close()
    }
    expect(await run(h, 'digest', '--dry-run', '--account', 'beta')).toBe(0)
    const sent = h.summarizer.requests.map((r) => r.transcript).join('\n')
    expect(sent).toContain('BETA-ONLY-TEXT')
    expect(sent).not.toContain('ALPHA-ONLY-TEXT')
  })
})

describe('msum link --account', () => {
  it('creates the account (directory and record) and links it, leaving the other one alone', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha'] })
    link(h, 'alpha', ME)
    const before = snapshot(h.accountOf('alpha').dir)
    h.connection.user = { id: OTHER }
    h.connection.onStart = () => {
      // what the adapter does when the phone confirms: the session is stored in the account's auth directory
      writeFileSync(join(h.accountOf('work').authDir, 'creds.json'), session(OTHER))
      h.connection.emit({ state: 'connected' })
    }
    expect(await run(h, 'link', '--account', 'work')).toBe(0)
    expect(existsSync(h.accountOf('work').dir)).toBe(true)
    const runtime = h.runtime('work')
    expect(runtime.identity.get()).toBe(OTHER)
    runtime.close()
    // the QR of the link lived inside the account directory and is gone
    expect(existsSync(h.accountOf('work').qrFile)).toBe(false)
    expect(snapshot(h.accountOf('alpha').dir)).toEqual(before)
    h.out.length = 0
    await run(h, 'accounts')
    expect(text(h.out)).toMatch(/alpha\s+whatsapp\s+linked/)
    expect(text(h.out)).toMatch(/work\s+whatsapp\s+linked/)
  })

  it('creates "default" when there are no accounts and none is named', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: [] })
    h.connection.onStart = () => {
      writeFileSync(join(h.accountOf('default').authDir, 'creds.json'), session(ME))
      h.connection.emit({ state: 'connected' })
    }
    expect(await run(h, 'link')).toBe(0)
    expect(readdirSync(h.layout.accountsDir)).toEqual(['default'])
    h.out.length = 0
    await run(h, 'accounts')
    expect(text(h.out)).toMatch(/default\s+whatsapp\s+linked/)
  })

  it('leaves an account that is already linked alone: a notice naming unlink, exit 0, no connection', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    link(h, 'alpha', ME)
    const before = snapshot(h.accountOf('alpha').dir)
    expect(await run(h, 'link', '--account', 'alpha')).toBe(0)
    expect(text(h.out)).toContain('msum unlink --account alpha')
    expect(h.connection.calls).toEqual([])
    expect(snapshot(h.accountOf('alpha').dir)).toEqual(before)
  })

  it('removes the account it created when the first link fails, times out or is interrupted', async () => {
    const outcomes: [string, (h: Harness) => void][] = [
      ['failed', (h) => h.connection.emit({ state: 'error', reason: 'socketFailed' })],
      ['logged out', (h) => h.connection.emit({ state: 'loggedOut' })],
      ['timeout', () => {}],
      ['interrupted', (h) => h.shutdown()],
    ]
    for (const [name, outcome] of outcomes) {
      const h = await makeHarness({ config: CONFIG, accounts: ['alpha'] })
      Object.assign(h.ctx, { linkTiming: { ...h.ctx.linkTiming, connectTimeoutMs: 100 } })
      h.connection.onStart = () => outcome(h)
      expect(await run(h, 'link', '--account', 'fresh'), name).not.toBe(0)
      expect(existsSync(h.accountOf('fresh').dir), name).toBe(false)
      h.out.length = 0
      await run(h, 'accounts')
      expect(text(h.out), name).not.toContain('fresh')
      expect(text(h.out), name).toContain('alpha')
    }
  })

  it('leaves an existing account untouched when its relink fails', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha'] })
    // half-finished link: record and directory exist, nothing bound, no session
    writeFileSync(join(h.accountOf('alpha').dir, 'note.txt'), 'keep me')
    h.connection.onStart = () => h.connection.emit({ state: 'loggedOut' })
    expect(await run(h, 'link', '--account', 'alpha')).toBe(1)
    expect(readFileSync(join(h.accountOf('alpha').dir, 'note.txt'), 'utf8')).toBe('keep me')
    h.out.length = 0
    await run(h, 'accounts')
    expect(text(h.out)).toContain('alpha')
  })

  it('keeps a new account whose number was already bound when the link is interrupted afterwards', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: [] })
    h.connection.onStart = () => {
      h.connection.emit({ state: 'connected' })
      setTimeout(() => h.shutdown(), 30)
    }
    Object.assign(h.ctx, { linkTiming: { ...h.ctx.linkTiming, minAfterConnectMs: 5_000, maxAfterConnectMs: 5_000 } })
    expect(await run(h, 'link', '--account', 'fresh')).toBe(130)
    const runtime = h.runtime('fresh')
    expect(runtime.identity.get()).toBe(ME)
    runtime.close()
  })

  it('refuses link and unlink when the account directory is a symbolic link, touching nothing', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'y'] })
    const elsewhere = join(h.dir, 'elsewhere')
    mkdirSync(join(elsewhere, 'auth'), { recursive: true, mode: 0o755 })
    writeFileSync(join(elsewhere, 'precious.txt'), 'data that must survive')
    // `link --account x`: nothing exists yet but a link sits where the directory would be
    symlinkSync(elsewhere, h.accountOf('x').dir)
    // `unlink --account y`: a registered account whose directory was replaced by a link
    rmSync(h.accountOf('y').dir, { recursive: true })
    symlinkSync(elsewhere, h.accountOf('y').dir)
    for (const command of [
      ['link', '--account', 'x'],
      ['unlink', '--account', 'y', '--yes'],
    ]) {
      h.err.length = 0
      expect(await run(h, ...command), command[0]).toBe(1)
      expect(text(h.err)).toContain('is a link or a file')
    }
    expect(readFileSync(join(elsewhere, 'precious.txt'), 'utf8')).toBe('data that must survive')
    if (!isWindows) expect(statSync(elsewhere).mode & 0o777).not.toBe(0o700)
    expect(h.connection.calls).toEqual([])
    expect(lstatSync(h.accountOf('x').dir).isSymbolicLink()).toBe(true)
    expect(lstatSync(h.accountOf('y').dir).isSymbolicLink()).toBe(true)
    h.out.length = 0
    await run(h, 'accounts')
    expect(text(h.out)).toContain('y') // the record is still there: nothing was reported deleted
  })

  it('refuses when auth/ is a link, in Spanish when the config says so', async () => {
    const h = await makeHarness({ config: { ...CONFIG, language: 'es' }, accounts: ['alpha'] })
    const elsewhere = join(h.dir, 'elsewhere-auth')
    mkdirSync(elsewhere)
    rmSync(h.accountOf('alpha').authDir, { recursive: true })
    symlinkSync(elsewhere, h.accountOf('alpha').authDir)
    expect(await run(h, 'unlink', '--account', 'alpha', '--yes')).toBe(1)
    expect(text(h.err)).toContain('es un enlace o un archivo')
    expect(existsSync(h.accountOf('alpha').dir)).toBe(true)
  })

  it('works while a daemon runs, for an account the daemon is not using, and frees its lock', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha'] })
    link(h, 'alpha', ME)
    await acquireDaemonLock(h.layout.lockFile, process.ppid)
    h.connection.user = { id: OTHER }
    h.connection.onStart = () => {
      // while linking, the account is locked against the daemon
      expect(existsSync(h.accountOf('work').linkLockFile)).toBe(true)
      writeFileSync(join(h.accountOf('work').authDir, 'creds.json'), session(OTHER))
      h.connection.emit({ state: 'connected' })
    }
    expect(await run(h, 'link', '--account', 'work')).toBe(0)
    expect(existsSync(h.accountOf('work').linkLockFile)).toBe(false)
    expect(existsSync(h.accountOf('alpha').dir)).toBe(true)
  })
})

describe('msum unlink --account (RF-03: deleting an account deletes only its data)', () => {
  it('deletes that account directory and record and leaves every file of the other account as it was', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    for (const [id, jid, secret] of [
      ['alpha', ME, 'ALPHA-SECRET-TEXT'],
      ['beta', OTHER, 'BETA-SECRET-TEXT'],
    ] as const) {
      link(h, id, jid)
      const runtime = h.runtime(id)
      await seedMessages(runtime, [{ id: `${id}1`, text: secret }])
      runtime.close()
    }
    await run(h, 'digest', '--account', 'beta') // beta has a digest and pending parts
    writeFileSync(join(h.accountOf('beta').dir, 'config.json'), '{"concurrency":2}')
    await writeBlocked(h.accountOf('beta').blockedFile, 'replaced', NOW)
    const betaBefore = snapshot(h.accountOf('beta').dir)

    expect(await run(h, 'unlink', '--account', 'alpha', '--yes')).toBe(0)
    expect(existsSync(h.accountOf('alpha').dir)).toBe(false)
    expect(text(h.out)).toContain('Account "alpha" unlinked')
    expect(snapshot(h.accountOf('beta').dir)).toEqual(betaBefore)
    expect(snapshot(h.layout.dataDir).join('')).not.toContain('ALPHA-SECRET-TEXT')
    h.out.length = 0
    await run(h, 'accounts')
    expect(text(h.out)).not.toContain('alpha')
    expect(text(h.out)).toContain('beta')
    // beta still works, with its own data
    const runtime = h.runtime('beta')
    expect(runtime.identity.get()).toBe(OTHER)
    expect(runtime.store.pendingOutbox().length).toBeGreaterThan(0)
    runtime.close()
  })

  it('asks which account in its question, and changes nothing when the answer is no', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'], confirm: false })
    expect(await run(h, 'unlink', '--account', 'beta')).toBe(1)
    expect(h.questions[0]).toContain('"beta"')
    expect(existsSync(h.accountOf('beta').dir)).toBe(true)
    expect(text(h.out)).not.toContain('unlinked')
  })

  it('cleans the record of an account whose directory is gone', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    rmSync(h.accountOf('beta').dir, { recursive: true })
    expect(await run(h, 'unlink', '--account', 'beta', '--yes')).toBe(0)
    h.out.length = 0
    await run(h, 'accounts')
    expect(text(h.out)).not.toContain('beta')
  })

  it('can be undone only by linking again: the account id is free to use again', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha'] })
    link(h, 'alpha', ME)
    expect(await run(h, 'unlink', '--account', 'alpha', '--yes')).toBe(0)
    h.connection.user = { id: OTHER }
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    expect(await run(h, 'link', '--account', 'alpha')).toBe(0)
    const runtime = h.runtime('alpha')
    expect(runtime.identity.get()).toBe(OTHER)
    runtime.close()
  })
})

describe('configuration of an account (RF-03, RF-73)', () => {
  it('runs an account with the installation config plus its own overrides', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    writeFileSync(join(h.accountOf('beta').dir, 'config.json'), JSON.stringify({ language: 'es' }))
    for (const id of ['alpha', 'beta']) {
      const runtime = h.runtime(id)
      await seedMessages(runtime, [{ id: `${id}1`, text: 'hello there' }])
      runtime.close()
    }
    await run(h, 'digest', '--account', 'alpha')
    await run(h, 'digest', '--account', 'beta')
    expect(h.out[0]).toContain('Digest generated')
    expect(h.out[1]).toContain('Digest generado')
  })

  it('names the file and the option of a problem, and the other account keeps working', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    const betaFile = join(h.accountOf('beta').dir, 'config.json')
    writeFileSync(betaFile, JSON.stringify({ concurrency: 0 }))
    expect(await run(h, 'digest', '--dry-run', '--account', 'beta')).toBe(2)
    expect(text(h.err)).toContain(betaFile)
    expect(text(h.err)).toContain('"concurrency" must be a number greater than zero')
    h.err.length = 0
    const runtime = h.runtime('alpha')
    await seedMessages(runtime, [{ id: 'a1', text: 'hello there' }])
    runtime.close()
    expect(await run(h, 'digest', '--dry-run', '--account', 'alpha')).toBe(0)
    // without --account the installation-wide commands stop at the broken file, naming it
    // status shows every account; the broken one says why inside its block, and the exit code comes last
    h.out.length = 0
    expect(await run(h, 'status')).toBe(2)
    expect(text(h.out)).toContain(betaFile)
    expect(text(h.out)).toMatch(/^Account: +alpha \(not linked\)$/m)
    expect(text(h.out)).toMatch(/^Account: +beta \(invalid configuration\)$/m)
  })

  it('reads a relative promptFile of an account file from the account directory', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha'] })
    writeFileSync(join(h.accountOf('alpha').dir, 'prompt.md'), 'Prompt of alpha.')
    writeFileSync(join(h.accountOf('alpha').dir, 'config.json'), JSON.stringify({ promptFile: 'prompt.md' }))
    const runtime = h.runtime('alpha')
    await seedMessages(runtime, [{ id: 'a1', text: 'hello there' }])
    runtime.close()
    expect(await run(h, 'digest', '--dry-run')).toBe(0)
    expect(h.summarizer.requests[0]?.systemPrompt).toBe('Prompt of alpha.')
  })
})

describe('msum status with accounts', () => {
  it('shows a block per account: id, masked number, last digest, pending parts', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    link(h, 'alpha', ME)
    const runtime = h.runtime('alpha')
    await seedMessages(runtime, [{ id: 'a1', text: 'CONFIDENTIAL CHAT TEXT' }])
    runtime.close()
    await run(h, 'digest', '--account', 'alpha')
    h.out.length = 0
    expect(await run(h, 'status')).toBe(0)
    const output = text(h.out)
    expect(output).toMatch(/^Account: +alpha \(\+99\*+1432\)$/m)
    expect(output).toMatch(/^Account: +beta \(not linked\)$/m)
    expect(output.match(/^Pending deliveries:/gm)).toHaveLength(2)
    expect(output).toMatch(/^Daemon: +stopped$/m)
    expect(output).not.toContain('CONFIDENTIAL')
    expect(output).not.toContain('9913174261432')
    h.out.length = 0
    await run(h, 'status', '--account', 'beta')
    expect(text(h.out)).toContain('beta (not linked)')
    expect(text(h.out)).not.toContain('alpha')
  })

  it('says there are no accounts yet, and creates none', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: [] })
    expect(await run(h, 'status')).toBe(0)
    expect(text(h.out)).toContain('none yet')
    expect(readdirSync(h.layout.accountsDir)).toEqual([])
  })
})

describe('msum doctor with accounts', () => {
  it('checks every account, telling them apart', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    link(h, 'alpha', ME)
    expect(await run(h, 'doctor')).toBe(1)
    const output = text(h.out)
    expect(output).toContain('[ok]   WhatsApp [alpha]: account linked')
    expect(output).toContain('[fail] WhatsApp [beta]: no account linked')
    expect(output).toContain('[ok]   LLM provider [alpha]')
    expect(output).toContain('[ok]   LLM provider [beta]')
    expect(output).toContain('[ok]   Accounts: 2 registered')
    expect(output.match(/\[ok\] {3}Node/g)).toHaveLength(1)
  })

  it('checks only the chosen account, and reports the file of a bad account config', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    link(h, 'alpha', ME)
    const betaFile = join(h.accountOf('beta').dir, 'config.json')
    writeFileSync(betaFile, JSON.stringify({ timezone: 'Mars/Base' }))
    expect(await run(h, 'doctor', '--account', 'alpha')).toBe(0)
    expect(text(h.out)).not.toContain('beta')
    h.out.length = 0
    expect(await run(h, 'doctor', '--account', 'beta')).toBe(1)
    expect(text(h.out)).toContain('[fail] Configuration')
    expect(text(h.out)).toContain(betaFile)
    expect(text(h.out)).toContain('"timezone" is not a valid time zone')
  })

  it('reports an account that is registered but has no directory, and does not delete the record', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    link(h, 'alpha', ME)
    link(h, 'beta', OTHER)
    rmSync(h.accountOf('beta').dir, { recursive: true })
    expect(await run(h, 'doctor')).toBe(1)
    expect(text(h.out)).toContain('[fail] Accounts: the account "beta" is registered but its directory is missing')
    expect(text(h.out)).toContain('msum unlink --account beta')
    h.out.length = 0
    await run(h, 'accounts')
    expect(text(h.out)).toContain('beta')
  })

  // The doctor does not check modes on Windows (no POSIX permissions there).
  it.skipIf(isWindows)('reports loose permissions of an account directory', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha'] })
    link(h, 'alpha', ME)
    const { chmod } = await import('node:fs/promises')
    await chmod(h.accountOf('alpha').authDir, 0o755)
    expect(await run(h, 'doctor')).toBe(1)
    expect(text(h.out)).toContain(`${h.accountOf('alpha').authDir} has permissions 755`)
  })

  it.skipIf(isWindows)(
    'reports a data directory and accounts/ that are too open, before opening the installation tightens them',
    async () => {
      const h = await makeHarness({ config: CONFIG, accounts: ['alpha'] })
      link(h, 'alpha', ME)
      const { chmod } = await import('node:fs/promises')
      await chmod(h.layout.accountsDir, 0o755)
      expect(await run(h, 'doctor')).toBe(1)
      expect(text(h.out)).toContain(`${h.layout.accountsDir} has permissions 755`)
      h.out.length = 0
      await chmod(h.layout.dataDir, 0o755)
      expect(await run(h, 'doctor')).toBe(1)
      expect(text(h.out)).toContain(`${h.layout.dataDir} has permissions 755`)
      // and the next run finds them tightened
      h.out.length = 0
      expect(await run(h, 'doctor')).toBe(0)
    },
  )

  it('reports both layouts present, and entries of accounts/ that are not accounts', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['default'] })
    link(h, 'default', ME)
    mkdirSync(h.layout.legacyAccountDir)
    mkdirSync(join(h.layout.accountsDir, 'Not An Account'))
    expect(await run(h, 'doctor')).toBe(1)
    expect(text(h.out)).toContain('both account/ (old layout) and accounts/default/ exist')
    expect(text(h.out)).toContain('Not An Account')
  })
})

describe('msum daemon with accounts', () => {
  it('runs the account of --account, with its own paths, and releases the lock', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    link(h, 'beta', ME)
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    const finished = run(h, 'daemon', '--account', 'beta')
    await waitFor(() => expect(text(h.out)).toContain('Daemon running'))
    expect(existsSync(h.layout.lockFile)).toBe(true)
    h.shutdown()
    expect(await finished).toBe(0)
    expect(existsSync(h.layout.lockFile)).toBe(false)
    expect(h.connection.calls).toContain('start')
  })

  it('--account runs only that account: an account that is not linked idles, with no connection and no marker', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    link(h, 'alpha', ME)
    const finished = run(h, 'daemon', '--account', 'beta')
    await waitFor(() => expect(text(h.err)).toContain('"beta" is not linked'))
    expect(h.connection.calls).toEqual([])
    expect(existsSync(h.accountOf('beta').blockedFile)).toBe(false)
    expect(existsSync(h.accountOf('alpha').blockedFile)).toBe(false)
    h.shutdown()
    expect(await finished).toBe(0)
  })

  it('migrates the old layout under its own lock and runs it as "default"', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: [] })
    // an installation of the old layout: a real database and session under account/
    mkdirSync(h.accountOf('default').authDir, { recursive: true })
    link(h, 'default', ME)
    renameSync(h.accountOf('default').dir, h.layout.legacyAccountDir)
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    const finished = run(h, 'daemon')
    await waitFor(() => expect(text(h.out)).toContain('Daemon running'))
    expect(existsSync(h.layout.legacyAccountDir)).toBe(false)
    expect(existsSync(h.accountOf('default').dbFile)).toBe(true)
    h.shutdown()
    expect(await finished).toBe(0)
    h.out.length = 0
    await run(h, 'accounts')
    expect(text(h.out)).toMatch(/default\s+whatsapp/)
  })

  it('every command refuses to migrate the old layout under a running daemon, with a clear message', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: [] })
    mkdirSync(join(h.layout.legacyAccountDir, 'auth'), { recursive: true })
    writeFileSync(join(h.layout.legacyAccountDir, 'db.sqlite'), 'old-daemon-database')
    await acquireDaemonLock(h.layout.lockFile, process.ppid)
    for (const command of [['status'], ['accounts'], ['doctor'], ['digest'], ['daemon'], ['unlink', '--yes']]) {
      h.err.length = 0
      expect(await run(h, ...command), command[0]).toBe(1)
      expect(text(h.err)).toContain(`pid ${process.ppid}`)
      // the commands that open the installation explain why the old layout cannot be moved yet
      if (['status', 'accounts', 'doctor', 'digest'].includes(command[0] as string)) {
        expect(text(h.err)).toContain('account/')
      }
    }
    expect(readFileSync(join(h.layout.legacyAccountDir, 'db.sqlite'), 'utf8')).toBe('old-daemon-database')
    expect(existsSync(h.accountOf('default').dir)).toBe(false)
  })
})

describe('RF-51 holds per account', () => {
  const connectionOf = (user: { id: string }, sent: string[]) => ({
    selfChat: () => ({
      user,
      sendTextToSelf: async (value: string) => {
        sent.push(value)
      },
    }),
  })
  const queue = (runtime: ReturnType<Harness['runtime']>, ...parts: string[]) =>
    runtime.store.commit({ previousPointer: null, pointer: 1, digest: null, parts })

  it("the runtime of account A never delivers to the own chat of account B, and B's parts are not A's", async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    const alpha = h.runtime('alpha')
    const beta = h.runtime('beta')
    try {
      alpha.identity.bind(ME)
      beta.identity.bind(OTHER)
      await queue(alpha, 'digest of alpha')
      await queue(beta, 'digest of beta')

      // A's runtime with the live session of B's number: nothing is sent, A's part stays queued
      const sentToB: string[] = []
      const wrongSession = new DeliverPending(
        alpha.outbox,
        new WhatsAppSelfChatDelivery(connectionOf({ id: OTHER }, sentToB), alpha.identity),
      )
      expect(await wrongSession.run()).toEqual({ delivered: 0, failure: 'rejected' })
      expect(sentToB).toEqual([])
      expect((await alpha.outbox.pending()).map((p) => p.text)).toEqual(['digest of alpha'])

      // A's runtime with its own session sends A's parts only, never B's
      const sentToA: string[] = []
      const own = new DeliverPending(
        alpha.outbox,
        new WhatsAppSelfChatDelivery(connectionOf({ id: ME }, sentToA), alpha.identity),
      )
      expect(await own.run()).toEqual({ delivered: 1, failure: null })
      expect(sentToA).toEqual(['digest of alpha'])
      expect((await beta.outbox.pending()).map((p) => p.text)).toEqual(['digest of beta'])
    } finally {
      alpha.close()
      beta.close()
    }
  })

  it('each account keeps its own bound account in its own database', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    link(h, 'alpha', ME)
    link(h, 'beta', OTHER)
    const alpha = h.runtime('alpha')
    const beta = h.runtime('beta')
    try {
      expect(alpha.identity.get()).toBe(ME)
      expect(beta.identity.get()).toBe(OTHER)
      expect(alpha.layout.dbFile).not.toBe(beta.layout.dbFile)
      // binding is write-once per database: another account's number cannot be bound into this one
      expect(alpha.identity.bind(OTHER)).toBe(false)
      expect(alpha.identity.get()).toBe(ME)
    } finally {
      alpha.close()
      beta.close()
    }
  })

  it('a daemon of account A whose live session is B number delivers nothing and blocks A only', async () => {
    const h = await makeHarness({ config: CONFIG, accounts: ['alpha', 'beta'] })
    link(h, 'alpha', ME)
    link(h, 'beta', OTHER)
    const beta = h.runtime('beta')
    await queue(beta, 'beta private part')
    beta.close()
    const alpha = h.runtime('alpha')
    await queue(alpha, 'alpha private part')
    alpha.close()
    h.connection.user = { id: OTHER }
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    const finished = run(h, 'daemon', '--account', 'alpha')
    // the file exists a moment before its content is complete: wait for the content
    await waitFor(() =>
      expect(JSON.parse(readFileSync(h.accountOf('alpha').blockedFile, 'utf8')).reason).toBe('mismatch'),
    )
    expect(h.connection.sent).toEqual([])
    expect(existsSync(h.accountOf('beta').blockedFile)).toBe(false)
    h.shutdown()
    await finished
    const check = h.runtime('beta')
    expect((await check.outbox.pending()).map((p) => p.text)).toEqual(['beta private part'])
    check.close()
  })
})
