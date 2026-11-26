import { spawn } from 'node:child_process'

/**
 * What the process did. Its output is never quoted in an error: it can echo chat text (see `CliSummarizer`).
 */
export type RunOutcome =
  | { readonly kind: 'exited'; readonly stdout: string; readonly stderr: string; readonly code: number | null }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'spawn-error'; readonly reason: string }

export interface RunSpec {
  readonly command: string
  readonly args: readonly string[]
  /** Written to the standard input, then closed. */
  readonly stdin: string
  /** An empty directory of its own (the caller creates and removes it). */
  readonly cwd: string
  /** Already filtered: it is exactly what the child receives, nothing is added. */
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  /** Time between SIGTERM and SIGKILL when the timeout fires. */
  readonly killGraceMs: number
  /** Each of stdout and stderr is capped at about this many characters; past it the child is killed. */
  readonly maxOutputChars: number
  /** Aborting kills the process group at once and settles as a `timeout` (the caller knows it asked for it). */
  readonly signal?: AbortSignal
}

/** Each of stdout and stderr of a CLI is capped at 2 MB, as the answers of the HTTP APIs are. */
export const DEFAULT_MAX_OUTPUT_CHARS = 2 * 1024 * 1024

/** The variables of `source` named in `names`, only those that are set: the whole environment a child may get. */
export function pickEnv(source: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of names) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/**
 * Runs a program without a shell (RF-49): each argument reaches it as is, so text written by third parties can never
 * be interpreted. The child leads its own process group, and the timeout (SIGTERM, then SIGKILL after the grace time)
 * kills the whole group, grandchildren included. The call settles as soon as the child is gone, not when its pipes
 * close, so a grandchild that holds them open cannot make it hang.
 */
export function runProcess(spec: RunSpec): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    // detached: the child leads its own process group, so the whole tree can be killed.
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid === undefined) return
        process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {}
      }
    }
    const finish = (outcome: RunOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // The SIGKILL timer is never cleared on purpose: the group must still be killed after a timeout.
      resolve(outcome)
    }
    const abort = (outcome: RunOutcome) => {
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), spec.killGraceMs).unref()
      child.stdout.destroy()
      child.stderr.destroy()
      finish(outcome)
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), spec.killGraceMs).unref()
      // The child may already be gone with a grandchild holding the pipes open: do not wait for 'close'.
      if (child.exitCode !== null || child.signalCode !== null) {
        child.stdout.destroy()
        child.stderr.destroy()
        finish({ kind: 'timeout' })
      }
    }, spec.timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      stdout += d
      if (stdout.length > spec.maxOutputChars) abort({ kind: 'too-large' })
    })
    child.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-spec.maxOutputChars) // only the tail matters
    })
    child.stdin.on('error', () => {}) // the child may exit before reading everything
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) abort({ kind: 'timeout' })
      else spec.signal.addEventListener('abort', () => abort({ kind: 'timeout' }), { once: true })
    }
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({ kind: 'spawn-error', reason: `could not run ${spec.command}: ${e.code ?? 'error'}` }),
    )
    // After a timeout, resolve as soon as the child is gone (not when its pipes close).
    child.on('exit', () => {
      if (timedOut) {
        child.stdout.destroy()
        child.stderr.destroy()
        finish({ kind: 'timeout' })
      }
    })
    child.on('close', (code) => finish(timedOut ? { kind: 'timeout' } : { kind: 'exited', stdout, stderr, code }))
    child.stdin.end(spec.stdin)
  })
}
