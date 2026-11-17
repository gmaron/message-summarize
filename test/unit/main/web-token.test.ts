import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureWebToken } from '../../../src/main/web-token.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const layout = () => {
  const dir = mkdtempSync(join(tmpdir(), 'msum-token-'))
  dirs.push(dir)
  return { webTokenFile: join(dir, 'web-token') }
}

describe('ensureWebToken (RNF-03, RNF-04)', () => {
  it('creates 32 random bytes in base64url with mode 0600, and reuses them', async () => {
    const files = layout()
    const token = await ensureWebToken(files)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(readFileSync(files.webTokenFile, 'utf8')).toBe(`${token}\n`)
    if (process.platform !== 'win32') expect(statSync(files.webTokenFile).mode & 0o777).toBe(0o600)
    expect(await ensureWebToken(files)).toBe(token)
  })

  it('two installations get different tokens', async () => {
    expect(await ensureWebToken(layout())).not.toBe(await ensureWebToken(layout()))
  })

  it('tightens the mode of a token file that was looser', async () => {
    const files = layout()
    const token = await ensureWebToken(files)
    if (process.platform === 'win32') return
    const { chmodSync } = await import('node:fs')
    chmodSync(files.webTokenFile, 0o644)
    expect(await ensureWebToken(files)).toBe(token)
    expect(statSync(files.webTokenFile).mode & 0o777).toBe(0o600)
  })

  it('replaces a file that holds anything else', async () => {
    const files = layout()
    writeFileSync(files.webTokenFile, 'not a token')
    const token = await ensureWebToken(files)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(readFileSync(files.webTokenFile, 'utf8')).toBe(`${token}\n`)
    if (process.platform !== 'win32') expect(statSync(files.webTokenFile).mode & 0o777).toBe(0o600)
  })

  it('concurrent callers agree on one token', async () => {
    const files = layout()
    const tokens = await Promise.all(Array.from({ length: 8 }, () => ensureWebToken(files)))
    expect(new Set(tokens).size).toBe(1)
  })
})
