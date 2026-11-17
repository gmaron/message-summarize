import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SummarizeRequest } from '../../../src/application/ports/summarizer.js'
import { err, ok, type Result } from '../../../src/domain/result.js'
import { LOCAL_ONLY_UNAVAILABLE } from '../../../src/infrastructure/llm/index.js'
import { type AppConfig, parseConfig } from '../../../src/main/config.js'

/** What each fake provider was built with and asked, in order of the calls across providers. */
const log = vi.hoisted(() => ({
  built: [] as { kind: string; options: Record<string, unknown> }[],
  calls: [] as { kind: string; conversation: string }[],
  answers: {} as Record<string, (conversation: string) => unknown>,
}))

// The real providers spawn a CLI or call a server. Fakes that record the calls stand in for them, and the real
// composition (composeSummarizer: router, fallback) stays, so what is tested is the wiring and its order.
vi.mock('../../../src/infrastructure/llm/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/infrastructure/llm/index.js')>()
  const fake = (kind: string) =>
    class {
      constructor(options: Record<string, unknown>) {
        log.built.push({ kind, options })
      }
      async summarize(request: SummarizeRequest): Promise<Result<unknown, string>> {
        log.calls.push({ kind, conversation: request.conversation.name })
        const answer = log.answers[kind]?.(request.conversation.name) ?? ok({ resumen: kind })
        return answer as Result<unknown, string>
      }
    }
  return { ...original, ClaudeCliSummarizer: fake('claude-cli'), OllamaSummarizer: fake('ollama') }
})

const { buildSummarizer } = await import('../../../src/main/providers.js')

const config = (input: Record<string, unknown>): AppConfig => {
  const parsed = parseConfig(input, 'UTC')
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
  return parsed.value
}
const request = (name: string): SummarizeRequest => ({
  conversation: { id: `${name.toLowerCase().replace(/\W/g, '')}@s.whatsapp.net`, name, isGroup: false },
  systemPrompt: 'prompt',
  transcript: 'text',
})
const VALID = { resumen: 'ok', pendientes: [], necesita_respuesta: false, prioridad: 'baja' }
const kinds = () => log.calls.map((c) => c.kind)

beforeEach(() => {
  log.built.length = 0
  log.calls.length = 0
  for (const key of Object.keys(log.answers)) delete log.answers[key]
})

describe('buildSummarizer', () => {
  it('gives nothing when no provider was chosen (RF-41)', () => {
    expect(buildSummarizer(config({}), {})).toBeNull()
    expect(log.built).toEqual([])
  })

  it('builds the Claude CLI with the configured command, model and timeout, and the environment given', () => {
    const env = { PATH: '/bin' }
    buildSummarizer(
      config({
        provider: { primary: 'claude-cli', claudeCli: { command: '/opt/claude', model: 'opus', timeoutMs: 5000 } },
      }),
      env,
    )
    expect(log.built).toEqual([
      { kind: 'claude-cli', options: { command: '/opt/claude', model: 'opus', timeoutMs: 5000, env } },
    ])
  })

  it('sends a chat to the primary, and only to the primary when it works', async () => {
    log.answers['claude-cli'] = () => ok(VALID)
    const summarizer = buildSummarizer(
      config({ provider: { primary: 'claude-cli', backup: 'ollama', ollama: { model: 'qwen' } } }),
      {},
    )
    expect((await summarizer?.summarize(request('Ana')))?.ok).toBe(true)
    expect(kinds()).toEqual(['claude-cli'])
  })

  it('primary first, then the backup, in that order', async () => {
    log.answers['claude-cli'] = () => err('cli down')
    log.answers.ollama = () => ok(VALID)
    const summarizer = buildSummarizer(
      config({ provider: { primary: 'claude-cli', backup: 'ollama', ollama: { model: 'qwen' } } }),
      {},
    )
    expect((await summarizer?.summarize(request('Ana')))?.ok).toBe(true)
    expect(kinds()).toEqual(['claude-cli', 'ollama'])
  })

  it('with Ollama as the primary and the CLI as the backup, the order is the other way round', async () => {
    log.answers.ollama = () => err('server down')
    log.answers['claude-cli'] = () => ok(VALID)
    const summarizer = buildSummarizer(
      config({ provider: { primary: 'ollama', backup: 'claude-cli', ollama: { model: 'qwen' } } }),
      {},
    )
    expect((await summarizer?.summarize(request('Ana')))?.ok).toBe(true)
    expect(kinds()).toEqual(['ollama', 'claude-cli'])
  })

  it('passes the Ollama options to the local provider', () => {
    buildSummarizer(
      config({
        provider: {
          primary: 'ollama',
          ollama: { model: 'qwen', baseUrl: 'http://localhost:1234', numCtx: 4096, keepAlive: '5m', timeoutMs: 9000 },
        },
      }),
      {},
    )
    expect(log.built.find((b) => b.kind === 'ollama')?.options).toEqual({
      model: 'qwen',
      baseUrl: 'http://localhost:1234',
      timeoutMs: 9000,
      numCtx: 4096,
      keepAlive: '5m',
    })
  })

  describe('local-only conversations (RF-43)', () => {
    const localOnly = {
      localOnlyPatterns: ['bank'],
      provider: { primary: 'claude-cli', ollama: { model: 'qwen' } },
    }

    it('a matching chat goes to the local provider and never calls the CLI', async () => {
      log.answers.ollama = () => ok(VALID)
      const summarizer = buildSummarizer(config(localOnly), {})
      const result = await summarizer?.summarize(request('Bank of Ana'))
      expect(result?.ok).toBe(true)
      expect(kinds()).toEqual(['ollama'])
    })

    it('a chat that does not match goes to the CLI, not to Ollama', async () => {
      log.answers['claude-cli'] = () => ok(VALID)
      const summarizer = buildSummarizer(config(localOnly), {})
      await summarizer?.summarize(request('Ana'))
      expect(kinds()).toEqual(['claude-cli'])
    })

    it('when the local provider fails the chat is omitted: it is never sent to the CLI or the backup', async () => {
      log.answers.ollama = () => err('local server down')
      const summarizer = buildSummarizer(
        config({ ...localOnly, provider: { primary: 'claude-cli', backup: 'claude-cli', ollama: { model: 'qwen' } } }),
        {},
      )
      const result = await summarizer?.summarize(request('Bank of Ana'))
      expect(result).toEqual({ ok: false, error: 'local server down' })
      expect(kinds()).toEqual(['ollama'])
    })

    it('with no local provider available a matching chat is omitted with the fixed reason (router)', async () => {
      // `composeSummarizer` without `local`, as `buildSummarizer` would if the config could omit it
      const { composeSummarizer } = await import('../../../src/infrastructure/llm/index.js')
      const cli = {
        summarize: async (r: SummarizeRequest) => {
          log.calls.push({ kind: 'cli', conversation: r.conversation.name })
          return ok(VALID)
        },
      }
      const summarizer = composeSummarizer({ primary: cli, localOnlyPatterns: ['bank'] })
      expect(await summarizer.summarize(request('Bank of Ana'))).toEqual({ ok: false, error: LOCAL_ONLY_UNAVAILABLE })
      expect(kinds()).toEqual([])
    })

    it('the configuration refuses local-only patterns without an Ollama model, so there is always a local provider', () => {
      expect(parseConfig({ localOnlyPatterns: ['bank'], provider: { primary: 'claude-cli' } }, 'UTC').ok).toBe(false)
    })
  })
})
