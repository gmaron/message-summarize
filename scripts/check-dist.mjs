// Fails when the build output a package needs is missing or stale. Runs after `npm run build` in `prepack`.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const problems = []

for (const path of ['dist/main/cli.js', 'dist/web/index.html']) {
  if (!existsSync(new URL(path, root))) problems.push(`missing ${path}`)
}

if (existsSync(new URL('dist/main/cli.js', root))) {
  const first = readFileSync(new URL('dist/main/cli.js', root), 'utf8').split('\n', 1)[0]
  if (first !== '#!/usr/bin/env node') problems.push('dist/main/cli.js lost its shebang')
}

/** Files below a directory, as paths relative to it. */
function walk(dir, prefix = '') {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  )
}

// A compiled file with no source is left over from a file that was renamed or removed.
const dist = join(root.pathname, 'dist')
const src = join(root.pathname, 'src')
for (const file of walk(dist)) {
  if (file.startsWith('web/') || !file.endsWith('.js')) continue
  if (!existsSync(join(src, file.replace(/\.js$/, '.ts'))))
    problems.push(`stale dist/${file} has no src/${file.replace(/\.js$/, '.ts')}`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check:dist: ${problem}`)
  console.error('check:dist: run "npm run build" (it cleans dist first).')
  process.exit(1)
}
