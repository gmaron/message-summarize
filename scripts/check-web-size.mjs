// RNF-19: the JavaScript of the web must stay under 100 KB gzipped. Run after `npm run build`. It measures every .js
// file of the client build (dist/web, where Vite writes index.html and assets/), compresses each one with gzip level 9,
// prints the size per file and the total, and fails when the total is over the limit.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const LIMIT_BYTES = 100 * 1024

/** The .js files below a directory, as paths relative to it, in a stable order. */
function jsFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? jsFiles(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    )
    .filter((file) => file.endsWith('.js'))
    .sort()
}

/** Measures the gzipped JS of a build directory. Returns the size per file and the total, in bytes. */
export function measure(dir) {
  const files = jsFiles(dir).map((file) => ({
    file,
    bytes: gzipSync(readFileSync(join(dir, file)), { level: 9 }).length,
  }))
  return { files, total: files.reduce((sum, f) => sum + f.bytes, 0) }
}

/** Runs the check on a directory. Returns the exit code and the lines for stdout and stderr. */
export function check({ dir = join(root, 'dist', 'web'), limit = LIMIT_BYTES } = {}) {
  if (!existsSync(dir))
    return { code: 1, out: [], err: [`check:web-size: ${dir} does not exist; run "npm run build".`] }
  const { files, total } = measure(dir)
  if (files.length === 0) return { code: 1, out: [], err: [`check:web-size: no .js files in ${dir}.`] }
  const kb = (bytes) => (bytes / 1024).toFixed(2)
  const out = files.map((f) => `${f.file}: ${kb(f.bytes)} KB gzip`)
  out.push(`total: ${kb(total)} KB gzip (limit ${kb(limit)} KB)`)
  if (total > limit) return { code: 1, out, err: [`check:web-size: the web JS is over the limit (RNF-19).`] }
  return { code: 0, out, err: [] }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = check()
  for (const line of result.out) console.log(line)
  for (const line of result.err) console.error(line)
  process.exit(result.code)
}
