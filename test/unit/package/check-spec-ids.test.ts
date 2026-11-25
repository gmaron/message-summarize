import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript module of the repository scripts
import { check, citedIds, specIds } from '../../../scripts/check-spec-ids.mjs'

// The IDs are built at run time: written out here, this file would cite them and the real check would read them.
const rf = (n: number): string => ['RF', String(n)].join('-')
const rnf = (n: number): string => ['RNF', String(n)].join('-')

const SPEC = [
  '| ID | Requerimiento | Prioridad | Criterio de aceptación |',
  '|---|---|---|---|',
  `| ${rf(1)} | Vincular | v1 | El QR aparece |`,
  `| ${rf(2)} | Otra plataforma | Luego | Se suma un adaptador |`,
  `| ${rf(3)} | Resumir | v1 | Sale el digest |`,
  '',
  '| ID | Atributo | Requerimiento | Métrica |',
  '|---|---|---|---|',
  `| ${rnf(1)} | Privacidad | Sin telemetría | Test de red |`,
  '',
  `Texto que nombra ${rf(9)} fuera de una tabla no es una fila.`,
].join('\n')

/** Runs the check over files given as path → content. */
function run(files: Record<string, string>, spec = SPEC) {
  const paths = Object.keys(files)
  return check({
    spec,
    srcFiles: paths.filter((p) => p.startsWith('src/')),
    testFiles: paths.filter((p) => p.startsWith('test/')),
    base: '',
    read: (path: string) => files[path] ?? '',
  })
}

describe('check-spec-ids (requirements §8)', () => {
  it('reads the IDs of the table rows only, with the priority of each RF row', () => {
    const ids = specIds(SPEC)
    expect([...ids]).toEqual([
      [rf(1), 'v1'],
      [rf(2), 'Luego'],
      [rf(3), 'v1'],
      [rnf(1), null],
    ])
  })

  it('maps each cited ID to the files that cite it, once per file', () => {
    const cited = citedIds(['a.ts', 'b.ts'], '', (p: string) => (p === 'a.ts' ? `${rf(1)} ${rf(1)}` : rf(1)))
    expect(cited.get(rf(1))).toEqual(['a.ts', 'b.ts'])
  })

  it('passes when every cited ID is in the spec, and lists the v1 rows no test cites', () => {
    const result = run({ 'src/a.ts': `// ${rf(3)}`, 'test/a.test.ts': `describe('x (${rf(1)}, ${rnf(1)})')` })
    expect(result.code).toBe(0)
    expect(result.out).toContain(`v1 requirements no test cites: ${rf(3)}`)
    expect(result.err).toEqual([])
  })

  it('fails on an ID that is not in the spec, naming the files that cite it', () => {
    const result = run({ 'src/a.ts': `// ${rf(42)}`, 'test/a.test.ts': `${rf(1)} ${rf(3)} ${rf(42)}` })
    expect(result.code).toBe(1)
    expect(result.err.at(-1)).toBe(`${rf(42)} (src/a.ts, test/a.test.ts)`)
  })

  it('fails when the spec has no requirement rows', () => {
    expect(run({}, '# nada').code).toBe(1)
  })

  it('passes on the real repository', () => {
    const result = check()
    expect(result.err).toEqual([])
    expect(result.code).toBe(0)
  })
})
