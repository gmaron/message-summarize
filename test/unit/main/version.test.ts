import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readPackageVersion, versionCommand } from '../../../src/main/version.js'

const dir = mkdtempSync(join(tmpdir(), 'msum-version-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function file(name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

function run(argv: string[], path?: string) {
  const out: string[] = []
  const err: string[] = []
  const code = versionCommand(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, path)
  return { code, out, err }
}

describe('msum --version', () => {
  it('prints the version of the real package.json', () => {
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/)
    expect(run(['--version'])).toEqual({ code: 0, out: [readPackageVersion()], err: [] })
    expect(run(['-v']).code).toBe(0)
  })

  it('prints the version of the given file', () => {
    expect(run(['--version'], file('ok.json', '{"version":"1.2.3"}')).out).toEqual(['1.2.3'])
  })

  it('leaves any other arguments to the commands', () => {
    expect(run([]).code).toBeNull()
    expect(run(['--version', 'x']).code).toBeNull()
    expect(run(['daemon']).code).toBeNull()
  })

  it.each([
    ['missing', join(dir, 'nope.json')],
    ['corrupt', file('bad.json', '{not json')],
    ['without a version', file('none.json', '{}')],
  ])('gives a short error and code 1 when package.json is %s', (_name, path) => {
    const result = run(['--version'], path)
    expect(result.code).toBe(1)
    expect(result.out).toEqual([])
    expect(result.err).toEqual(['Could not read the version from package.json.'])
  })
})
