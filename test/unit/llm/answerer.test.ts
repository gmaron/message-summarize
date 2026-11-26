import { afterEach, describe, expect, it } from 'vitest'
import type { Answerer, AnswerRequest } from '../../../src/application/ports/answerer.js'
import {
  AnthropicSummarizer,
  claudeArgs,
  composeAnswerer,
  GeminiSummarizer,
  GenericCliSummarizer,
  OllamaSummarizer,
  OpenAiCompatibleSummarizer,
  PROMPT_PLACEHOLDER,
} from '../../../src/infrastructure/llm/index.js'
import { NO_WAIT } from '../../contract/summarizer.contract.js'
import { type FakeServer, startFakeServer } from '../../support/fake-http-server.js'

const REQUEST: AnswerRequest = { systemPrompt: 'SYSTEM', input: 'INPUT' }

const fake = (local: boolean, result: Awaited<ReturnType<Answerer['answer']>>): Answerer & { calls: number } => {
  const answerer = {
    local,
    calls: 0,
    async answer() {
      answerer.calls++
      return result
    },
  }
  return answerer
}
const good = { ok: true, text: 'fine', provider: 'p' } as const

describe('composeAnswerer', () => {
  it('uses the primary alone when there is no backup', async () => {
    const primary = fake(false, good)
    expect(composeAnswerer({ primary })).toBe(primary)
  })

  it('goes to the backup only when the primary fails, and reports both reasons when both fail', async () => {
    const primary = fake(false, { ok: false, error: 'primary down' })
    const backup = fake(false, good)
    expect(await composeAnswerer({ primary, backup }).answer(REQUEST)).toEqual(good)
    const both = composeAnswerer({ primary, backup: fake(false, { ok: false, error: 'backup down' }) })
    expect(await both.answer(REQUEST)).toEqual({ ok: false, error: 'primary down; fallback: backup down' })
  })

  it('does not call the backup when the primary answers', async () => {
    const backup = fake(false, good)
    await composeAnswerer({ primary: fake(false, good), backup }).answer(REQUEST)
    expect(backup.calls).toBe(0)
  })

  it('is local only when both providers are', () => {
    expect(composeAnswerer({ primary: fake(true, good), backup: fake(true, good) }).local).toBe(true)
    expect(composeAnswerer({ primary: fake(true, good), backup: fake(false, good) }).local).toBe(false)
    expect(composeAnswerer({ primary: fake(false, good), backup: fake(true, good) }).local).toBe(false)
  })
})

describe('the request of an answer asks for free text', () => {
  const servers: FakeServer[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()))
  })
  const open = async (body: string) => {
    const server = await startFakeServer()
    servers.push(server)
    server.script({ body })
    return server
  }

  it('anthropic: no JSON format, a large output', async () => {
    const server = await open(JSON.stringify({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }))
    await new AnthropicSummarizer({
      model: 'm',
      baseUrl: server.baseUrl,
      apiKey: 'k',
      retryClock: NO_WAIT,
      maxTokens: 1000,
    }).answer(REQUEST)
    const body = server.seen[0]?.json as { max_tokens: number; output_config: Record<string, unknown> }
    expect(body.output_config.format).toBeUndefined()
    expect(body.max_tokens).toBeGreaterThanOrEqual(16_000)
  })

  it('gemini: no JSON mime type', async () => {
    const server = await open(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }))
    await new GeminiSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: 'k', retryClock: NO_WAIT }).answer(
      REQUEST,
    )
    const sent = server.seen[0]?.json as { generationConfig: Record<string, unknown> }
    const config = sent.generationConfig
    expect(config.responseMimeType).toBeUndefined()
    expect(config.responseJsonSchema).toBeUndefined()
  })

  it('openai-compatible: no response format and no schema in the system prompt, in any mode', async () => {
    for (const structuredOutput of ['json_schema', 'json_object', 'prompt'] as const) {
      const server = await open(JSON.stringify({ choices: [{ message: { content: 'x' } }] }))
      await new OpenAiCompatibleSummarizer({
        model: 'm',
        baseUrl: `${server.baseUrl}/v1`,
        structuredOutput,
        retryClock: NO_WAIT,
      }).answer(REQUEST)
      const body = server.seen[0]?.json as { response_format?: unknown; messages: { content: string }[] }
      expect(body.response_format).toBeUndefined()
      expect(body.messages[0]?.content).toBe('SYSTEM')
    }
  })

  it('ollama: no format and a larger context', async () => {
    const server = await open(JSON.stringify({ message: { content: 'x' } }))
    await new OllamaSummarizer({ model: 'm', baseUrl: server.baseUrl }).answer(REQUEST)
    const body = server.seen[0]?.json as { format?: unknown; options: { num_ctx: number } }
    expect(body.format).toBeUndefined()
    expect(body.options.num_ctx).toBeGreaterThan(16384)
  })

  it('claude: the sandbox flags stay and only the schema goes', () => {
    const args = claudeArgs('sonnet', 'SYS', false)
    expect(args).not.toContain('--json-schema')
    for (const flag of [
      '--tools',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--safe-mode',
      '--disable-slash-commands',
    ]) {
      expect(args).toContain(flag)
    }
    expect(args[args.indexOf('--tools') + 1]).toBe('')
  })
})

describe('Ollama never lets the context cut the text silently', () => {
  const servers: FakeServer[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()))
  })
  const open = async (body: string) => {
    const server = await startFakeServer()
    servers.push(server)
    server.script({ body })
    return server
  }

  it('sizes the window to the text, with room for the whole answer', async () => {
    const server = await open(JSON.stringify({ message: { content: 'x' } }))
    await new OllamaSummarizer({ model: 'm', baseUrl: server.baseUrl }).answer({
      systemPrompt: 'S',
      input: 'y'.repeat(20_000),
    })
    const body = server.seen[0]?.json as { options: { num_ctx: number; num_predict: number } }
    // 10 000 tokens estimated + 16 384 for the answer + a margin
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(10_000 + body.options.num_predict)
    expect(body.options.num_ctx).toBeLessThanOrEqual(65_536)
    expect(body.options.num_ctx % 1024).toBe(0)
  })

  it('refuses, without calling the server, a text that does not fit the largest window', async () => {
    const server = await open(JSON.stringify({ message: { content: 'x' } }))
    const ollama = new OllamaSummarizer({ model: 'm', baseUrl: server.baseUrl })
    const result = await ollama.answer({ systemPrompt: 'S', input: 'y'.repeat(150_000) })
    expect(result).toEqual({ ok: false, error: 'ollama: the text does not fit the context window' })
    expect(server.seen).toEqual([])
  })

  it('asks the use case for parts that do fit, and a part of that size is accepted', async () => {
    const server = await open(JSON.stringify({ message: { content: 'x' } }))
    const ollama = new OllamaSummarizer({ model: 'm', baseUrl: server.baseUrl })
    expect(ollama.maxPartChars).toBeLessThan(150_000)
    const result = await ollama.answer({ systemPrompt: 'S'.repeat(5_000), input: 'y'.repeat(ollama.maxPartChars) })
    expect(result.ok).toBe(true)
  })

  it('fails when Ollama reports that the prompt and the answer could not both fit', async () => {
    const server = await open(JSON.stringify({ message: { content: 'x' }, prompt_eval_count: 60_000 }))
    const result = await new OllamaSummarizer({ model: 'm', baseUrl: server.baseUrl }).answer(REQUEST)
    expect(result).toEqual({ ok: false, error: 'ollama: the text did not fit the context window' })
  })

  it('a smaller maximum window gives smaller parts', () => {
    const small = new OllamaSummarizer({ model: 'm', answerNumCtx: 32_768 })
    expect(small.maxPartChars).toBeLessThan(new OllamaSummarizer({ model: 'm' }).maxPartChars)
  })
})

describe('the generic CLI with the prompt as an argument', () => {
  const viaArgument = new GenericCliSummarizer({ command: ['tool', PROMPT_PLACEHOLDER], acknowledgeRisk: true })
  const viaStdin = new GenericCliSummarizer({ command: ['tool'], acknowledgeRisk: true })

  it('asks for parts far under the 128 KiB limit of an argument; through stdin there is no limit of its own', () => {
    expect(viaArgument.maxPartChars).toBeLessThanOrEqual(50_000)
    expect(viaStdin.maxPartChars).toBeUndefined()
  })

  it('refuses a prompt over the byte limit with a clear error, without running anything, measuring bytes not characters', async () => {
    // 40 000 characters of 3 bytes each: 120 000 bytes
    const bytes = await viaArgument.answer({ systemPrompt: 'S', input: '€'.repeat(40_000) })
    expect(bytes).toEqual({ ok: false, error: expect.stringContaining('too large to pass as an argument') })
    expect((await viaArgument.answer({ systemPrompt: 'S', input: 'y'.repeat(100_001) })).ok).toBe(false)
  })

  it('the fallback keeps the smaller limit of its two providers', () => {
    const composed = composeAnswerer({ primary: viaArgument, backup: new OllamaSummarizer({ model: 'm' }) })
    expect(composed.maxPartChars).toBe(
      Math.min(viaArgument.maxPartChars as number, new OllamaSummarizer({ model: 'm' }).maxPartChars),
    )
    expect(composeAnswerer({ primary: viaStdin, backup: viaStdin }).maxPartChars).toBeUndefined()
  })
})
