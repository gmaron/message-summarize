import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertSingleLine, firstLine, nodeFiles, nodeRunner } from '../../../src/infrastructure/service/host.js'
import { allowSubprocess } from '../../support/network-guard.js'
import { isWindows } from '../../support/platform.js'

// The real runner is exercised with this very node (never with a service manager) and the real files in a temp dir.

const dirs: string[] = []
const revoke: Array<() => void> = []
beforeEach(() => {
  // Only this node (running a one-line script) and a path that does not exist: no service manager.
  const missing = join(tmpdir(), 'msum-service-nothing-here')
  revoke.push(allowSubprocess(process.execPath), allowSubprocess(missing))
})
afterEach(() => {
  for (const undo of revoke.splice(0)) undo()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'msum-service-'))
  dirs.push(dir)
  return dir
}

describe('nodeRunner', () => {
  it('returns what a program printed and its exit code', async () => {
    const ok = await nodeRunner.run(process.execPath, ['-e', 'process.stdout.write("hi")'])
    expect(ok).toEqual({ code: 0, stdout: 'hi', stderr: '' })
    const failed = await nodeRunner.run(process.execPath, ['-e', 'console.error("bad"); process.exit(3)'])
    expect(failed.code).toBe(3)
    expect(failed.stderr).toContain('bad')
  })

  it('never rejects: a program that is not there has no exit code', async () => {
    const missing = await nodeRunner.run(join(tmpdir(), 'msum-service-nothing-here'), [])
    expect(missing.code).toBeNull()
    expect(missing.stderr).not.toBe('')
  })
})

describe('nodeFiles', () => {
  it('writes (creating the directory), reads and removes', async () => {
    const path = join(temp(), 'a', 'b', 'file.txt')
    expect(await nodeFiles.read(path)).toBeNull()
    await nodeFiles.write(path, 'text', 0o600)
    expect(await nodeFiles.read(path)).toBe('text')
    expect(readFileSync(path, 'utf8')).toBe('text')
    expect(await nodeFiles.remove(path)).toBe(true)
    expect(await nodeFiles.remove(path)).toBe(false)
  })

  it('creates the missing directories private (0700)', async () => {
    const root = temp()
    await nodeFiles.write(join(root, 'x', 'f'), 't', 0o600)
    if (!isWindows) expect(statSync(join(root, 'x')).mode & 0o777).toBe(0o700)
  })

  it('ensureDir creates a private directory and leaves an existing one alone', async () => {
    const path = join(temp(), 'logs')
    await nodeFiles.ensureDir(path)
    await nodeFiles.ensureDir(path)
    if (!isWindows) expect(statSync(path).mode & 0o777).toBe(0o700)
  })

  it('does not hide an error other than a missing file', async () => {
    const root = temp()
    mkdirSync(join(root, 'dir'))
    await expect(nodeFiles.read(join(root, 'dir'))).rejects.toThrow()
    writeFileSync(join(root, 'plain'), '')
    await expect(nodeFiles.remove(join(root, 'plain', 'inside'))).rejects.toThrow()
  })
})

describe('helpers', () => {
  it('firstLine prefers stderr, skips blank lines and falls back to the exit code', () => {
    expect(firstLine({ code: 1, stdout: 'out', stderr: '\n  err one \nerr two' })).toBe('err one')
    expect(firstLine({ code: 1, stdout: '\nout\n', stderr: '' })).toBe('out')
    expect(firstLine({ code: 7, stdout: '', stderr: '' })).toBe('exit code 7')
    expect(firstLine({ code: null, stdout: '', stderr: '' })).toBe('exit code none')
  })

  it('assertSingleLine accepts a path and refuses line breaks and NUL', () => {
    expect(() => assertSingleLine('/a b/c')).not.toThrow()
    for (const bad of ['a\nb', 'a\rb', 'a\0b']) expect(() => assertSingleLine(bad)).toThrow('line break')
  })
})
