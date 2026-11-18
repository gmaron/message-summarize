import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { CHILD_ENV_NAMES, listOllamaModels, verifyClaudeCli } from '../infrastructure/llm/index.js'
import type { CommandProbe, DoctorProbes } from './context.js'

const PROBE_TIMEOUT_MS = 10_000

/** `<command> --version`, with only the environment variables the summarizer child gets too (RNF-04). */
function commandVersion(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const childEnv: NodeJS.ProcessEnv = {}
  for (const name of CHILD_ENV_NAMES) {
    const value = env[name]
    if (value !== undefined) childEnv[name] = value
  }
  return new Promise((resolve) => {
    execFile(command, ['--version'], { env: childEnv, timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      resolve(error === null ? stdout.trim().split('\n')[0] || 'ok' : null)
    })
  })
}

/** `<command> <args>`, with the same restricted environment. Says whether it started, whether it succeeded and what it printed first. */
function commandProbe(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CommandProbe> {
  const childEnv: NodeJS.ProcessEnv = {}
  for (const name of CHILD_ENV_NAMES) {
    const value = env[name]
    if (value !== undefined) childEnv[name] = value
  }
  const firstLine = (text: string): string | null =>
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? null
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { env: childEnv, timeout: PROBE_TIMEOUT_MS, cwd: tmpdir() },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null
        // A string code ("ENOENT", "EACCES") means it never ran; a number is an exit code, so it did run.
        if (failure !== null && typeof failure.code === 'string') {
          resolve({ started: false, ok: false, line: null })
          return
        }
        resolve({ started: true, ok: failure === null, line: firstLine(stdout) ?? firstLine(stderr) })
      },
    )
  })
}

/** Asks the configured Ollama server for its models. The only host contacted is the one in the configuration. */
async function ollamaReachable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(5_000) })
    return response.ok
  } catch {
    return false
  }
}

export const realProbes: DoctorProbes = {
  commandVersion,
  commandProbe,
  ollamaReachable,
  ollamaModels: (baseUrl) => listOllamaModels(baseUrl, { timeoutMs: 3_000 }),
  verifyCli: verifyClaudeCli,
}
