// RNF-18: walks the production dependency tree (node_modules, as installed) and fails on any license outside the
// allowlist that is not a named exception in scripts/license-exceptions.json. Exceptions are reported, never hidden.
// A dependency that is listed but not installed fails too (only optionalDependencies may be absent).
//
// --strict rejects the exceptions as well. `prepublishOnly` runs it, so an accidental `npm publish` is blocked while
// libsignal (GPL-3.0, from Baileys) is still undecided. It is not part of `prepack`: packing, the Docker image and the
// executables must keep working. Remove the exception, and this block, once the libsignal decision is made.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'Python-2.0',
  'CC0-1.0',
  'Unlicense',
  'CC-BY-4.0',
  'Zlib',
])

/** True when the SPDX expression is covered: every AND operand, and at least one OR operand, is allowed. */
export function isAllowed(expression, allowed = ALLOWED) {
  const text = expression.trim()
  const orParts = splitTop(text, ' OR ')
  if (orParts.length > 1) return orParts.some((part) => isAllowed(part, allowed))
  const andParts = splitTop(text, ' AND ')
  if (andParts.length > 1) return andParts.every((part) => isAllowed(part, allowed))
  if (text.startsWith('(') && text.endsWith(')')) return isAllowed(text.slice(1, -1), allowed)
  return allowed.has(text)
}

/** Splits on a separator that is not inside parentheses. */
function splitTop(text, separator) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') depth--
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i))
      start = i + separator.length
      i += separator.length - 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) {
    const names = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter((n) => typeof n === 'string')
    if (names.length > 0) return names.join(' OR ')
  }
  return 'UNKNOWN'
}

/** Finds `name` the way node does: in node_modules directories, from `fromDir` up to the root. */
function locate(name, fromDir, top) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === top || dir === dirname(dir)) return null
  }
}

/**
 * Every production package reachable from the root package.json, by directory (so duplicates are visited once), and the
 * required dependencies that are not installed.
 */
export function productionPackages(dir = root) {
  const rootPkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const seen = new Map()
  const missing = []
  const queue = Object.keys(rootPkg.dependencies ?? {}).map((name) => ({ name, from: dir, optional: false }))
  while (queue.length > 0) {
    const { name, from, optional } = queue.pop()
    const found = locate(name, from, dir)
    if (found === null) {
      if (!optional) missing.push(name)
      continue
    }
    if (seen.has(found)) continue
    const pkg = JSON.parse(readFileSync(join(found, 'package.json'), 'utf8'))
    seen.set(found, { name: pkg.name ?? name, version: pkg.version ?? '0.0.0', license: licenseOf(pkg) })
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: found, optional: false })
    for (const dep of Object.keys(pkg.optionalDependencies ?? {}))
      queue.push({ name: dep, from: found, optional: true })
  }
  const packages = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  return { packages, missing: [...new Set(missing)].sort() }
}

/** Runs the check on a tree. Returns the exit code and the lines for stdout and stderr. */
export function check({ dir = root, exceptions, strict = false }) {
  const { packages, missing } = productionPackages(dir)
  const out = []
  const err = []
  const excepted = []
  const failures = []
  for (const pkg of packages) {
    if (isAllowed(pkg.license)) continue
    const exception = exceptions[pkg.name]
    if (!strict && exception && exception.license === pkg.license) excepted.push({ ...pkg, reason: exception.reason })
    else failures.push(pkg)
  }
  out.push(`check:licenses: ${packages.length} production packages checked${strict ? ' (strict)' : ''}.`)
  for (const pkg of excepted) out.push(`  EXCEPTION ${pkg.name}@${pkg.version} (${pkg.license}): ${pkg.reason}`)
  for (const pkg of failures) err.push(`  NOT ALLOWED ${pkg.name}@${pkg.version}: ${pkg.license}`)
  for (const name of missing) err.push(`  NOT INSTALLED ${name}: run "npm ci" first`)
  const failed = failures.length > 0 || missing.length > 0
  if (failed) err.push('check:licenses: failed. Review the license, then allow it or add a named exception.')
  return { code: failed ? 1 : 0, out, err }
}

function main() {
  const exceptions = JSON.parse(readFileSync(join(root, 'scripts', 'license-exceptions.json'), 'utf8'))
  const result = check({ exceptions, strict: process.argv.includes('--strict') })
  for (const line of result.out) console.log(line)
  for (const line of result.err) console.error(line)
  process.exit(result.code)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
