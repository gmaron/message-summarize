import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The `package.json` at the package root: two levels above `main/`, in `src` and in `dist` alike. */
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url))

/** The version in a package.json. Throws when the file is missing, is not JSON or has no version. */
export function readPackageVersion(file: string = PACKAGE_JSON): string {
  const version = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version
  if (typeof version !== 'string' || version === '') throw new Error('no version')
  return version
}

/**
 * Handles `--version` and `-v` when it is the only argument. Returns the exit code, or null when the arguments are
 * something else. A missing or corrupt package.json gives a short error and code 1, never a stack trace.
 */
export function versionCommand(
  argv: readonly string[],
  io: { out: (line: string) => void; err: (line: string) => void },
  file?: string,
): number | null {
  if (argv.length !== 1 || (argv[0] !== '--version' && argv[0] !== '-v')) return null
  try {
    io.out(readPackageVersion(file))
    return 0
  } catch {
    io.err('Could not read the version from package.json.')
    return 1
  }
}
