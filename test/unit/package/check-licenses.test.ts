import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript module of the repository scripts
import { check, notices, productionPackages, renderNotices, repositoryOf } from '../../../scripts/check-licenses.mjs'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A tiny project: the root depends on `deps`, and `installed` are the packages in node_modules. */
function tree(deps: string[], installed: Record<string, Record<string, unknown>>, optional: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'msum-licenses-'))
  dirs.push(dir)
  const dependencies = Object.fromEntries(deps.map((name) => [name, '1.0.0']))
  const optionalDependencies = Object.fromEntries(optional.map((name) => [name, '1.0.0']))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', dependencies }))
  for (const [name, pkg] of Object.entries(installed)) {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true })
    const body = name === deps[0] && optional.length > 0 ? { ...pkg, optionalDependencies } : pkg
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, ...body }))
  }
  return dir
}

const exceptions = { gpl: { license: 'GPL-3.0', reason: 'decided later' } }

describe('check-licenses', () => {
  it('passes with allowed licenses, whatever shape the field has', () => {
    const dir = tree(['a', 'b', 'c'], {
      a: { version: '1.0.0', license: 'MIT' },
      b: { version: '1.0.0', licenses: ['ISC'] },
      c: { version: '1.0.0', licenses: [{ type: 'Apache-2.0' }] },
    })
    const result = check({ dir, exceptions })
    expect(result.code).toBe(0)
    expect(result.out[0]).toContain('3 production packages')
  })

  it('reports a named exception and still passes, but strict rejects it (exit code 1)', () => {
    const dir = tree(['gpl'], { gpl: { version: '1.0.0', license: 'GPL-3.0' } })
    const loose = check({ dir, exceptions })
    expect(loose.code).toBe(0)
    expect(loose.out.join('\n')).toContain('EXCEPTION gpl@1.0.0 (GPL-3.0): decided later')
    const strict = check({ dir, exceptions, strict: true })
    expect(strict.code).toBe(1)
    expect(strict.err.join('\n')).toContain('NOT ALLOWED gpl@1.0.0')
  })

  it('fails on a license outside the allowlist, and on an exception that names another license', () => {
    expect(check({ dir: tree(['x'], { x: { version: '1.0.0', license: 'AGPL-3.0' } }), exceptions }).code).toBe(1)
    expect(check({ dir: tree(['gpl'], { gpl: { version: '1.0.0', license: 'GPL-2.0' } }), exceptions }).code).toBe(1)
    expect(check({ dir: tree(['n'], { n: { version: '1.0.0' } }), exceptions }).err.join('\n')).toContain('UNKNOWN')
  })

  it('fails when a listed dependency is not installed, but not an optional one', () => {
    const missing = check({ dir: tree(['a', 'gone'], { a: { version: '1.0.0', license: 'MIT' } }), exceptions })
    expect(missing.code).toBe(1)
    expect(missing.err.join('\n')).toContain('NOT INSTALLED gone')
    const optional = tree(['a'], { a: { version: '1.0.0', license: 'MIT' } }, ['native-only'])
    expect(check({ dir: optional, exceptions }).code).toBe(0)
  })

  it('walks transitive dependencies and copes with a missing version', () => {
    const dir = tree(['a'], { a: { license: 'MIT', dependencies: { b: '1.0.0' } }, b: { license: 'WTFPL' } })
    expect(productionPackages(dir).packages.map((p: { name: string }) => p.name)).toEqual(['a', 'b'])
    expect(check({ dir, exceptions }).code).toBe(1)
  })
})

describe('third-party notices', () => {
  const installed = {
    zeta: { version: '2.0.0', license: 'MIT', repository: 'git+https://github.com/o/zeta.git' },
    alpha: { version: '1.0.0', license: 'ISC', repository: { url: 'git://github.com/o/alpha.git' } },
    gpl: { version: '3.0.0', license: 'GPL-3.0', repository: 'o/gpl' },
  }

  it('normalizes the repository field to a browsable URL, or nothing', () => {
    expect(repositoryOf({ repository: 'git+https://github.com/o/r.git' })).toBe('https://github.com/o/r')
    expect(repositoryOf({ repository: { url: 'git@github.com:o/r.git' } })).toBe('https://github.com/o/r')
    expect(repositoryOf({ repository: 'o/r' })).toBe('https://github.com/o/r')
    expect(repositoryOf({ homepage: 'https://example.test/x' })).toBe('https://example.test/x')
    expect(repositoryOf({ repository: { url: 'file:../x' } })).toBe('')
    expect(repositoryOf({})).toBe('')
  })

  it('renders a stable list sorted by name and marks the exception with its reason', () => {
    const dir = tree(['zeta', 'alpha', 'gpl'], installed)
    const { packages } = productionPackages(dir)
    const text = renderNotices({ packages, exceptions })
    expect(text).toBe(
      renderNotices({ packages: [...packages].reverse().sort((a, b) => a.name.localeCompare(b.name)), exceptions }),
    )
    expect(text.indexOf('| alpha |')).toBeLessThan(text.indexOf('| gpl |'))
    expect(text.indexOf('| gpl |')).toBeLessThan(text.indexOf('| zeta |'))
    expect(text).toContain('- **gpl@3.0.0** (GPL-3.0): decided later')
    expect(text).toContain('| gpl | 3.0.0 | GPL-3.0 (exception, see above) | https://github.com/o/gpl |')
    expect(text).toContain('| zeta | 2.0.0 | MIT | https://github.com/o/zeta |')
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('writes the file, and check passes until the tree changes', () => {
    const dir = tree(['zeta', 'alpha', 'gpl'], installed)
    expect(notices({ dir, exceptions, check: true }).err.join('\n')).toContain('missing')
    expect(notices({ dir, exceptions }).code).toBe(0)
    expect(readFileSync(join(dir, 'THIRD_PARTY_NOTICES.md'), 'utf8')).toContain('| alpha | 1.0.0 | ISC |')
    expect(notices({ dir, exceptions, check: true }).code).toBe(0)
    writeFileSync(
      join(dir, 'node_modules', 'zeta', 'package.json'),
      JSON.stringify({ name: 'zeta', version: '2.1.0', license: 'MIT' }),
    )
    const stale = notices({ dir, exceptions, check: true })
    expect(stale.code).toBe(1)
    expect(stale.err.join('\n')).toContain('out of date')
  })

  it('refuses to write when a dependency is not installed', () => {
    const result = notices({ dir: tree(['gone'], {}), exceptions })
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('NOT INSTALLED gone')
  })
})
