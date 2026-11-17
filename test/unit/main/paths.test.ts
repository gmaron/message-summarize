import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDaemonLock, runningDaemonPid } from '../../../src/main/daemon-lock.js'
import { ensureDataDirs, layoutOf, loosePermissions, resolveDataDir } from '../../../src/main/paths.js'

describe('resolveDataDir', () => {
  const home = '/home/sam'
  it('prefers MSUM_DATA_DIR, as an absolute path', () => {
    expect(resolveDataDir({ env: { MSUM_DATA_DIR: '/srv/msum' }, platform: 'linux', home })).toBe('/srv/msum')
    expect(resolveDataDir({ env: { MSUM_DATA_DIR: 'relative/dir' }, platform: 'linux', home })).toBe(
      resolve('relative/dir'),
    )
  })

  it('ignores an empty MSUM_DATA_DIR', () => {
    expect(resolveDataDir({ env: { MSUM_DATA_DIR: '  ' }, platform: 'linux', home })).toBe(
      '/home/sam/.local/share/message-summarize',
    )
  })

  it('uses Application Support on macOS', () => {
    expect(resolveDataDir({ env: {}, platform: 'darwin', home: '/Users/sam' })).toBe(
      '/Users/sam/Library/Application Support/message-summarize',
    )
  })

  it('uses XDG_DATA_HOME on Linux, else ~/.local/share', () => {
    expect(resolveDataDir({ env: { XDG_DATA_HOME: '/data/xdg' }, platform: 'linux', home })).toBe(
      '/data/xdg/message-summarize',
    )
    expect(resolveDataDir({ env: {}, platform: 'linux', home })).toBe('/home/sam/.local/share/message-summarize')
  })

  it('uses APPDATA on Windows', () => {
    expect(resolveDataDir({ env: { APPDATA: 'C:\\Users\\sam\\AppData\\Roaming' }, platform: 'win32', home })).toContain(
      'message-summarize',
    )
    expect(resolveDataDir({ env: {}, platform: 'win32', home })).toContain('AppData')
  })
})

describe('layoutOf', () => {
  it('puts the config at the root and everything of the account under account/', () => {
    const layout = layoutOf('/d')
    expect(layout).toEqual({
      dataDir: '/d',
      configFile: '/d/config.json',
      accountDir: '/d/account',
      dbFile: '/d/account/db.sqlite',
      authDir: '/d/account/auth',
      qrFile: '/d/qr.png',
      lockFile: '/d/daemon.pid',
      blockedFile: '/d/account/blocked.json',
    })
  })
})

describe('data directory permissions (RNF-04)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const temp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'msum-paths-'))
    dirs.push(dir)
    return dir
  }
  const mode = (path: string): number => statSync(path).mode & 0o777

  it('creates the directories with mode 0700', async () => {
    const layout = layoutOf(join(temp(), 'new', 'data'))
    await ensureDataDirs(layout)
    for (const dir of [layout.dataDir, layout.accountDir, layout.authDir]) expect(mode(dir)).toBe(0o700)
    expect(await loosePermissions(layout)).toEqual([])
  })

  it('tightens directories that existed with looser modes, and reports them before', async () => {
    const layout = layoutOf(join(temp(), 'data'))
    await ensureDataDirs(layout)
    await chmod(layout.accountDir, 0o755)
    expect(await loosePermissions(layout)).toEqual([{ path: layout.accountDir, mode: '755' }])
    await ensureDataDirs(layout)
    expect(mode(layout.accountDir)).toBe(0o700)
  })

  it('reports nothing for directories that do not exist yet', async () => {
    expect(await loosePermissions(layoutOf(join(temp(), 'missing')))).toEqual([])
  })
})

describe('the daemon lock', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const lockFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'msum-lock-'))
    dirs.push(dir)
    return join(dir, 'daemon.pid')
  }

  const alive = { isAlive: () => true, host: 'host-a' }
  const dead = { isAlive: () => false, host: 'host-a' }

  it('is taken once, and released', async () => {
    const file = lockFile()
    const first = await acquireDaemonLock(file, 111, alive)
    expect(first.ok).toBe(true)
    expect(mode(file)).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: 111, host: 'host-a' })
    expect(await runningDaemonPid(file, alive)).toBe(111)
    const second = await acquireDaemonLock(file, 222, alive)
    expect(second).toEqual({ ok: false, pid: 111 })
    if (first.ok) await first.release()
    expect(await runningDaemonPid(file, alive)).toBeNull()
    expect((await acquireDaemonLock(file, 222, alive)).ok).toBe(true)
  })

  it('takes over a lock whose process is gone', async () => {
    const file = lockFile()
    await acquireDaemonLock(file, 111, alive)
    expect(await runningDaemonPid(file, dead)).toBeNull()
    const taken = await acquireDaemonLock(file, 222, dead)
    expect(taken.ok).toBe(true)
    expect(await runningDaemonPid(file, alive)).toBe(222)
  })

  it('does not release a lock that another daemon took over', async () => {
    const file = lockFile()
    const old = await acquireDaemonLock(file, 111, alive)
    await acquireDaemonLock(file, 222, dead)
    if (old.ok) await old.release()
    expect(await runningDaemonPid(file, alive)).toBe(222)
  })

  it('treats a lock of another host as held, whatever the local processes are', async () => {
    const file = lockFile()
    await acquireDaemonLock(file, 111, { host: 'host-b', isAlive: () => false })
    // the pid does not exist HERE, but it is another machine's pid
    expect(await runningDaemonPid(file, dead)).toBe(111)
    expect(await acquireDaemonLock(file, 222, dead)).toEqual({ ok: false, pid: 111 })
  })

  it('takes over a lock of another host only after an hour with no heartbeat', async () => {
    const file = lockFile()
    await acquireDaemonLock(file, 111, { host: 'host-b' })
    const written = statSync(file).mtimeMs
    const at = (minutes: number) => ({ ...dead, now: () => written + minutes * 60_000 })
    expect(await runningDaemonPid(file, at(59))).toBe(111)
    expect((await acquireDaemonLock(file, 222, at(59))).ok).toBe(false)
    expect(await runningDaemonPid(file, at(61))).toBeNull()
    expect((await acquireDaemonLock(file, 222, at(61))).ok).toBe(true)
  })

  it('the heartbeat keeps a lock of another host fresh: it rewrites the mtime', async () => {
    const file = lockFile()
    const lock = await acquireDaemonLock(file, 111, { host: 'host-b' })
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    utimesSync(file, old, old)
    // two hours with no heartbeat: stale
    expect(await runningDaemonPid(file, dead)).toBeNull()
    if (lock.ok) await lock.heartbeat()
    expect(Date.now() - statSync(file).mtimeMs).toBeLessThan(5_000)
    expect(await runningDaemonPid(file, dead)).toBe(111)
  })

  it('understands the old lock that held only a pid', async () => {
    const file = lockFile()
    writeFileSync(file, '4242\n')
    expect(await runningDaemonPid(file, alive)).toBe(4242)
    expect(await runningDaemonPid(file, dead)).toBeNull()
  })

  it('knows that the current process is alive', async () => {
    const file = lockFile()
    await acquireDaemonLock(file, process.pid)
    expect(await runningDaemonPid(file)).toBe(process.pid)
  })
})

const mode = (path: string): number => statSync(path).mode & 0o777
