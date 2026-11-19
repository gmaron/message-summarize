import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript module of the repository scripts
import { check, LIMIT_BYTES, measure } from '../../../scripts/check-web-size.mjs'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A build directory with the given files (paths relative to it). */
function build(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'msum-websize-'))
  dirs.push(dir)
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  return dir
}

describe('check-web-size', () => {
  it('passes under the limit, counting only JavaScript, per file and in total', () => {
    const dir = build({
      'index.html': 'x'.repeat(500_000),
      'assets/style.css': 'x'.repeat(500_000),
      'assets/a.js': 'console.log(1)\n'.repeat(1000),
      'assets/b.js': 'console.log(2)\n'.repeat(1000),
    })
    const { files, total } = measure(dir)
    expect(files.map((f: { file: string }) => f.file)).toEqual(['assets/a.js', 'assets/b.js'])
    expect(total).toBe(files[0].bytes + files[1].bytes)
    const result = check({ dir })
    expect(result.code).toBe(0)
    expect(result.out).toHaveLength(3)
    expect(result.out.at(-1)).toContain('total:')
  })

  it('fails when the gzipped total is over the limit', () => {
    // Random bytes do not compress, so the gzip size is about the raw size.
    const dir = build({ 'assets/big.js': randomBytes(LIMIT_BYTES + 1000) })
    const result = check({ dir })
    expect(result.code).toBe(1)
    expect(result.err[0]).toContain('RNF-19')
  })

  it('fails when the build is missing or has no JavaScript', () => {
    expect(check({ dir: join(tmpdir(), 'msum-websize-missing') }).code).toBe(1)
    expect(check({ dir: build({ 'index.html': '<html></html>' }) }).code).toBe(1)
  })
})
