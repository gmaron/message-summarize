import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript module of the image
import { dropStaleLock, HEARTBEAT_MS, STALE_AFTER_MS } from '../../../docker/prepare.mjs'
import { allowSubprocess } from '../../support/network-guard.js'
import { isWindows } from '../../support/platform.js'

const root = join(import.meta.dirname, '..', '..', '..')
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msum-prepare-'))
})
afterEach(() => {
  chmodSync(dir, 0o700)
  rmSync(dir, { recursive: true, force: true })
})

const lockFile = (): string => join(dir, 'daemon.pid')
const writeLock = (content: string, ageMs: number): void => {
  writeFileSync(lockFile(), content)
  const when = new Date(Date.now() - ageMs)
  utimesSync(lockFile(), when, when)
}

describe('dropStaleLock', () => {
  it('uses the heartbeat of the daemon lock', () => {
    const source = readFileSync(join(root, 'src/main/installation/daemon-lock.ts'), 'utf8')
    expect(source).toMatch(
      new RegExp(`export const HEARTBEAT_MS = ${String(HEARTBEAT_MS).replace(/(\d)(?=(\d{3})$)/, '$1_')}\\b`),
    )
    expect(STALE_AFTER_MS).toBeGreaterThanOrEqual(2 * HEARTBEAT_MS)
  })

  it('keeps a lock of this host that was refreshed lately (a live daemon)', () => {
    writeLock('{"pid":8,"host":"box"}\n', 5_000)
    expect(dropStaleLock({ dataDir: dir, host: 'box' })).toBe(false)
    expect(existsSync(lockFile())).toBe(true)
  })

  it('removes a lock of this host that nobody refreshed', () => {
    writeLock('{"pid":8,"host":"box"}\n', STALE_AFTER_MS + 1_000)
    expect(dropStaleLock({ dataDir: dir, host: 'box' })).toBe(true)
    expect(existsSync(lockFile())).toBe(false)
  })

  it('keeps the lock of another host, however old', () => {
    writeLock('{"pid":8,"host":"other"}\n', 10 * STALE_AFTER_MS)
    expect(dropStaleLock({ dataDir: dir, host: 'box' })).toBe(false)
    expect(existsSync(lockFile())).toBe(true)
  })

  it('does nothing without a lock, and leaves a file it cannot read as it is', () => {
    expect(dropStaleLock({ dataDir: dir, host: 'box' })).toBe(false)
    writeLock('not json', 10 * STALE_AFTER_MS)
    expect(dropStaleLock({ dataDir: dir, host: 'box' })).toBe(false)
    expect(existsSync(lockFile())).toBe(true)
    writeLock('null', 10 * STALE_AFTER_MS)
    expect(dropStaleLock({ dataDir: dir, host: 'box' })).toBe(false)
  })
})

// docker/entrypoint.sh runs in the Linux image under `sh`, and the last test makes a directory read-only with chmod 0500;
// neither exists on Windows (no `sh`, and chmod does not remove write access from a directory), so this suite is skipped there.
describe.skipIf(isWindows)('entrypoint.sh', () => {
  const entrypoint = join(root, 'docker', 'entrypoint.sh')
  // The script runs under the real shell; its own children (`echo`, `node`) are not spawned through the guarded API.
  let revoke: () => void = () => undefined
  beforeEach(() => {
    revoke = allowSubprocess('sh')
  })
  afterEach(() => revoke())
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync('sh', [entrypoint, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', MSUM_DATA_DIR: dir, HOME: join(dir, 'home'), ...extra },
    })

  it('runs the command it is given', () => {
    const result = run(['echo', 'hello'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
    expect(existsSync(join(dir, 'home'))).toBe(true)
  })

  it('prepares only for `msum daemon`', () => {
    const marker = join(dir, 'prepared')
    const fake = join(dir, 'fake-prepare.mjs')
    writeFileSync(fake, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'x')\n`)
    expect(run(['echo', 'x'], { MSUM_PREPARE: fake }).status).toBe(0)
    expect(existsSync(marker)).toBe(false)
    // `msum` is not installed here: the exec fails after prepare ran, which is what is checked.
    run(['msum', 'daemon'], { MSUM_PREPARE: fake })
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    run(['msum', 'link'], { MSUM_PREPARE: fake })
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)('explains a data directory that is not writable', () => {
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    const result = run(['echo', 'x'], { MSUM_DATA_DIR: locked, HOME: join(locked, 'home') })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/not writable/)
    expect(result.stderr).toMatch(/chown/)
    expect(result.stdout).toBe('')
  })
})
