import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript module of the repository scripts
import { isAllowed } from '../../../scripts/check-licenses.mjs'

const root = join(import.meta.dirname, '..', '..', '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  private?: boolean
  files: string[]
  bin: Record<string, string>
  scripts: Record<string, string>
  dependencies: Record<string, string>
}

describe('the package contents', () => {
  it('is publishable and allowlists only what the runtime needs', () => {
    expect(pkg.private).toBeUndefined()
    // The allowlist is the whole guard: tests, docs, src, .sandbox, .env, *.db and auth/ are not in it, and npm never
    // packs them unless a `files` entry reaches them.
    expect([...pkg.files].sort()).toEqual([
      'LICENSE',
      'README.es.md',
      'README.md',
      'THIRD_PARTY_NOTICES.md',
      'dist',
      'vendor/sharp-stub',
    ])
  })

  it('exposes both commands from the compiled entry, which keeps its shebang', () => {
    expect(pkg.bin).toEqual({ msum: 'dist/main/cli.js', 'message-summarize': 'dist/main/cli.js' })
    expect(readFileSync(join(root, 'src/main/cli.ts'), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true)
  })

  it('builds before packing and has no install scripts of its own', () => {
    expect(pkg.scripts.prepack).toContain('npm run build')
    expect(pkg.scripts.build).toContain('rmSync')
    expect(pkg.scripts.prepublishOnly).toBe('node scripts/check-licenses.mjs --strict')
    expect(pkg.scripts.prepack).not.toContain('licenses')
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) expect(pkg.scripts[hook]).toBeUndefined()
  })

  it('keeps native sharp out through an empty stand-in', () => {
    expect(pkg.dependencies.sharp).toBe('file:vendor/sharp-stub')
    const stub = JSON.parse(readFileSync(join(root, 'vendor/sharp-stub/package.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(stub.name).toBe('sharp')
    expect(stub.scripts).toBeUndefined()
    expect(stub.dependencies).toBeUndefined()
  })

  it('has the web next to the compiled code, where the daemon looks for it', () => {
    expect(readFileSync(join(root, 'vite.web.config.ts'), 'utf8')).toContain("'./dist/web'")
    expect(readFileSync(join(root, 'tsconfig.build.json'), 'utf8')).toContain('"outDir": "dist"')
    expect(readFileSync(join(root, 'src/main/web/server.ts'), 'utf8')).toContain(
      "new URL('../../web/', import.meta.url)",
    )
  })
})

describe('license expressions (RNF-18)', () => {
  it('accepts an allowed license, an OR with one allowed side and an AND with both', () => {
    expect(isAllowed('MIT')).toBe(true)
    expect(isAllowed('(MIT OR GPL-3.0)')).toBe(true)
    expect(isAllowed('(MIT AND BSD-3-Clause)')).toBe(true)
  })

  it('rejects anything outside the allowlist', () => {
    expect(isAllowed('GPL-3.0')).toBe(false)
    expect(isAllowed('(MIT AND GPL-3.0)')).toBe(false)
    expect(isAllowed('UNKNOWN')).toBe(false)
  })
})
