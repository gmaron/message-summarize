import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** What a program printed and how it ended. `code` is null when it could not be started or was killed. */
export interface CommandResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs a program with an argument list, no shell. Never rejects. Tests replace it: no real service manager is touched. */
export interface CommandRunner {
  run(file: string, args: readonly string[]): Promise<CommandResult>
}

/** The few file operations the adapters need. Tests replace it with a temporary directory. */
export interface ServiceFiles {
  /** The text of a file, or null when it does not exist. */
  read(path: string): Promise<string | null>
  /** Writes the file (and its directory). `mode` is for the file; directories are created 0700. */
  write(path: string, content: string, mode: number): Promise<void>
  /** Creates a directory (and its parents) private, 0700, when it is missing. */
  ensureDir(path: string): Promise<void>
  /** Deletes a file. True when it existed. */
  remove(path: string): Promise<boolean>
}

/** Where the user's session lives, and how to reach the service manager. */
export interface ServiceHost {
  readonly platform: NodeJS.Platform
  readonly home: string
  /** The data directory of the installation (where the Windows launcher lives). */
  readonly dataDir: string
  /** `$XDG_CONFIG_HOME` or `~/.config` (Linux). */
  readonly configHome: string
  /** The numeric id of the user (macOS: `gui/<uid>`). Null on Windows. */
  readonly uid: number | null
  readonly runner: CommandRunner
  readonly files: ServiceFiles
  /** Waits `ms`. Tests give one that returns at once. */
  readonly sleep?: (ms: number) => Promise<void>
}

const COMMAND_TIMEOUT_MS = 30_000

export const nodeRunner: CommandRunner = {
  run: (file, args) =>
    new Promise((resolve) => {
      execFile(file, [...args], { timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr })
        const failure = error as NodeJS.ErrnoException
        const code = typeof failure.code === 'number' ? failure.code : null
        resolve({ code, stdout, stderr: stderr !== '' ? stderr : failure.message })
      })
    }),
}

export const nodeFiles: ServiceFiles = {
  async read(path) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  async write(path, content, mode) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, content, { mode })
  },
  async ensureDir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 })
  },
  async remove(path) {
    try {
      await rm(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  },
}

/** The first non-empty line of what a command said, for an error message. */
export function firstLine(result: CommandResult): string {
  const text = result.stderr.trim() !== '' ? result.stderr : result.stdout
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim() !== '')
      ?.trim() ?? `exit code ${result.code ?? 'none'}`
  )
}

/** A value that ends up on one line of a unit or a script cannot hold a line break. */
export function assertSingleLine(value: string): void {
  if (/[\r\n\0]/.test(value)) throw new Error('service definition holds a line break')
}
