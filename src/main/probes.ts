import { execFile } from 'node:child_process'
import { CHILD_ENV_NAMES } from '../infrastructure/llm/index.js'
import type { DoctorProbes } from './context.js'

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

/** Asks the configured Ollama server for its models. The only host contacted is the one in the configuration. */
async function ollamaReachable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(5_000) })
    return response.ok
  } catch {
    return false
  }
}

export const realProbes: DoctorProbes = { commandVersion, ollamaReachable }
