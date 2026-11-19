import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { err, ok } from '../../../src/domain/result.js'
import { runMain } from '../../../src/main/app.js'
import { writeBlocked } from '../../../src/main/blocked.js'
import { maskAccount } from '../../../src/main/context.js'
import { acquireDaemonLock } from '../../../src/main/daemon-lock.js'
import { createLogger } from '../../../src/main/logger.js'
import { writeUnitState } from '../../../src/main/unit-state.js'
import {
  BA,
  disposeHarnesses,
  FakeSummarizer,
  flush,
  type Harness,
  ME,
  makeHarness,
  NOW,
  OTHER,
  SUMMARY,
  seedMessages,
  until,
  waitFor,
} from '../../support/cli-harness.js'
import { isWindows } from '../../support/platform.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  disposeHarnesses()
})

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const stateOf = async (h: Harness) => {
  const runtime = h.runtime()
  try {
    return {
      pointer: await runtime.store.getPointer(),
      pending: (await runtime.outbox.pending()).map((p) => p.text),
      account: runtime.identity.get(),
      history: runtime.store.history().length,
    }
  } finally {
    runtime.close()
  }
}
/** A session whose phone confirmed the link: `creds.me` is there. */
const REGISTERED = JSON.stringify({ me: { id: ME } })
const linkedWithSession = async (h: Harness) => {
  const runtime = h.runtime()
  runtime.identity.bind(ME)
  runtime.close()
  writeFileSync(join(h.account.authDir, 'creds.json'), REGISTERED)
}
const seed = async (h: Harness, ...messages: Parameters<typeof seedMessages>[1][number][]) => {
  const runtime = h.runtime()
  await seedMessages(runtime, messages)
  runtime.close()
}

describe('msum init', () => {
  it('creates the data directory with mode 0700 and a config.json that is valid and private', async () => {
    const h = await makeHarness({ config: null, summarizer: null })
    expect(await run(h, 'init')).toBe(0)
    if (!isWindows) expect(statSync(h.layout.dataDir).mode & 0o777).toBe(0o700)
    if (!isWindows) expect(statSync(h.layout.accountsDir).mode & 0o777).toBe(0o700)
    if (!isWindows) expect(statSync(h.layout.configFile).mode & 0o777).toBe(0o600)
    const written = JSON.parse(readFileSync(h.layout.configFile, 'utf8'))
    // RF-41: no default provider
    expect(written.provider.primary).toBeNull()
    // no schedules are written: they are added with `msum schedule add`
    expect(written).not.toHaveProperty('schedules')
    expect(h.out.join('\n')).toContain('msum schedule add')
    expect(h.out.join('\n')).toContain('msum link')
    // it says which time zone it wrote (the system's), and what to do in Docker
    expect(written.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(h.out.join('\n')).toContain(`Zona horaria: ${written.timezone}`)
    expect(h.out.join('\n')).toContain('en Docker definí TZ o "timezone"')
    // and a daemon refuses to run schedules until the provider is chosen
    expect(await run(h, 'schedule', 'add', '--time', '07:00')).toBe(0)
    expect(await run(h, 'daemon')).toBe(2)
    expect(h.err.join('\n')).toContain('provider.primary')
    // and the commands accept it
    expect(await run(h, 'status')).toBe(0)
  })

  it('never overwrites an existing configuration', async () => {
    const h = await makeHarness({ config: '{"language":"en","concurrency":9}' })
    expect(await run(h, 'init')).toBe(0)
    expect(readFileSync(h.layout.configFile, 'utf8')).toBe('{"language":"en","concurrency":9}')
    expect(h.out.join('\n')).toContain('already exists')
  })
})

describe('configuration errors (RF-73)', () => {
  it('prints every problem with its option and reason, in the language of the file, and runs nothing', async () => {
    const h = await makeHarness({ config: { language: 'en', concurrency: 0, timezone: 'Mars/Base', hideRest: 'no' } })
    expect(await run(h, 'digest', '--dry-run')).toBe(2)
    const text = h.err.join('\n')
    expect(text).toContain('The configuration has problems')
    expect(text).toContain('"concurrency" must be a number greater than zero')
    expect(text).toContain('"timezone" is not a valid time zone')
    expect(text).toContain('"hideRest" must be true or false')
    expect(h.summarizer.requests).toEqual([])
  })

  it('speaks Spanish when the file says so', async () => {
    const h = await makeHarness({ config: { language: 'es', concurrency: 0 } })
    expect(await run(h, 'status')).toBe(2)
    // status prints every account's block, with the problem inside the block, and exits non-zero at the end
    expect(h.out.join('\n')).toContain('La configuración tiene problemas')
    expect(h.out.join('\n')).toContain('concurrency')
  })

  it('reports a file that is not JSON', async () => {
    const h = await makeHarness({ config: '{oops' })
    expect(await run(h, 'daemon')).toBe(2)
    expect(h.err.join('\n')).toContain('no es un JSON válido')
  })
})

describe('msum digest', () => {
  it('--dry-run prints the digest and saves nothing: no history, no outbox, no pointer (RF-64)', async () => {
    const h = await makeHarness()
    await seed(h, { id: 'm1', text: 'are we still on for dinner?' })
    expect(await run(h, 'digest', '--dry-run')).toBe(0)
    expect(h.out.join('\n')).toContain(SUMMARY.resumen)
    expect(h.err.join('\n')).toContain('nothing was saved or sent')
    expect(h.summarizer.requests).toHaveLength(1)
    expect(await stateOf(h)).toEqual({ pointer: null, pending: [], account: null, history: 0 })
    // and the connection was never touched
    expect(h.connection.calls).toEqual([])
    expect(h.connection.hooks).toBeNull()
  })

  it('a normal run commits the parts to the outbox and moves the pointer, without delivering', async () => {
    const h = await makeHarness()
    await seed(h, { id: 'm1', text: 'are we still on for dinner?' })
    expect(await run(h, 'digest')).toBe(0)
    expect(h.out.join('\n')).toMatch(/1 conversations summarized, 0 with errors\. 1 parts queued/)
    const state = await stateOf(h)
    expect(state.pointer).toBe(NOW)
    expect(state.pending).toHaveLength(1)
    expect(state.pending[0]).toContain(SUMMARY.resumen)
    expect(state.history).toBe(1)
    expect(h.connection.sent).toEqual([])
    expect(h.connection.calls).toEqual([])
  })

  it('a second run starts where the first ended: nothing new, nothing to summarize', async () => {
    const h = await makeHarness()
    await seed(h, { id: 'm1', text: 'hello there' })
    await run(h, 'digest')
    h.out.length = 0
    expect(await run(h, 'digest')).toBe(0)
    expect(h.out.join('\n')).toContain('nothing to summarize')
    expect(h.summarizer.requests).toHaveLength(1)
  })

  it('--hours, --from and --to pick the window, read in the time zone of the configuration', async () => {
    const h = await makeHarness()
    // 09:30 in Buenos Aires on 2026-11-17
    await seed(h, { id: 'm1', text: 'morning news', timestamp: Date.parse('2026-11-17T12:30:00Z') })
    expect(await run(h, 'digest', '--dry-run', '--from', '2026-11-17 10:00', '--to', '2026-11-17 11:00')).toBe(0)
    expect(h.out.join('\n')).toContain('nothing to summarize')
    h.out.length = 0
    expect(await run(h, 'digest', '--dry-run', '--from', '2026-11-17 09:00', '--to', '2026-11-17 10:00')).toBe(0)
    expect(h.out.join('\n')).toContain(SUMMARY.resumen)
    h.out.length = 0
    expect(await run(h, 'digest', '--dry-run', '--hours', '1')).toBe(0)
    expect(h.out.join('\n')).toContain('nothing to summarize')
    expect(await run(h, 'digest', '--dry-run', '--hours', '4')).toBe(0)
  })

  it('prints window errors translated, with the flag to fix', async () => {
    const h = await makeHarness()
    expect(await run(h, 'digest', '--hours', '0')).toBe(2)
    expect(h.err.join('\n')).toBe('The number of hours must be a number greater than zero. Check --hours.')
    h.err.length = 0
    expect(await run(h, 'digest', '--from', '2026-11-17 12:00', '--to', '2026-11-17 11:00')).toBe(2)
    expect(h.err.join('\n')).toContain('The start of the window must be before its end. Check --from and --to.')
    expect(await stateOf(h)).toMatchObject({ pointer: null })
  })

  it('reports the argument errors of the digest flags', async () => {
    const h = await makeHarness()
    expect(await run(h, 'digest', '--hours', 'abc')).toBe(2)
    expect(h.err.join('\n')).toContain('--hours must be a number')
    h.err.length = 0
    expect(await run(h, 'digest', '--from', 'yesterday')).toBe(2)
    expect(h.err.join('\n')).toContain('YYYY-MM-DD HH:MM')
  })

  it('asks to choose a provider when there is none (RF-41)', async () => {
    const h = await makeHarness({ config: { language: 'en' }, summarizer: null })
    expect(await run(h, 'digest')).toBe(2)
    expect(h.err.join('\n')).toContain('"provider.primary"')
  })

  it('reports a digest that another run finished first, saving nothing', async () => {
    const h = await makeHarness()
    await seed(h, { id: 'm1', text: 'hello there' })
    // while this run is summarizing, another process (the daemon) commits a digest of its own
    const racing = new FakeSummarizer(async () => {
      const other = h.runtime()
      await other.store.commit({ previousPointer: null, pointer: 5, digest: null, parts: [] })
      other.close()
      return ok(SUMMARY)
    })
    Object.assign(h.ctx, { summarizer: racing })
    expect(await run(h, 'digest')).toBe(1)
    expect(h.err.join('\n')).toContain('Another digest finished first')
    expect(await stateOf(h)).toMatchObject({ pointer: 5, pending: [], history: 0 })
  })

  it('reports an unreadable promptFile', async () => {
    // an absolute path that exists on no OS (a path with no drive letter would take the drive of the config on Windows)
    const missing = join(tmpdir(), 'msum-no-such-dir', 'prompt.md')
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: 'claude-cli' }, promptFile: missing },
    })
    await seed(h, { id: 'm1', text: 'hello there' })
    expect(await run(h, 'digest', '--dry-run')).toBe(2)
    expect(h.err.join('\n')).toContain(missing)
  })

  it('uses the custom prompt file, read again on every run', async () => {
    const h = await makeHarness({ config: { language: 'en', provider: { primary: 'claude-cli' } } })
    const prompt = join(h.dir, 'prompt.md')
    writeFileSync(prompt, 'Custom prompt for {{name}}.')
    writeFileSync(
      h.layout.configFile,
      JSON.stringify({ language: 'en', provider: { primary: 'claude-cli' }, promptFile: prompt }),
    )
    await seed(h, { id: 'm1', text: 'hello there' })
    await run(h, 'digest', '--dry-run')
    expect(h.summarizer.requests[0]?.systemPrompt).toContain('Custom prompt for')
    writeFileSync(prompt, 'Second version.')
    await run(h, 'digest', '--dry-run')
    expect(h.summarizer.requests[1]?.systemPrompt).toBe('Second version.')
  })

  it('reads a relative promptFile from the data directory, not from the current directory', async () => {
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: 'claude-cli' }, promptFile: 'prompts/mine.md' },
    })
    mkdirSync(join(h.layout.dataDir, 'prompts'))
    writeFileSync(join(h.layout.dataDir, 'prompts', 'mine.md'), 'Relative prompt.')
    await seed(h, { id: 'm1', text: 'hello there' })
    expect(await run(h, 'digest', '--dry-run')).toBe(0)
    expect(h.summarizer.requests[0]?.systemPrompt).toBe('Relative prompt.')
    // a missing one is reported by its resolved path
    writeFileSync(
      h.layout.configFile,
      JSON.stringify({ language: 'en', provider: { primary: 'claude-cli' }, promptFile: 'nope.md' }),
    )
    expect(await run(h, 'digest', '--dry-run')).toBe(2)
    expect(h.err.join('\n')).toContain(join(h.layout.dataDir, 'nope.md'))
  })

  it('shows a conversation that fails as an error count, not its reason', async () => {
    const failing = new FakeSummarizer(() => err('provider said: SECRET-REASON'))
    const h = await makeHarness({ summarizer: failing })
    await seed(h, { id: 'm1', text: 'hello there' })
    expect(await run(h, 'digest')).toBe(0)
    expect(h.out.join('\n')).toContain('0 conversations summarized, 1 with errors')
    expect(h.out.join('') + h.err.join('')).not.toContain('SECRET-REASON')
  })
})

describe('msum unlink', () => {
  const linked = async (h: Harness) => {
    const runtime = h.runtime()
    runtime.identity.bind(ME)
    await runtime.store.commit({
      previousPointer: null,
      pointer: 1,
      digest: null,
      parts: ['private part 1', 'private part 2'],
    })
    const [first] = await runtime.outbox.pending()
    if (first !== undefined) await runtime.outbox.markSent(first.id)
    runtime.close()
  }

  const A_SECRET = 'A-ONLY-SECRET-TEXT'

  /** Account A with its messages, a digest, pending parts, a session and a blocked marker. */
  const accountA = async (h: Harness) => {
    await linked(h)
    const runtime = h.runtime()
    await seedMessages(runtime, [{ id: 'a1', text: A_SECRET, conversationName: 'Ana of A' }])
    runtime.close()
    await run(h, 'digest') // a digest of A, queued
    writeFileSync(join(h.account.authDir, 'creds.json'), REGISTERED)
    writeFileSync(join(h.account.authDir, 'session-key-1.json'), '{"key":"A-private-key"}')
    await writeBlocked(h.account.blockedFile, 'loggedOut', NOW)
  }

  /** Every file under the data directory, with its content. */
  const everything = (h: Harness): string[] => {
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else found.push(`${path}\n${readFileSync(path).toString('latin1')}`)
      }
    }
    walk(h.layout.dataDir)
    return found
  }

  it('deletes the whole account directory: database (wal, shm), session and marker, but keeps the config', async () => {
    const h = await makeHarness()
    await accountA(h)
    expect(existsSync(h.account.dbFile)).toBe(true)
    expect(everything(h).join('')).toContain(A_SECRET)
    expect(await run(h, 'unlink', '--yes')).toBe(0)
    expect(existsSync(h.account.dir)).toBe(false)
    expect(existsSync(h.account.dbFile)).toBe(false)
    expect(existsSync(`${h.account.dbFile}-wal`)).toBe(false)
    expect(existsSync(`${h.account.dbFile}-shm`)).toBe(false)
    expect(existsSync(h.account.blockedFile)).toBe(false)
    expect(existsSync(h.layout.configFile)).toBe(true)
    expect(everything(h).join('')).not.toContain(A_SECRET)
    expect(everything(h).join('')).not.toContain('A-private-key')
    expect(h.questions).toEqual([])
  })

  it('tells the user to remove the device from the phone', async () => {
    const h = await makeHarness()
    await linked(h)
    await run(h, 'unlink', '--yes')
    expect(h.out.join('\n')).toContain('Settings > Linked devices, remove this device')
    expect(h.out.join('\n')).toContain('messages, digests and session were deleted')
  })

  it('unlink A, link B: nothing of A remains, reaches a digest or can be delivered to B', async () => {
    const h = await makeHarness()
    await accountA(h)
    expect(await run(h, 'unlink', '--yes')).toBe(0)

    // link B: another phone
    h.connection.user = { id: OTHER }
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    expect(await run(h, 'link')).toBe(0)
    expect((await stateOf(h)).account).toBe(OTHER)
    expect(everything(h).join('')).not.toContain(A_SECRET)

    // B has its own message; the digest of B has only B
    const runtime = h.runtime()
    await seedMessages(runtime, [{ id: 'b1', text: 'B-ONLY-TEXT', conversationId: '5491100000055@s.whatsapp.net' }])
    runtime.close()
    h.out.length = 0
    h.summarizer.requests.length = 0
    expect(await run(h, 'digest', '--dry-run')).toBe(0)
    const requests = h.summarizer.requests.map((r) => r.transcript).join('\n')
    expect(requests).toContain('B-ONLY-TEXT')
    expect(requests).not.toContain(A_SECRET)
    expect(h.out.join('\n')).not.toContain('Ana of A')
    // and nothing of A is queued for B
    expect((await stateOf(h)).pending).toEqual([])
    expect(await stateOf(h)).toMatchObject({ history: 0 })
  })

  it('asks first and changes nothing when the answer is no', async () => {
    const h = await makeHarness({ confirm: false })
    await linked(h)
    expect(await run(h, 'unlink')).toBe(1)
    expect(h.questions).toHaveLength(1)
    expect(h.questions[0]).toContain('ALL the data of the account')
    expect(h.connection.calls).toEqual([])
    expect(await stateOf(h)).toMatchObject({ account: ME, pending: ['private part 2'] })
    expect(h.err.join('\n')).toContain('Cancelled')
  })

  it('goes ahead when the answer is yes', async () => {
    const h = await makeHarness({ confirm: true })
    await linked(h)
    expect(await run(h, 'unlink')).toBe(0)
    expect(h.questions).toHaveLength(1)
    expect(existsSync(h.account.dir)).toBe(false)
  })

  it('refuses for an account the running daemon is using (linked, not blocked)', async () => {
    const h = await makeHarness()
    await linked(h)
    writeFileSync(join(h.account.authDir, 'creds.json'), REGISTERED)
    await acquireDaemonLock(h.layout.lockFile, process.pid)
    expect(await run(h, 'unlink', '--yes')).toBe(1)
    expect(h.err.join('\n')).toContain(`being used by the running daemon (pid ${process.pid})`)
    expect(h.err.join('\n')).toContain(`kill ${process.pid}`)
    expect(await stateOf(h)).toMatchObject({ account: ME })
  })

  it('works while a daemon runs for an account it leaves idle (not linked, or blocked)', async () => {
    const h = await makeHarness({ accounts: ['idle', 'blocked'] })
    await acquireDaemonLock(h.layout.lockFile, process.pid)
    await writeBlocked(h.accountOf('blocked').blockedFile, 'forbidden', NOW)
    writeFileSync(join(h.accountOf('blocked').authDir, 'creds.json'), REGISTERED)
    expect(await run(h, 'unlink', '--account', 'idle', '--yes')).toBe(0)
    expect(await run(h, 'unlink', '--account', 'blocked', '--yes')).toBe(0)
    expect(existsSync(h.accountOf('idle').dir)).toBe(false)
    expect(existsSync(h.accountOf('blocked').dir)).toBe(false)
  })
})

describe('msum link', () => {
  it('shows the QR, writes it as a private PNG, binds the account, waits for the history and cleans up', async () => {
    const h = await makeHarness()
    let pngMode: number | null = null
    let pngHeader = ''
    h.connection.onStart = async () => {
      h.connection.emit({ state: 'connecting' })
      h.connection.emit({ state: 'qr', qr: 'fake-qr-payload-1' })
      // the QR is written asynchronously: wait until it is there, not for a guessed time
      // (the file exists, empty and private, before the image is written into it: wait for the image)
      await until(() => existsSync(h.account.qrFile) && statSync(h.account.qrFile).size > 8, 'the QR image')
      pngMode = statSync(h.account.qrFile).mode & 0o777
      pngHeader = readFileSync(h.account.qrFile).subarray(1, 4).toString('latin1')
      h.connection.emit({ state: 'connected' })
    }
    expect(await run(h, 'link')).toBe(0)
    const output = h.out.join('\n')
    expect(output).toContain('Scan the QR code')
    expect(output).toContain(h.account.qrFile)
    expect(output).toContain('Receiving the initial history')
    expect(output).toContain('Done: account +54')
    expect(output).not.toContain(ME.split('@')[0] as string)
    // POSIX file modes do not exist on Windows (the ACL of the profile applies there)
    if (!isWindows) expect(pngMode).toBe(0o600)
    expect(pngHeader).toBe('PNG')
    expect(existsSync(h.account.qrFile)).toBe(false)
    expect((await stateOf(h)).account).toBe(ME)
    expect(h.connection.calls).toEqual(['start', 'stop', 'stop'])
    // the QR is a credential: not in any log
    expect(h.logs.join('')).not.toContain('fake-qr-payload')
  })

  it('after the history reports complete it still waits for the quiet period before it stops the connection', async () => {
    const h = await makeHarness()
    const quietMs = 300
    Object.assign(h.ctx, {
      linkTiming: {
        ...h.ctx.linkTiming,
        quietMs,
        minAfterConnectMs: 10_000,
        maxAfterConnectMs: 30_000,
        connectTimeoutMs: 30_000,
      },
    })
    let capturedAt = 0
    let stoppedAt = 0
    const stop = h.connection.stop.bind(h.connection)
    h.connection.stop = async () => {
      if (stoppedAt === 0) stoppedAt = Date.now()
      await stop()
    }
    let delivering: Promise<void> = Promise.resolve()
    h.connection.onStart = () => {
      h.connection.emit({ state: 'connected' })
      // the report of completion comes first; the last chunk is still being stored
      h.connection.emitHistory({ percent: 100, complete: true, explicit: true })
      delivering = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        await h.connection.hooks?.capture?.conversationMetadata({
          conversation: { id: 'late@s.whatsapp.net', isGroup: false, name: null, participantId: null, address: 'late' },
        })
        capturedAt = Date.now()
      })()
    }
    const started = Date.now()
    expect(await run(h, 'link')).toBe(0)
    await delivering
    expect(capturedAt).toBeGreaterThan(0)
    expect(stoppedAt).toBeGreaterThanOrEqual(capturedAt + quietMs - 30)
    // the minimum wait of 10 s was skipped
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('waits until the history stops arriving', async () => {
    const h = await makeHarness()
    // A generous quiet window, so a slow machine cannot make the link believe the history is over between two events.
    const quietMs = 1_000
    Object.assign(h.ctx, {
      linkTiming: { ...h.ctx.linkTiming, quietMs, maxAfterConnectMs: 30_000, connectTimeoutMs: 30_000 },
    })
    let lastCaptureAt = 0
    let delivering: Promise<void> = Promise.resolve()
    h.connection.onStart = () => {
      h.connection.emit({ state: 'connected' })
      // the history keeps arriving AFTER the connection opened, through the capture use case
      delivering = (async () => {
        for (let i = 0; i < 6; i++) {
          await flush()
          lastCaptureAt = Date.now()
          await h.connection.hooks?.capture?.conversationMetadata({
            conversation: {
              id: `c${i}@s.whatsapp.net`,
              isGroup: false,
              name: null,
              participantId: null,
              address: `c${i}`,
            },
          })
        }
      })()
    }
    expect(await run(h, 'link')).toBe(0)
    await delivering
    // it did not stop before the history stopped: it waited a full quiet window after the last event...
    expect(Date.now() - lastCaptureAt).toBeGreaterThanOrEqual(quietMs)
    // ...and every conversation of the history was captured
    const runtime = h.runtime()
    for (let i = 0; i < 6; i++) {
      expect(await runtime.repository.findConversation(`c${i}@s.whatsapp.net`)).not.toBeNull()
    }
    runtime.close()
  })

  it('says so when the account is already linked, and connects to nothing', async () => {
    const h = await makeHarness()
    const runtime = h.runtime()
    runtime.identity.bind(ME)
    runtime.close()
    writeFileSync(join(h.account.authDir, 'creds.json'), REGISTERED)
    // idempotent for scripts: a notice and success; the session is not touched
    expect(await run(h, 'link')).toBe(0)
    expect(h.out.join('\n')).toContain('already linked')
    expect(h.out.join('\n')).toContain('msum unlink --account default')
    expect(h.connection.calls).toEqual([])
    expect(readFileSync(join(h.account.authDir, 'creds.json'), 'utf8')).toBe(REGISTERED)
  })

  it('does not take a half-finished link (credentials with no registered account) for a session', async () => {
    const h = await makeHarness()
    const runtime = h.runtime()
    runtime.identity.bind(ME)
    runtime.close()
    writeFileSync(join(h.account.authDir, 'creds.json'), '{"noiseKey":{}}')
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    expect(await run(h, 'link')).toBe(0)
    expect(h.connection.calls).toContain('start')
  })

  it('on a session of a different account it deletes that session, captures nothing more and fails', async () => {
    const h = await makeHarness()
    const runtime = h.runtime()
    runtime.identity.bind(OTHER)
    runtime.close()
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    expect(await run(h, 'link')).toBe(1)
    expect(h.err.join('\n')).toContain('different account')
    expect(h.connection.calls).toContain('clearSession')
    expect(h.connection.calls.indexOf('clearSession')).toBeLessThan(h.connection.calls.lastIndexOf('stop'))
    expect((await stateOf(h)).account).toBe(OTHER)
  })

  it('on a session with no phone number it deletes the session and fails', async () => {
    const h = await makeHarness()
    h.connection.user = undefined
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    expect(await run(h, 'link')).toBe(1)
    expect(h.err.join('\n')).toContain('Could not link (noAccount)')
    expect(h.connection.calls).toContain('clearSession')
  })

  it('a successful link clears whatever the account was blocked for: it is freshly linked', async () => {
    const h = await makeHarness()
    await writeBlocked(h.account.blockedFile, 'notLinked', NOW)
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    expect(await run(h, 'link')).toBe(0)
    expect(existsSync(h.account.blockedFile)).toBe(false)

    // also a block that only retrying fixes, on an account that had no session to begin with
    const forbidden = await makeHarness()
    await writeBlocked(forbidden.account.blockedFile, 'forbidden', NOW)
    forbidden.connection.onStart = () => forbidden.connection.emit({ state: 'connected' })
    expect(await run(forbidden, 'link')).toBe(0)
    expect(existsSync(forbidden.account.blockedFile)).toBe(false)
  })

  it('refuses to link a linked account that is blocked for a reason only retrying fixes', async () => {
    const h = await makeHarness()
    const runtime = h.runtime()
    runtime.identity.bind(ME)
    runtime.close()
    writeFileSync(join(h.account.authDir, 'creds.json'), REGISTERED)
    await writeBlocked(h.account.blockedFile, 'forbidden', NOW)
    expect(await run(h, 'link')).toBe(1)
    expect(h.err.join('\n')).toContain('msum retry --account default')
    expect(existsSync(h.account.blockedFile)).toBe(true)
    expect(h.connection.calls).toEqual([])
  })

  it('deletes a stale qr.png when it starts', async () => {
    const h = await makeHarness()
    writeFileSync(h.account.qrFile, 'stale')
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    await run(h, 'link')
    expect(existsSync(h.account.qrFile)).toBe(false)
    expect(h.connection.calls[0]).toBe('start')
  })

  it('on SIGINT or SIGTERM it deletes the qr.png and stops the connection cleanly', async () => {
    const h = await makeHarness()
    h.connection.onStart = async () => {
      h.connection.emit({ state: 'qr', qr: 'fake-qr-payload-2' })
      await waitFor(() => expect(existsSync(h.account.qrFile)).toBe(true))
      h.shutdown()
    }
    expect(await run(h, 'link')).toBe(130)
    expect(existsSync(h.account.qrFile)).toBe(false)
    expect(h.connection.calls).toContain('stop')
    expect((await stateOf(h)).account).toBeNull()
  })

  it('reports a logged out session, a failed connection and a timeout', async () => {
    const h = await makeHarness()
    h.connection.onStart = () => h.connection.emit({ state: 'loggedOut' })
    expect(await run(h, 'link')).toBe(1)
    expect(h.err.join('\n')).toContain('closed the session')

    const failed = await makeHarness()
    failed.connection.onStart = () => failed.connection.emit({ state: 'error', reason: 'socketFailed' })
    expect(await run(failed, 'link')).toBe(1)
    expect(failed.err.join('\n')).toContain('Could not link (socketFailed)')

    const slow = await makeHarness()
    Object.assign(slow.ctx.linkTiming, { connectTimeoutMs: 30 })
    expect(await run(slow, 'link')).toBe(1)
    expect(slow.err.join('\n')).toContain('Time ran out')
    expect(existsSync(slow.account.qrFile)).toBe(false)
  })

  it('refuses an account the running daemon is using (linked, not blocked), and connects to nothing', async () => {
    const h = await makeHarness()
    const runtime = h.runtime()
    runtime.identity.bind(ME)
    runtime.close()
    writeFileSync(join(h.account.authDir, 'creds.json'), REGISTERED)
    await acquireDaemonLock(h.layout.lockFile, process.pid)
    expect(await run(h, 'link')).toBe(1)
    expect(h.err.join('\n')).toContain(`being used by the running daemon (pid ${process.pid})`)
    expect(h.err.join('\n')).toContain('Ctrl+C')
    expect(h.connection.calls).toEqual([])
  })
})

describe('msum daemon', () => {
  it('connects, keeps running until asked to stop, then stops cleanly and frees the lock', async () => {
    const h = await makeHarness({
      config: { language: 'en', schedules: ['0 7 * * *'], provider: { primary: 'claude-cli' } },
    })
    const runtime = h.runtime()
    runtime.identity.bind(ME)
    runtime.close()
    writeFileSync(join(h.account.authDir, 'creds.json'), REGISTERED)
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    const finished = run(h, 'daemon')
    await waitFor(() => expect(h.out.join('\n')).toContain('Daemon running'))
    expect(existsSync(h.layout.lockFile)).toBe(true)
    h.shutdown()
    expect(await finished).toBe(0)
    expect(h.out.join('\n')).toContain('Daemon stopped')
    expect(existsSync(h.layout.lockFile)).toBe(false)
    expect(h.connection.calls).toContain('stop')
    expect(h.logs.map((l) => JSON.parse(l).event)).toContain('daemon.started')
  })

  it('with no account linked it stays idle (no connection opened) instead of exiting into a restart loop', async () => {
    const h = await makeHarness()
    const finished = run(h, 'daemon')
    await waitFor(() => expect(h.err.join('\n')).toContain('"default" is not linked'))
    expect(h.err.join('\n')).toContain('msum link --account default')
    // nothing is opened for it, and no marker is written: linking is all it needs
    expect(h.connection.calls).toEqual([])
    expect(existsSync(h.account.blockedFile)).toBe(false)
    await until(() => existsSync(h.account.stateFile), 'the state file')
    await waitFor(() => expect(JSON.parse(readFileSync(h.account.stateFile, 'utf8')).state).toBe('idle'))
    h.shutdown()
    expect(await finished).toBe(0)
    expect(existsSync(h.layout.lockFile)).toBe(false)
  })

  it('refuses to start when another daemon runs, and with schedules but no provider', async () => {
    const busy = await makeHarness()
    // another daemon: a different process that is alive (the parent of the test runner)
    await acquireDaemonLock(busy.layout.lockFile, process.ppid)
    expect(await run(busy, 'daemon')).toBe(1)
    expect(busy.err.join('\n')).toContain(`A daemon is running (pid ${process.ppid})`)

    const noProvider = await makeHarness({ config: { language: 'en', schedules: ['0 7 * * *'] }, summarizer: null })
    const runtime = noProvider.runtime()
    runtime.identity.bind(ME)
    runtime.close()
    expect(await run(noProvider, 'daemon')).toBe(2)
    expect(noProvider.err.join('\n')).toContain('provider.primary')
  })

  it('when the connection ends for good it says why, leaves the marker and stays idle until stopped', async () => {
    const h = await makeHarness()
    await linkedWithSession(h)
    h.connection.onStart = () => h.connection.emit({ state: 'loggedOut' })
    const finished = run(h, 'daemon')
    await waitFor(() => expect(h.err.join('\n')).toContain('closed the session from the phone'))
    // the user is told first and the marker is written right after, in parallel with stopping the connection
    await until(() => {
      try {
        return JSON.parse(readFileSync(h.account.blockedFile, 'utf8')).reason === 'loggedOut'
      } catch {
        return false // not there yet, or not completely written
      }
    }, 'the blocked marker')
    expect(JSON.parse(readFileSync(h.account.blockedFile, 'utf8')).reason).toBe('loggedOut')
    expect(existsSync(h.layout.lockFile)).toBe(true) // alive, holding the lock
    h.shutdown()
    expect(await finished).toBe(0)
    expect(existsSync(h.layout.lockFile)).toBe(false)
  })

  it('restarted with the marker it does not connect at all', async () => {
    const h = await makeHarness()
    await linkedWithSession(h)
    await writeBlocked(h.account.blockedFile, 'replaced', NOW)
    const finished = run(h, 'daemon')
    await waitFor(() => expect(h.err.join('\n')).toContain('Another session with the same credentials'))
    expect(h.connection.calls).toEqual([])
    expect(h.logs.map((l) => JSON.parse(l).event)).toContain('daemon.blocked')
    h.shutdown()
    expect(await finished).toBe(0)
  })

  it('--retry clears the marker of a refused or replaced connection and connects', async () => {
    const h = await makeHarness()
    await linkedWithSession(h)
    await writeBlocked(h.account.blockedFile, 'forbidden', NOW)
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    const finished = run(h, 'daemon', '--retry')
    await waitFor(() => expect(h.out.join('\n')).toContain('Daemon running'))
    expect(h.connection.calls).toContain('start')
    expect(existsSync(h.account.blockedFile)).toBe(false)
    h.shutdown()
    expect(await finished).toBe(0)
  })

  it('deletes a stale qr.png when it starts', async () => {
    const h = await makeHarness()
    await linkedWithSession(h)
    writeFileSync(h.account.qrFile, 'stale')
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    const finished = run(h, 'daemon')
    await waitFor(() => expect(h.out.join('\n')).toContain('Daemon running'))
    expect(existsSync(h.account.qrFile)).toBe(false)
    h.shutdown()
    await finished
  })

  it('refreshes the lock (heartbeat) while it runs', async () => {
    const h = await makeHarness()
    await linkedWithSession(h)
    Object.assign(h.ctx, { daemonTiming: { heartbeatMs: 10 } })
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    const finished = run(h, 'daemon')
    await waitFor(() => expect(existsSync(h.layout.lockFile)).toBe(true))
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    utimesSync(h.layout.lockFile, old, old)
    await waitFor(() => expect(Date.now() - statSync(h.layout.lockFile).mtimeMs).toBeLessThan(5_000))
    h.shutdown()
    await finished
  })
})

describe('msum status', () => {
  it('shows the data directory, the masked account, the last digest, the pending parts and the next runs', async () => {
    const h = await makeHarness({ config: { language: 'en', timezone: BA, schedules: ['0 7 * * *', '0 19 * * *'] } })
    const runtime = h.runtime()
    runtime.identity.bind(ME)
    await seedMessages(runtime, [{ id: 'm1', text: 'CONFIDENTIAL CHAT TEXT' }])
    runtime.close()
    await run(h, 'digest')
    h.out.length = 0
    expect(await run(h, 'status')).toBe(0)
    const text = h.out.join('\n')
    expect(text).toContain(h.layout.dataDir)
    expect(text).toContain(maskAccount(ME))
    expect(text).not.toContain('5491100000009')
    expect(text).toMatch(/Last digest: +17 Nov 2026/)
    expect(text).toMatch(/^Pending deliveries: +1$/m)
    expect(text).toMatch(/^Daemon: +stopped$/m)
    // the labels line up: every value starts in the same column
    const rows = text
      .split('\n')
      .filter((l) => /^(Data|Account|Last digest|Pending deliveries|Daemon|Schedule):/.test(l))
    expect(rows.length).toBe(7)
    for (const row of rows) {
      expect(row.slice(0, 20)).toMatch(/^[A-Za-z ]+: *$/)
      expect(row[20]).not.toBe(' ')
    }
    expect(text).toMatch(/^Schedule: +#\d+ every day at 07:00 +next: /m)
    expect(text).toMatch(/^Schedule: +#\d+ every day at 19:00 +next: /m)
    expect(text).not.toContain('CONFIDENTIAL')
    expect(text).not.toContain(SUMMARY.resumen)
  })

  it('works on an empty installation without creating a database', async () => {
    const h = await makeHarness({ config: { language: 'en' } })
    expect(await run(h, 'status')).toBe(0)
    expect(h.out.join('\n')).toContain('not linked')
    expect(h.out.join('\n')).toContain('none yet')
    expect(existsSync(h.account.dbFile)).toBe(false)
  })

  it('reports a running daemon', async () => {
    const h = await makeHarness({ config: { language: 'en' } })
    await acquireDaemonLock(h.layout.lockFile, process.pid)
    await run(h, 'status')
    expect(h.out.join('\n')).toContain(`running (pid ${process.pid})`)
  })

  it('a block marker wins over a stale state file: a blocked account is not shown as connected', async () => {
    const h = await makeHarness({ config: { language: 'en', timezone: BA } })
    await acquireDaemonLock(h.layout.lockFile, process.pid)
    await writeUnitState(h.account.stateFile, { state: 'connected', since: NOW })
    await run(h, 'status')
    expect(h.out.join('\n')).toMatch(/^Connection: +connected/m) // without a marker it is believed
    h.out.length = 0
    await writeBlocked(h.account.blockedFile, 'forbidden', NOW)
    await run(h, 'status')
    const text = h.out.join('\n')
    expect(text).not.toMatch(/^Connection:/m)
    expect(text).toMatch(/^Blocked:/m)
  })

  it('shows a blocked account with its translated reason and what to do', async () => {
    const h = await makeHarness({ config: { language: 'en', timezone: BA } })
    await writeBlocked(h.account.blockedFile, 'forbidden', NOW)
    await run(h, 'status')
    expect(h.out.join('\n')).toMatch(
      /^Blocked: +WhatsApp refused the connection \(403\)\..*msum retry --account default.* \(17 Nov 2026/m,
    )
    const es = await makeHarness({ config: { language: 'es', timezone: BA } })
    await writeBlocked(es.account.blockedFile, 'mismatch', NOW)
    await run(es, 'status')
    expect(es.out.join('\n')).toMatch(/^Bloqueada: +La sesión es de otra cuenta/m)
  })

  it('masks account numbers', () => {
    expect(maskAccount(ME)).toBe('+54*******0009')
    expect(maskAccount('123@s.whatsapp.net')).toBe('+******')
  })
})

describe('msum doctor', () => {
  it('passes on a healthy installation', async () => {
    const h = await makeHarness({ config: { language: 'en', provider: { primary: 'claude-cli' } } })
    const runtime = h.runtime()
    runtime.identity.bind(ME)
    runtime.close()
    writeFileSync(join(h.account.authDir, 'creds.json'), REGISTERED)
    expect(await run(h, 'doctor')).toBe(0)
    const text = h.out.join('\n')
    expect(text).toContain('[ok]   Node: version 22.16.0')
    expect(text).toContain('[ok]   Data directory')
    expect(text).toContain('[ok]   LLM provider: claude-cli (1.0.0 (fake))')
    expect(text).toContain('[ok]   WhatsApp: account linked')
    expect(text).toContain('Everything is in order.')
  })

  it('explains how to fix each problem', async () => {
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: 'claude-cli', backup: 'ollama', ollama: { model: 'm' } } },
      probes: { commandVersion: async () => null, ollamaReachable: async () => false },
    })
    Object.assign(h.ctx, { nodeVersion: '20.1.0' })
    expect(await run(h, 'doctor')).toBe(1)
    const text = h.out.join('\n')
    expect(text).toContain('[fail] Node: version 20.1.0')
    expect(text).toContain('install Node 22.16.0 or later')
    expect(text).toContain('could not run "claude"')
    expect(text).toContain('could not run "http://127.0.0.1:11434"')
    expect(text).toContain('start Ollama')
    expect(text).toContain('[fail] WhatsApp: no account linked')
    expect(text).toContain('run "msum link"')
    expect(text).toContain('There are problems to solve.')
  })

  it('reports an invalid configuration and a missing provider', async () => {
    const h = await makeHarness({ config: { language: 'en', concurrency: 0 } })
    expect(await run(h, 'doctor')).toBe(1)
    expect(h.out.join('\n')).toContain('[fail] Configuration')
    const none = await makeHarness({ config: { language: 'en' } })
    expect(await run(none, 'doctor')).toBe(1)
    expect(none.out.join('\n')).toContain('no provider chosen')
  })

  // The doctor does not check modes on Windows (no POSIX permissions there).
  it.skipIf(isWindows)('reports loose directory permissions', async () => {
    const h = await makeHarness({ config: { language: 'en', provider: { primary: 'claude-cli' } } })
    const { chmod } = await import('node:fs/promises')
    await chmod(h.account.dir, 0o755)
    expect(await run(h, 'doctor')).toBe(1)
    expect(h.out.join('\n')).toContain('has permissions 755')
    expect(h.out.join('\n')).toContain('chmod 700')
    expect((await readdir(h.layout.dataDir)).length).toBeGreaterThan(0)
  })
})

describe('help and unexpected errors', () => {
  it('prints the help in the language of the configuration', async () => {
    const en = await makeHarness({ config: { language: 'en' } })
    expect(await run(en, '--help')).toBe(0)
    expect(en.out[0]).toContain('Usage: msum <command>')
    const es = await makeHarness({ config: { language: 'es' } })
    expect(await run(es, 'help')).toBe(0)
    expect(es.out[0]).toContain('Uso: msum <comando>')
  })

  it('reports an unexpected error by its code only', async () => {
    const h = await makeHarness({ config: { language: 'en' } })
    vi.spyOn(h.ctx.clock, 'now').mockImplementation(() => {
      throw Object.assign(new Error('a secret path /home/sam/x'), { code: 'EACCES' })
    })
    expect(await run(h, 'status')).toBe(1)
    expect(h.err.join('\n')).toBe('Something went wrong (EACCES).')
    expect(h.err.join('') + h.logs.join('')).not.toContain('secret path')
  })
})

describe('logs never contain message text (RNF-04)', () => {
  const SECRET = 'zafiro-7731-confidencial'

  it('keeps the secret out of stdout, stderr and the logs through a digest, a daemon run and a failure', async () => {
    const written: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    const failing = new FakeSummarizer(() => err(`the provider choked on ${SECRET}`))
    const h = await makeHarness({ summarizer: failing })
    // the harness logger and io write to arrays; use the real process streams for the log lines as the CLI does
    Object.assign(h.ctx, { logger: createLogger(process.stdout, process.stderr, () => NOW) })
    const runtime = h.runtime()
    runtime.identity.bind(ME)
    await seedMessages(runtime, [
      { id: 'm1', text: `the code is ${SECRET}`, conversationName: `Ana ${SECRET}` },
      { id: 'm2', text: `please call +5491155550000 ${SECRET}`, conversationId: '5491100000002@s.whatsapp.net' },
    ])
    runtime.close()

    // 1. the CLI digest (fails every conversation: the reason quotes the secret)
    await run(h, 'digest')
    // 2. a successful digest, then a daemon that delivers both to the own chat
    const good = new FakeSummarizer(() => ok({ ...SUMMARY, resumen: `Ana says ${SECRET}` }))
    Object.assign(h.ctx, { summarizer: good })
    Object.assign(h.ctx.clock, { time: NOW + 60_000 })
    await seed(h, { id: 'm3', text: `new news ${SECRET}`, timestamp: NOW + 30_000 })
    await run(h, 'digest')
    h.connection.onStart = () => h.connection.emit({ state: 'connected' })
    writeFileSync(join(h.account.authDir, 'creds.json'), REGISTERED)
    const daemon = run(h, 'daemon')
    await waitFor(() => expect(h.connection.sent.length).toBeGreaterThan(1))
    h.shutdown()
    await daemon
    // 3. status and doctor
    await run(h, 'status')
    await run(h, 'doctor')
    stdout.mockRestore()
    stderr.mockRestore()

    const everything = [...written, ...h.out, ...h.err, ...h.logs].join('\n')
    expect(written.length).toBeGreaterThan(0) // the structured logs did go to the streams
    expect(everything).not.toContain(SECRET)
    expect(everything).not.toContain('5491155550000')
    expect(everything).not.toContain('Ana')
    for (const line of written) expect(() => JSON.parse(line)).not.toThrow()
    // what the user is meant to receive does carry the text: it went to the own chat, not to the logs
    expect(h.connection.sent.join('')).toContain(SECRET)
  })
})
