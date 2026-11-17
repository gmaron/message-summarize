import { spawn } from 'node:child_process'

/**
 * The only environment variables a transcription program receives, and only when set: PATH to find its libraries and
 * helpers, HOME, LANG and TZ, TMPDIR for its temporary files. Nothing else leaks: no API keys, no tokens, no proxies.
 */
export const TRANSCRIPTION_ENV_NAMES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'] as const

/** How much of the end of each output is kept. The programs print progress; only the tail explains a failure. */
const KEPT_OUTPUT_CHARS = 4_000

export type RunOutcome =
  | { readonly kind: 'exited'; readonly code: number | null; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'timeout' }
  /** `kill()` was called (the transcriber is being closed). */
  | { readonly kind: 'killed' }
  /** The program could not be started: `code` is the system error code ("ENOENT": not found, "EACCES": not executable). */
  | { readonly kind: 'spawn-error'; readonly code: string }

export interface RunOptions {
  readonly command: string
  readonly args: readonly string[]
  /** An empty directory of ours: the program never works inside the user's folders. */
  readonly cwd: string
  readonly timeoutMs: number
  /** Time between SIGTERM and SIGKILL. Default 5 seconds. */
  readonly killGraceMs?: number
  /** Where the environment is taken from. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

export interface RunningProcess {
  readonly result: Promise<RunOutcome>
  /** Kills the whole process group. The result is `killed`. */
  kill(): void
}

/**
 * Runs a program with no shell (`shell: false`: the arguments are never interpreted), in its own process group, with a
 * restricted environment, no stdin, and a time limit that kills the whole group (the program and anything it started).
 *
 * Known limit: the child is DETACHED (it leads its own group, so the whole tree can be killed by group). If this process
 * is killed with SIGKILL (or crashes hard) nobody runs the kill, and a whisper or ffmpeg that is running goes on until it
 * finishes by itself or reaches its own end. Node has no portable way to ask the system to kill a child when its parent
 * dies (Linux's `prctl(PR_SET_PDEATHSIG)` is not reachable without a native module, and this project has none), so the
 * protection is the clean shutdown on SIGINT and SIGTERM, and that the input is bounded (ffmpeg reads at most 30 minutes
 * and writes at most `MAX_WAV_BYTES`), so an orphan is a finite job.
 */
export function runProcess(options: RunOptions): RunningProcess {
  const killGraceMs = options.killGraceMs ?? 5_000
  const source = options.env ?? process.env
  const env: NodeJS.ProcessEnv = {}
  for (const name of TRANSCRIPTION_ENV_NAMES) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }

  let killGroup: (signal: NodeJS.Signals) => void = () => {}
  let stopNow: () => void = () => {}
  const result = new Promise<RunOutcome>((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    killGroup = (signal) => {
      try {
        if (child.pid === undefined) return
        process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // already gone
        }
      }
    }
    const finish = (outcome: RunOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const terminate = (outcome: RunOutcome): void => {
      killGroup('SIGTERM')
      // Not cleared on purpose: the group must still be killed after the grace, even when the result is already out.
      setTimeout(() => killGroup('SIGKILL'), killGraceMs).unref()
      // A grandchild may hold the pipes open: do not wait for 'close'.
      child.stdout?.destroy()
      child.stderr?.destroy()
      finish(outcome)
    }
    const timer = setTimeout(() => terminate({ kind: 'timeout' }), options.timeoutMs)
    stopNow = () => terminate({ kind: 'killed' })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-KEPT_OUTPUT_CHARS)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-KEPT_OUTPUT_CHARS)
    })
    child.on('error', (error: NodeJS.ErrnoException) => finish({ kind: 'spawn-error', code: error.code ?? 'UNKNOWN' }))
    child.on('close', (code) => finish({ kind: 'exited', code, stdout, stderr }))
  })
  return { result, kill: () => stopNow() }
}
