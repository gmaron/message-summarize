import { err, ok, type Result } from '../../domain/result.js'
import { redactSecrets } from './api/redact.js'
import { readTextCapped } from './read-capped.js'
import { excerpt } from './summary-schema.js'

// Management calls to the user's own Ollama server: which models it has (`/api/tags`) and downloading one
// (`/api/pull`). No chat text is ever sent here, only a model tag. The only host is the configured base URL (RNF-01).

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'
/** A progress event is a few hundred bytes. A line longer than this is not one. */
const MAX_LINE_BYTES = 64 * 1024
/** The list of models of an Ollama is a few kilobytes; more than this is not one. */
const MAX_TAGS_BYTES = 2_000_000
const TOO_LONG = 'ollama sent a line longer than 64 KB'
const clean = (text: string): string => excerpt(redactSecrets(text, []))
const root = (baseUrl: string | undefined): string => (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')

/** The names of the models the server has, as it states them (`qwen3:4b`, `llama3.2:latest`). */
export async function listOllamaModels(
  baseUrl: string | undefined,
  options: { readonly timeoutMs?: number; readonly fetch?: typeof fetch } = {},
): Promise<Result<string[], string>> {
  try {
    const response = await (options.fetch ?? fetch)(`${root(baseUrl)}/api/tags`, {
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    })
    if (!response.ok) return err(`ollama answered ${response.status}`)
    // The list of an Ollama is read with a byte limit too: a server that never stops is not held in memory.
    const raw = await readTextCapped(response, MAX_TAGS_BYTES)
    if (raw === null) return err('ollama sent a list that is too long')
    const body = JSON.parse(raw) as { models?: unknown }
    if (!Array.isArray(body.models)) return err('ollama returned no model list')
    const names: string[] = []
    for (const entry of body.models) {
      const name = (entry as { name?: unknown; model?: unknown } | null)?.name
      if (typeof name === 'string') names.push(name)
    }
    return ok(names)
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return err('ollama did not answer in time')
    return err(`could not reach ollama: ${error instanceof Error ? clean(error.message) : 'error'}`)
  }
}

/** True when `configured` ("qwen3:4b", or "llama3.2" which means "llama3.2:latest") is among the server's models. */
export function ollamaHasModel(configured: string, names: readonly string[]): boolean {
  const wanted = configured.includes(':') ? configured : `${configured}:latest`
  return names.includes(wanted)
}

export interface PullProgress {
  readonly status: string
  /** Bytes downloaded and expected, summed over the layers announced so far. Zero while only the manifest is read. */
  readonly completed: number
  readonly total: number
}

export interface PullOptions {
  readonly onProgress?: (progress: PullProgress) => void
  /** The pull fails when nothing arrives for this long. Default 2 minutes. */
  readonly idleTimeoutMs?: number
  readonly fetch?: typeof fetch
}

/**
 * Downloads a model with `/api/pull`, streaming. Succeeds only when the last status is "success"; an `error` line in
 * the middle of the stream, an HTTP error or a stream that ends without "success" is a failure with a redacted reason.
 */
export async function pullOllamaModel(
  baseUrl: string | undefined,
  tag: string,
  options: PullOptions = {},
): Promise<Result<void, string>> {
  const idleMs = options.idleTimeoutMs ?? 120_000
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const touch = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new DOMException('idle', 'TimeoutError')), idleMs)
  }
  try {
    touch()
    const response = await (options.fetch ?? fetch)(`${root(baseUrl)}/api/pull`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ model: tag, stream: true }),
    })
    if (!response.ok) return err(`ollama answered ${response.status}: ${clean(await response.text())}`)
    if (response.body === null) return err('ollama returned no body')

    const layers = new Map<string, { completed: number; total: number }>()
    let last = ''
    let succeeded = false
    const handle = (line: string): string | null => {
      if (line.trim() === '') return null
      let event: { status?: unknown; error?: unknown; digest?: unknown; total?: unknown; completed?: unknown }
      try {
        event = JSON.parse(line)
      } catch {
        return 'ollama sent a line that is not JSON'
      }
      if (typeof event.error === 'string') return clean(event.error)
      if (typeof event.status !== 'string') return null
      last = event.status
      if (last === 'success') succeeded = true
      if (typeof event.digest === 'string' && typeof event.total === 'number') {
        layers.set(event.digest, {
          total: event.total,
          completed: typeof event.completed === 'number' ? event.completed : 0,
        })
      }
      let completed = 0
      let total = 0
      for (const layer of layers.values()) {
        completed += layer.completed
        total += layer.total
      }
      options.onProgress?.({ status: clean(last), completed, total })
      return null
    }

    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      touch()
      buffer += decoder.decode(chunk, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        if (newline > MAX_LINE_BYTES) return err(TOO_LONG)
        const failure = handle(buffer.slice(0, newline))
        if (failure !== null) return err(failure)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      // A line that keeps growing without a newline would fill the memory: the stream is not Ollama's.
      if (buffer.length > MAX_LINE_BYTES) return err(TOO_LONG)
    }
    const failure = handle(buffer)
    if (failure !== null) return err(failure)
    return succeeded ? ok(undefined) : err(`the download ended without "success" (last status: "${clean(last)}")`)
  } catch (error) {
    if (controller.signal.aborted) return err(`ollama sent nothing for ${idleMs / 1000}s`)
    return err(`could not reach ollama: ${error instanceof Error ? clean(error.message) : 'error'}`)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
