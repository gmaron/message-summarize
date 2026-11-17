import { accessSync, constants, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'
import { pickEnv, runProcess } from './run-process.js'

/**
 * RF-49: a CLI is only used when the product can VERIFY that it runs without tools. The result says why not, as a code
 * that `doctor` turns into text (es/en); it never carries output of the CLI, only the names of flags.
 */
export type CliVerification =
  | { readonly ok: true; readonly path: string; readonly version: string | null }
  /** The program is not on the PATH (or not executable). */
  | { readonly ok: false; readonly kind: 'notFound' }
  /** `--help` could not be read (it failed or took too long). Not cached: it may be a passing problem. */
  | { readonly ok: false; readonly kind: 'unrunnable' }
  /** `--help` does not list a flag the hardening relies on: this version cannot be run without tools. */
  | { readonly ok: false; readonly kind: 'missingFlags'; readonly flags: readonly string[] }
  /** The preset is shipped disabled: its documentation offers no way to disable the tools that can be verified. */
  | { readonly ok: false; readonly kind: 'disabled' }

export interface VerifySpec {
  readonly command: string
  /** Where PATH and the rest of the allowed variables come from. */
  readonly env: NodeJS.ProcessEnv
  /** The variables the CLI is allowed to see (the same list it runs with). */
  readonly envNames: readonly string[]
  /** Every flag the hardening of the preset passes: all of them must be in `--help`. */
  readonly requiredFlags: readonly string[]
  /** Default 15 s for each of `--help` and `--version`. */
  readonly timeoutMs?: number
  readonly killGraceMs?: number
  /** Milliseconds, for the expiry of a cached `unrunnable`. Default `Date.now`. For tests. */
  readonly now?: () => number
}

/** How long a `--help` that could not run is remembered: long enough not to run it on every call, short enough to recover. */
export const UNRUNNABLE_TTL_MS = 60_000

/** `expires` is set only for a result that may pass (`unrunnable`). */
const cache = new Map<string, { readonly result: CliVerification; readonly expires: number | null }>()
/** Verifications being made right now, so concurrent first calls share one run of `--help`. */
const inFlight = new Map<string, Promise<CliVerification>>()

/** Forgets what was verified. For tests. */
export function clearVerificationCache(): void {
  cache.clear()
  inFlight.clear()
}

/** The absolute path of the program `command` would run, or null. A name with no directory is looked up on PATH. */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
  const isExecutable = (file: string): boolean => {
    try {
      if (!statSync(file).isFile()) return false
      accessSync(file, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (command.includes('/') || command.includes(sep)) {
    const file = isAbsolute(command) ? command : resolve(command)
    return isExecutable(file) ? file : null
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const file = join(dir, command)
    if (isExecutable(file)) return file
  }
  return null
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when `help` lists `flag` as a whole word (`--tools` is not found inside `--tools-extra`). */
export function helpListsFlag(help: string, flag: string): boolean {
  return new RegExp(`(?<![\\w-])${escapeRegExp(flag)}(?![\\w-])`).test(help)
}

/**
 * Runs `<command> --help` and `<command> --version` (never a model call) with the restricted environment, in an empty
 * temporary directory, and checks that every required flag is listed. The result is cached for the path and the
 * modification time of the program, so an upgrade is looked at again and the same binary is not run twice. Calls made
 * while one is running share it. A `--help` that could not run is remembered for 60 s only.
 */
export async function verifyCli(spec: VerifySpec): Promise<CliVerification> {
  const path = resolveExecutable(spec.command, spec.env)
  if (path === null) return { ok: false, kind: 'notFound' }
  let stamp: string
  try {
    const info = statSync(path)
    stamp = `${path}\0${info.mtimeMs}\0${info.size}\0${spec.requiredFlags.join(',')}`
  } catch {
    return { ok: false, kind: 'notFound' }
  }
  const now = spec.now ?? Date.now
  const cached = cache.get(stamp)
  if (cached !== undefined && (cached.expires === null || cached.expires > now())) return cached.result
  // Concurrent first calls share the one that is running.
  const running = inFlight.get(stamp)
  if (running !== undefined) return running
  const made = runVerification(spec, path).then((result) => {
    cache.set(stamp, {
      result,
      expires: result.ok === false && result.kind === 'unrunnable' ? now() + UNRUNNABLE_TTL_MS : null,
    })
    return result
  })
  inFlight.set(stamp, made)
  try {
    return await made
  } finally {
    inFlight.delete(stamp)
  }
}

async function runVerification(spec: VerifySpec, path: string): Promise<CliVerification> {
  const env = pickEnv(spec.env, spec.envNames)
  const cwd = await mkdtemp(join(tmpdir(), 'message-summarize-verify-'))
  try {
    const run = (args: readonly string[]) =>
      runProcess({
        command: path,
        args,
        stdin: '',
        cwd,
        env,
        timeoutMs: spec.timeoutMs ?? 15_000,
        killGraceMs: spec.killGraceMs ?? 2_000,
        maxOutputChars: 1_000_000,
      })
    const help = await run(['--help'])
    if (help.kind !== 'exited' || help.code !== 0) return { ok: false, kind: 'unrunnable' }
    const text = `${help.stdout}\n${help.stderr}`
    const missing = spec.requiredFlags.filter((flag) => !helpListsFlag(text, flag))
    if (missing.length > 0) return { ok: false, kind: 'missingFlags', flags: missing }
    const versionRun = await run(['--version'])
    const version =
      versionRun.kind === 'exited' && versionRun.code === 0
        ? (versionRun.stdout
            .split('\n')
            .find((line) => line.trim() !== '')
            ?.trim() ?? null)
        : null
    return { ok: true, path, version }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}
