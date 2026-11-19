// RNF-18: walks the production dependency tree (node_modules, as installed) and fails on any license outside the
// allowlist that is not a named exception in scripts/license-exceptions.json. Exceptions are reported, never hidden.
// A dependency that is listed but not installed fails too (only optionalDependencies may be absent).
//
// --strict rejects the exceptions as well. `prepublishOnly` runs it, so an accidental `npm publish` is blocked while
// libsignal (GPL-3.0, from Baileys) is still undecided. It is not part of `prepack`: packing, the Docker image and the
// executables must keep working. Remove the exception, and this block, once the libsignal decision is made.
//
// --notices writes THIRD_PARTY_NOTICES.md from the same walk; --notices --check fails when the file on disk differs
// from what the installed production tree would produce (run it after `npm ci`, so it follows package-lock.json).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

/** A browsable https URL for the `repository` (or `homepage`) field, or '' when the package declares none. */
export function repositoryOf(pkg) {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const candidate = typeof raw === 'string' && raw.length > 0 ? raw : pkg.homepage
  if (typeof candidate !== 'string' || candidate.length === 0) return ''
  let url = candidate.trim().replace(/^git\+/, '')
  const shorthand = url.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/)
  if (shorthand) url = `https://github.com/${shorthand[1]}`
  url = url
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
  url = url.replace(/\.git(#.*)?$/, '').replace(/#.*$/, '')
  return /^https?:\/\//.test(url) ? url : ''
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
    seen.set(found, {
      name: pkg.name ?? name,
      version: pkg.version ?? '0.0.0',
      license: licenseOf(pkg),
      repository: repositoryOf(pkg),
    })
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

/** The text of THIRD_PARTY_NOTICES.md: deterministic (stable order, no dates), exceptions marked with their reason. */
export function renderNotices({ packages, exceptions }) {
  const cell = (text) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
  const lines = [
    '# Third-party notices',
    '',
    '<!-- Generated by `npm run notices` from the installed production dependencies. Do not edit by hand. -->',
    '',
    'message-summarize is MIT-licensed. It uses the production dependencies below (direct and transitive), each under',
    'its own license. Development tools are not listed because they are not distributed.',
    '',
  ]
  const excepted = packages.filter((pkg) => !isAllowed(pkg.license) && exceptions[pkg.name]?.license === pkg.license)
  if (excepted.length > 0) {
    lines.push('## License exceptions', '')
    lines.push('These dependencies are outside the license allowlist and are reported on purpose (RNF-18).', '')
    for (const pkg of excepted) {
      lines.push(`- **${pkg.name}@${pkg.version}** (${pkg.license}): ${exceptions[pkg.name].reason}`)
    }
    lines.push('')
  }
  lines.push(`## Production dependencies (${packages.length})`, '')
  lines.push('| Package | Version | License | Repository |', '|---|---|---|---|')
  for (const pkg of packages) {
    const flag = excepted.includes(pkg) ? ' (exception, see above)' : ''
    const repo = pkg.repository === '' ? '-' : pkg.repository
    lines.push(`| ${cell(pkg.name)} | ${cell(pkg.version)} | ${cell(pkg.license)}${flag} | ${repo} |`)
  }
  return `${lines.join('\n')}\n`
}

/** Writes the notices file, or with `check` compares it. Returns the exit code and the lines for stdout and stderr. */
export function notices({
  dir = root,
  exceptions,
  check: onlyCheck = false,
  file = join(dir, 'THIRD_PARTY_NOTICES.md'),
}) {
  const { packages, missing } = productionPackages(dir)
  if (missing.length > 0)
    return { code: 1, out: [], err: [`notices: NOT INSTALLED ${missing.join(', ')}: run "npm ci" first`] }
  const text = renderNotices({ packages, exceptions })
  if (!onlyCheck) {
    writeFileSync(file, text)
    return { code: 0, out: [`notices: wrote ${packages.length} packages to THIRD_PARTY_NOTICES.md.`], err: [] }
  }
  const current = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null
  if (current === text) return { code: 0, out: ['notices:check: THIRD_PARTY_NOTICES.md is up to date.'], err: [] }
  return {
    code: 1,
    out: [],
    err: [
      `notices:check: THIRD_PARTY_NOTICES.md is ${current === null ? 'missing' : 'out of date'}. Run "npm ci" and "npm run notices", then commit it.`,
    ],
  }
}

function main() {
  const exceptions = JSON.parse(readFileSync(join(root, 'scripts', 'license-exceptions.json'), 'utf8'))
  if (process.argv.includes('--notices')) {
    const result = notices({ exceptions, check: process.argv.includes('--check') })
    for (const line of result.out) console.log(line)
    for (const line of result.err) console.error(line)
    process.exit(result.code)
  }
  const result = check({ exceptions, strict: process.argv.includes('--strict') })
  for (const line of result.out) console.log(line)
  for (const line of result.err) console.error(line)
  process.exit(result.code)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
