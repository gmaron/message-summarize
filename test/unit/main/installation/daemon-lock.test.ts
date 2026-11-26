import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireDaemonLock,
  type LinuxIdentity,
  linuxIdentityOf,
  parseProcStatStartTicks,
  parsePsLstart,
  processStartedAt,
  runningDaemonPid,
  START_TOLERANCE_MS,
} from '../../../../src/main/installation/daemon-lock.js'
import { allowSubprocess } from '../../../support/network-guard.js'

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0)

describe('the daemon lock and pid reuse', () => {
  const dirs: string[] = []
  const afterEachRevoke: Array<() => void> = []
  afterEach(() => {
    for (const revoke of afterEachRevoke.splice(0)) revoke()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const lockFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'msum-lock-'))
    dirs.push(dir)
    return join(dir, 'daemon.pid')
  }
  const write = (file: string, content: string): void => writeFileSync(file, content)
  const env = (startedAt: number | null, host = 'host-a') => ({
    isAlive: () => true,
    host,
    startedAt: () => startedAt,
    linuxIdentity: () => null,
  })

  it('treats a live pid that started after the lock as a reused pid: the lock is stale', async () => {
    const file = lockFile()
    write(file, JSON.stringify({ pid: 21, host: 'host-a', started: T0 }))
    const later = env(T0 + START_TOLERANCE_MS + 1_000)
    expect(await runningDaemonPid(file, later)).toBeNull()
    expect(await acquireDaemonLock(file, 99, later)).toMatchObject({ ok: true })
    expect(await runningDaemonPid(file, env(T0))).toBe(99)
  })

  it('keeps a live daemon held, even with an old mtime (a sleeping laptop)', async () => {
    const file = lockFile()
    write(file, JSON.stringify({ pid: 21, host: 'host-a', started: T0 }))
    const old = new Date(Date.now() - 24 * 3_600_000)
    utimesSync(file, old, old)
    for (const actual of [T0 - 60_000, T0, T0 + START_TOLERANCE_MS]) {
      expect(await runningDaemonPid(file, env(actual))).toBe(21)
    }
    expect(await acquireDaemonLock(file, 99, env(T0))).toEqual({ ok: false, pid: 21 })
  })

  it('keeps today behavior when the start of the pid is unknown', async () => {
    const file = lockFile()
    write(file, JSON.stringify({ pid: 21, host: 'host-a', started: T0 }))
    expect(await runningDaemonPid(file, env(null))).toBe(21)
    const throwing = { ...env(null), startedAt: () => Promise.reject(new Error('boom')) }
    expect(await runningDaemonPid(file, throwing)).toBe(21)
  })

  it('keeps today behavior for a lock without started and for a bare pid', async () => {
    const file = lockFile()
    const much = env(T0 + 3_600_000)
    write(file, JSON.stringify({ pid: 21, host: 'host-a' }))
    expect(await runningDaemonPid(file, much)).toBe(21)
    write(file, '21\n')
    expect(await runningDaemonPid(file, much)).toBe(21)
    expect(await acquireDaemonLock(file, 99, much)).toEqual({ ok: false, pid: 21 })
  })

  it('does not change a lock of another host', async () => {
    const file = lockFile()
    write(file, JSON.stringify({ pid: 21, host: 'host-b', started: T0 }))
    expect(await runningDaemonPid(file, env(T0 + 3_600_000))).toBe(21)
  })

  it('records started when the lock is taken', async () => {
    const file = lockFile()
    await acquireDaemonLock(file, 7, env(T0))
    expect(await runningDaemonPid(file, env(T0))).toBe(7)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: 7, host: 'host-a', started: T0 })
  })

  it('reads the start of this very process within the tolerance (macOS and other Unix, real ps)', async () => {
    if (process.platform === 'win32' || process.platform === 'linux') return
    afterEachRevoke.push(allowSubprocess('ps'))
    const read = await processStartedAt(process.pid)
    expect(read).not.toBeNull()
    const fromUptime = Date.now() - process.uptime() * 1000
    expect(Math.abs((read as number) - fromUptime)).toBeLessThanOrEqual(START_TOLERANCE_MS)
  })

  it('reads a stable identity of this very process (Linux, real /proc)', async () => {
    if (process.platform !== 'linux') return
    const first = await linuxIdentityOf(process.pid)
    expect(first).not.toBeNull()
    expect(await linuxIdentityOf(process.pid)).toEqual(first)
    expect(await processStartedAt(process.pid)).toBeNull() // Linux never goes through the wall clock
  })

  it('a real lock of this process is held by the real readers', async () => {
    if (process.platform === 'darwin') afterEachRevoke.push(allowSubprocess('ps'))
    const file = lockFile()
    expect((await acquireDaemonLock(file, process.pid)).ok).toBe(true)
    expect(await runningDaemonPid(file)).toBe(process.pid)
  })

  it('parses /proc/<pid>/stat with spaces and parentheses in comm', () => {
    const fields = [
      'S',
      '1',
      '1',
      '1',
      '0',
      '-1',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '1',
      '0',
      '123456',
    ]
    expect(fields).toHaveLength(20)
    expect(parseProcStatStartTicks(`4242 (we ird) na)me) ${fields.join(' ')} 99 100`)).toBe(123456)
    expect(parseProcStatStartTicks('4242 (x) S 1')).toBeNull()
    expect(parseProcStatStartTicks('garbage')).toBeNull()
  })

  it('parses the lstart of ps', () => {
    expect(parsePsLstart('Mon Nov 23 11:32:04 2026')).toBe(new Date(2026, 10, 23, 11, 32, 4).getTime())
    expect(parsePsLstart('Mon Nov  3 01:02:03 2026')).toBe(new Date(2026, 10, 3, 1, 2, 3).getTime())
    expect(parsePsLstart('nonsense')).toBeNull()
  })

  describe('Linux identity (fake /proc)', () => {
    // the wall clock is not part of the identity: a /proc whose btime moved is the same /proc as far as we care
    const linux = (identity: LinuxIdentity | null) => ({
      isAlive: () => true,
      host: 'host-a',
      startedAt: () => {
        throw new Error('the epoch path must not be used for a Linux lock')
      },
      linuxIdentity: () => identity,
    })
    const same: LinuxIdentity = { ticks: 5_000, bootId: 'boot-1' }

    it('records ticks and boot id, and no epoch', async () => {
      const file = lockFile()
      await acquireDaemonLock(file, 7, linux(same))
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: 7, host: 'host-a', ticks: 5_000, bootId: 'boot-1' })
    })

    it('holds a live daemon whatever the wall clock did in between', async () => {
      const file = lockFile()
      await acquireDaemonLock(file, 7, linux(same))
      // a clock step moves btime (and nothing else the identity reads): same ticks, same boot id
      expect(await runningDaemonPid(file, { ...linux(same), now: () => Date.now() + 7 * 86_400_000 })).toBe(7)
      expect(await acquireDaemonLock(file, 8, linux({ ...same }))).toEqual({ ok: false, pid: 7 })
    })

    it('takes over when the ticks differ (reused pid)', async () => {
      const file = lockFile()
      await acquireDaemonLock(file, 7, linux(same))
      const reused = linux({ ticks: 9_999, bootId: 'boot-1' })
      expect(await runningDaemonPid(file, reused)).toBeNull()
      expect((await acquireDaemonLock(file, 8, reused)).ok).toBe(true)
    })

    it('takes over when the boot id differs (another boot), even with equal ticks', async () => {
      const file = lockFile()
      await acquireDaemonLock(file, 7, linux(same))
      const rebooted = linux({ ticks: 5_000, bootId: 'boot-2' })
      expect(await runningDaemonPid(file, rebooted)).toBeNull()
    })

    it('holds when the identity cannot be read now', async () => {
      const file = lockFile()
      await acquireDaemonLock(file, 7, linux(same))
      expect(await runningDaemonPid(file, linux(null))).toBe(7)
      const throwing = { ...linux(same), linuxIdentity: () => Promise.reject(new Error('boom')) }
      expect(await runningDaemonPid(file, throwing)).toBe(7)
    })

    it('falls back to started (the uptime of this process) when the identity cannot be read while taking the lock', async () => {
      const file = lockFile()
      const unreadable = { isAlive: () => true, host: 'host-a', linuxIdentity: () => null, startedAt: () => null }
      expect((await acquireDaemonLock(file, process.pid, unreadable)).ok).toBe(true)
      const lock = JSON.parse(readFileSync(file, 'utf8'))
      expect(lock).not.toHaveProperty('ticks')
      expect(lock).not.toHaveProperty('bootId')
      expect(Math.abs(lock.started - (Date.now() - process.uptime() * 1000))).toBeLessThanOrEqual(START_TOLERANCE_MS)
      // the next reader cannot tell either (Linux has no epoch reader): held, as today
      expect(await runningDaemonPid(file, unreadable)).toBe(process.pid)
    })

    it('a lock with ticks but no boot id is not trusted as a Linux lock: today behavior', async () => {
      const file = lockFile()
      write(file, JSON.stringify({ pid: 7, host: 'host-a', ticks: 1 }))
      expect(await runningDaemonPid(file, linux({ ticks: 2, bootId: 'x' }))).toBe(7)
    })
  })

  it('does not remove a lock that another daemon wrote after the stale verdict', async () => {
    const file = lockFile()
    write(file, JSON.stringify({ pid: 21, host: 'host-a', ticks: 100, bootId: 'boot-1' }))
    const successor = JSON.stringify({ pid: 31, host: 'host-a', ticks: 300, bootId: 'boot-1' })
    let calls = 0
    const racing = {
      isAlive: () => true,
      host: 'host-a',
      linuxIdentity: (pid: number): LinuxIdentity => {
        calls++
        // pid 21 is a reused pid (stale); while we look, another daemon replaces the file
        if (pid === 21) {
          writeFileSync(file, `${successor}\n`)
          return { ticks: 999, bootId: 'boot-1' }
        }
        return { ticks: 300, bootId: 'boot-1' } // pid 31 is the live daemon it says
      },
    }
    expect(await acquireDaemonLock(file, 99, racing)).toEqual({ ok: false, pid: 31 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: 31 })
    expect(calls).toBeGreaterThan(1)
  })

  it('gives up after three turns if every lock it judges stale is replaced before it can remove it', async () => {
    const file = lockFile()
    write(file, JSON.stringify({ pid: 21, host: 'host-a', ticks: 100, bootId: 'boot-1' }))
    const judged: number[] = []
    const churning = {
      isAlive: () => true,
      host: 'host-a',
      startedAt: () => T0,
      linuxIdentity: (pid: number): LinuxIdentity | null => {
        if (pid === 99) return null // our own identity, read once before the loop
        judged.push(pid)
        // every holder is a reused pid (stale), and each time another process replaces the file meanwhile
        writeFileSync(file, `${JSON.stringify({ pid: pid + 1, host: 'host-a', ticks: 100, bootId: 'boot-1' })}\n`)
        return { ticks: 999, bootId: 'boot-1' }
      },
    }
    await expect(acquireDaemonLock(file, 99, churning)).rejects.toThrow('could not take the daemon lock')
    expect(judged).toEqual([21, 22, 23])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: 24 }) // never removed someone else's lock
  })
})
