// Keeps the code and the spec in step (docs/requirements.md §8). It reads the requirement IDs of the spec (the first
// cell of each table row, RF-xx or RNF-xx) and every ID cited in src/ and test/, then:
// - fails when the code or the tests cite an ID that is not in the spec (a typo, or a row that was never written);
// - lists, without failing, the RF rows of priority v1 that no test cites.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const ID = /\b(?:RF|RNF)-\d+\b/g
const ROW = /^\|\s*((?:RF|RNF)-\d+)\s*\|[^|]*\|\s*([^|]*?)\s*\|/
const SOURCE = /\.(?:ts|mts|mjs|js|svelte)$/

/** The IDs of the spec, with the priority of each RF row (`v1`, `Luego`); RNF rows have none. */
export function specIds(markdown) {
  const ids = new Map()
  for (const line of markdown.split('\n')) {
    const match = ROW.exec(line)
    if (match) ids.set(match[1], match[1].startsWith('RF-') ? match[2] : null)
  }
  return ids
}

/** Every source file below a directory, as absolute paths, in a stable order. */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) return []
      const path = join(dir, entry.name)
      return entry.isDirectory() ? sourceFiles(path) : SOURCE.test(entry.name) ? [path] : []
    })
    .sort()
}

/** The IDs cited in each file: Map of ID to the files (relative to `base`, with `/` on every OS) that cite it. */
export function citedIds(files, base, read = (file) => readFileSync(file, 'utf8')) {
  const cited = new Map()
  for (const file of files) {
    for (const id of new Set(read(file).match(ID) ?? [])) {
      const where = cited.get(id) ?? []
      where.push(relative(base, file).split(sep).join('/'))
      cited.set(id, where)
    }
  }
  return cited
}

/** Runs the check. Returns the exit code and the lines for stdout and stderr. */
export function check({
  spec = readFileSync(join(root, 'docs', 'requirements.md'), 'utf8'),
  srcFiles = sourceFiles(join(root, 'src')),
  testFiles = sourceFiles(join(root, 'test')),
  base = root,
  read,
} = {}) {
  const ids = specIds(spec)
  if (ids.size === 0) return { code: 1, out: [], err: ['check:spec: no requirement rows found in the spec.'] }
  const inSrc = citedIds(srcFiles, base, read)
  const inTest = citedIds(testFiles, base, read)
  const unknown = [...new Set([...inSrc.keys(), ...inTest.keys()])]
    .filter((id) => !ids.has(id))
    .sort()
    .map((id) => `${id} (${[...(inSrc.get(id) ?? []), ...(inTest.get(id) ?? [])].join(', ')})`)
  const untested = [...ids].filter(([id, priority]) => priority === 'v1' && !inTest.has(id)).map(([id]) => id)
  const out = [`check:spec: ${ids.size} requirements in the spec, ${inTest.size} cited in test/.`]
  if (untested.length > 0) out.push(`v1 requirements no test cites: ${untested.join(', ')}`)
  if (unknown.length > 0)
    return {
      code: 1,
      out,
      err: ['check:spec: IDs cited in the code that are not in docs/requirements.md:', ...unknown],
    }
  return { code: 0, out, err: [] }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = check()
  for (const line of result.out) console.log(line)
  for (const line of result.err) console.error(line)
  process.exit(result.code)
}
