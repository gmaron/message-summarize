import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOG_FILE_NAME, LOG_ROTATED_NAME, openLogFile } from '../../../src/main/log-file.js'
import { NotARealDirectoryError } from '../../../src/main/paths.js'
import { isWindows } from '../../support/platform.js'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'msum-logs-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700)
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

const mode = (path: string) => statSync(path).mode & 0o777
const line = (n: number, size = 100) => `${String(n).padStart(4, '0')}${'x'.repeat(size - 5)}\n`

describe('the daemon log file (RNF-12)', () => {
  it('creates the directory with 0700 and the file with 0600, and appends lines', async () => {
    const dir = join(temp(), 'logs')
    const file = await openLogFile({ dir, maxBytes: 1_048_576 })
    file.write('{"a":1}\n')
    file.write('{"a":2}\n')
    await file.close()
    if (!isWindows) expect(mode(dir)).toBe(0o700)
    if (!isWindows) expect(mode(join(dir, LOG_FILE_NAME))).toBe(0o600)
    expect(readFileSync(join(dir, LOG_FILE_NAME), 'utf8')).toBe('{"a":1}\n{"a":2}\n')
  })

  it('rotates when the next line would pass half of the maximum, replacing the old .1', async () => {
    const dir = temp()
    const maxBytes = 2_000
    const file = await openLogFile({ dir, maxBytes })
    // 10 lines of 100 bytes fill the half (1000) exactly; the 11th rotates.
    for (let n = 1; n <= 10; n++) file.write(line(n))
    await file.flush()
    expect(readdirSync(dir)).toEqual([LOG_FILE_NAME])
    file.write(line(11))
    await file.flush()
    expect(readFileSync(join(dir, LOG_ROTATED_NAME), 'utf8')).toBe(
      Array.from({ length: 10 }, (_, i) => line(i + 1)).join(''),
    )
    expect(readFileSync(join(dir, LOG_FILE_NAME), 'utf8')).toBe(line(11))
    // a second rotation replaces .1 with what the current file held
    for (let n = 12; n <= 21; n++) file.write(line(n))
    await file.close()
    expect(readFileSync(join(dir, LOG_ROTATED_NAME), 'utf8').startsWith('0011')).toBe(true)
    expect(readFileSync(join(dir, LOG_FILE_NAME), 'utf8')).toBe(line(21))
    if (!isWindows) expect(mode(join(dir, LOG_ROTATED_NAME))).toBe(0o600)
  })

  it('never takes more than the maximum, however much is written (one burst, no awaiting)', async () => {
    const dir = temp()
    const maxBytes = 5_000
    const file = await openLogFile({ dir, maxBytes })
    for (let n = 0; n < 500; n++) file.write(line(n, 90))
    await file.close()
    const total = readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
    expect(total).toBeLessThanOrEqual(maxBytes)
    expect(readdirSync(dir).sort()).toEqual([LOG_FILE_NAME, LOG_ROTATED_NAME])
    // the newest line is the last one of the current file
    expect(readFileSync(join(dir, LOG_FILE_NAME), 'utf8').endsWith(line(499, 90))).toBe(true)
  })

  it('continues the size of a file that already exists and closes a line cut by a crash', async () => {
    const dir = temp()
    writeFileSync(join(dir, LOG_FILE_NAME), `${line(1)}{"half":`, { mode: 0o644 })
    const file = await openLogFile({ dir, maxBytes: 1_000_000 })
    file.write(line(2))
    await file.close()
    expect(readFileSync(join(dir, LOG_FILE_NAME), 'utf8')).toBe(`${line(1)}{"half":\n${line(2)}`)
    if (!isWindows) expect(mode(join(dir, LOG_FILE_NAME))).toBe(0o600)

    // and the existing size counts: this one rotates at once
    const big = temp()
    writeFileSync(join(big, LOG_FILE_NAME), line(1, 450), { mode: 0o600 })
    const second = await openLogFile({ dir: big, maxBytes: 1_000 })
    second.write(line(2, 100))
    await second.close()
    expect(readFileSync(join(big, LOG_ROTATED_NAME), 'utf8')).toBe(line(1, 450))
    expect(readFileSync(join(big, LOG_FILE_NAME), 'utf8')).toBe(line(2, 100))
  })

  // chmod 0400 and a mode 000 file are POSIX-only ways to make a file unwritable or unreadable.
  it.skipIf(isWindows)(
    'does not throw when the directory cannot be written: it counts the lost lines and recovers',
    async () => {
      const root = temp()
      const dir = join(root, 'logs')
      const file = await openLogFile({ dir, maxBytes: 1_048_576 })
      file.write('one\n')
      await file.flush()
      // the file cannot be written to (a full disk or a permissions problem fail the same way)
      const path = join(dir, LOG_FILE_NAME)
      chmodSync(path, 0o400)
      const canFail = process.getuid?.() !== 0
      expect(() => {
        file.write('two\n')
        file.write('three\n')
      }).not.toThrow()
      await expect(file.flush()).resolves.toBeUndefined()
      expect(file.lost).toBe(canFail ? 2 : 0)
      chmodSync(path, 0o600)
      file.write('four\n')
      await file.close()
      const text = readFileSync(path, 'utf8')
      expect(text.startsWith('one\n')).toBe(true)
      expect(text.endsWith('four\n')).toBe(true)
      if (canFail) expect(text).not.toContain('two')
    },
  )

  it('refuses a path that is a file where the directory should be', async () => {
    const root = temp()
    writeFileSync(join(root, 'logs'), 'a file where the directory should be')
    await expect(openLogFile({ dir: join(root, 'logs'), maxBytes: 1_048_576 })).rejects.toBeInstanceOf(
      NotARealDirectoryError,
    )
  })

  it('recreates the directory if it was removed while running', async () => {
    const dir = join(temp(), 'logs')
    const file = await openLogFile({ dir, maxBytes: 1_048_576 })
    file.write('one\n')
    await file.flush()
    rmSync(dir, { recursive: true })
    file.write('two\n')
    await file.close()
    expect(readFileSync(join(dir, LOG_FILE_NAME), 'utf8')).toBe('two\n')
    if (!isWindows) expect(mode(dir)).toBe(0o700)
    mkdirSync(dir, { recursive: true })
  })

  it('ignores lines written after close', async () => {
    const dir = temp()
    const file = await openLogFile({ dir, maxBytes: 1_048_576 })
    await file.close()
    file.write('late\n')
    await file.flush()
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('the log file and links', () => {
  it('refuses a logs directory that is a link, and touches nothing behind it', async () => {
    const root = temp()
    const target = join(root, 'elsewhere')
    mkdirSync(target, { mode: 0o755 })
    chmodSync(target, 0o755)
    symlinkSync(target, join(root, 'logs'))
    await expect(openLogFile({ dir: join(root, 'logs'), maxBytes: 1_048_576 })).rejects.toBeInstanceOf(
      NotARealDirectoryError,
    )
    expect(readdirSync(target)).toEqual([])
    if (!isWindows) expect(mode(target)).toBe(0o755)
  })

  it('refuses a daemon.log that is a link, and never writes or tightens the file it points to', async () => {
    const dir = temp()
    const victim = join(temp(), 'victim.txt')
    writeFileSync(victim, 'precious\n', { mode: 0o644 })
    chmodSync(victim, 0o644)
    symlinkSync(victim, join(dir, LOG_FILE_NAME))
    await expect(openLogFile({ dir, maxBytes: 1_048_576 })).rejects.toBeInstanceOf(NotARealDirectoryError)
    expect(readFileSync(victim, 'utf8')).toBe('precious\n')
    if (!isWindows) expect(mode(victim)).toBe(0o644)
  })

  it('does not follow a link that replaces daemon.log while running: the line is lost, the target is untouched', async () => {
    const dir = temp()
    const victim = join(temp(), 'victim.txt')
    writeFileSync(victim, 'precious\n', { mode: 0o644 })
    chmodSync(victim, 0o644)
    const file = await openLogFile({ dir, maxBytes: 1_048_576 })
    file.write('one\n')
    await file.flush()
    rmSync(join(dir, LOG_FILE_NAME))
    symlinkSync(victim, join(dir, LOG_FILE_NAME))
    file.write('two\n')
    await file.flush()
    expect(file.lost).toBe(1)
    expect(readFileSync(victim, 'utf8')).toBe('precious\n')
    if (!isWindows) expect(mode(victim)).toBe(0o644)
    await file.close()
  })
})

describe('the queue and close', () => {
  it('drops and counts what does not fit in the queue while the disk is busy', async () => {
    const dir = temp()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const file = await openLogFile({ dir, maxBytes: 1_048_576, maxQueueBytes: 300, beforeWrite: () => gate })
    for (let n = 1; n <= 10; n++) file.write(line(n))
    const flushing = file.flush()
    // the batch is in flight: it still counts against the queue
    file.write(line(11))
    expect(file.lost).toBe(8)
    release()
    await flushing
    file.write(line(12))
    await file.close()
    expect(file.lost).toBe(8)
    expect(readFileSync(join(dir, LOG_FILE_NAME), 'utf8')).toBe(`${line(1)}${line(2)}${line(3)}${line(12)}`)
  })

  it('close() gives up after its budget when the disk does not answer, and ignores later writes', async () => {
    const dir = temp()
    const file = await openLogFile({
      dir,
      maxBytes: 1_048_576,
      closeTimeoutMs: 80,
      beforeWrite: () => new Promise<void>(() => undefined),
    })
    file.write('stuck\n')
    const started = Date.now()
    await file.close()
    expect(Date.now() - started).toBeLessThan(1_000)
    file.write('late\n')
    expect(file.lost).toBe(0)
  })
})

describe('rotation failures and the starting size', () => {
  it('keeps the size when the rename fails: lines are dropped, never past the half, and it retries', async () => {
    const dir = temp()
    const file = await openLogFile({ dir, maxBytes: 2_000 })
    for (let n = 1; n <= 10; n++) file.write(line(n))
    await file.flush()
    // a non-empty directory where daemon.log.1 goes: renaming onto it fails
    mkdirSync(join(dir, LOG_ROTATED_NAME))
    writeFileSync(join(dir, LOG_ROTATED_NAME, 'x'), 'x')
    file.write(line(11))
    await file.flush()
    file.write(line(12))
    await file.flush()
    expect(file.lost).toBe(2)
    expect(statSync(join(dir, LOG_FILE_NAME)).size).toBe(1_000)
    rmSync(join(dir, LOG_ROTATED_NAME), { recursive: true })
    file.write(line(13))
    await file.close()
    expect(statSync(join(dir, LOG_ROTATED_NAME)).size).toBe(1_000)
    expect(readFileSync(join(dir, LOG_FILE_NAME), 'utf8')).toBe(line(13))
  })

  it.skipIf(isWindows)(
    'uses the size of the file when its last byte cannot be read, and closes the possible half line',
    async () => {
      if (process.getuid?.() === 0) return
      const dir = temp()
      writeFileSync(join(dir, LOG_FILE_NAME), line(1, 450), { mode: 0o000 })
      chmodSync(join(dir, LOG_FILE_NAME), 0o000)
      const file = await openLogFile({ dir, maxBytes: 1_000 })
      // 450 + 100 passes the half (500): it rotates although the file could not be read
      file.write(line(2))
      await file.close()
      chmodSync(join(dir, LOG_ROTATED_NAME), 0o600)
      expect(statSync(join(dir, LOG_ROTATED_NAME)).size).toBe(450)
      expect(readFileSync(join(dir, LOG_FILE_NAME), 'utf8')).toBe(line(2))
    },
  )
})
