import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Summarizer } from '../../../src/application/ports/summarizer.js'
import {
  ANTHROPIC_VERSION,
  AnthropicSummarizer,
  GeminiSummarizer,
  OpenAiCompatibleSummarizer,
  type RetryClock,
  STRICT_SUMMARY_JSON_SCHEMA,
} from '../../../src/infrastructure/llm/index.js'
import { REQUEST, VALID_SUMMARY } from '../../contract/summarizer.contract.js'
import { type FakeServer, startFakeServer } from '../../support/fake-http-server.js'

const KEY = 'sk-test-0123456789abcdefghij'

const openaiBody = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ choices: [{ message: { role: 'assistant', content: text, ...extra } }] })
const anthropicBody = (text: string, stopReason = 'end_turn') =>
  JSON.stringify({ content: [{ type: 'text', text }], stop_reason: stopReason })
const geminiBody = (text: string) =>
  JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })
const GOOD = JSON.stringify(VALID_SUMMARY)

function recordingClock(): RetryClock & { readonly waits: number[] } {
  const waits: number[] = []
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms)
    },
    random: () => 0,
  }
}

const servers: FakeServer[] = []
const serve = async (): Promise<FakeServer> => {
  const server = await startFakeServer()
  servers.push(server)
  return server
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

/** The three adapters, each pointed at a server, with how that provider words a 429 and a good answer. */
interface Provider {
  readonly name: string
  readonly host: string
  make(server: FakeServer, clock: RetryClock, apiKey?: string): Summarizer
  readonly good: string
  readonly rateLimited: { readonly headers?: Record<string, string>; readonly body: string }[]
}
const providers: Provider[] = [
  {
    name: 'openai',
    host: 'api.openai.com',
    make: (server, clock, apiKey) =>
      new OpenAiCompatibleSummarizer({ model: 'm', baseUrl: `${server.baseUrl}/v1`, apiKey, retryClock: clock }),
    good: openaiBody(GOOD),
    rateLimited: [{ headers: { 'retry-after': '7' }, body: '{"error":{"message":"slow down"}}' }],
  },
  {
    name: 'anthropic',
    host: 'api.anthropic.com',
    make: (server, clock, apiKey) =>
      new AnthropicSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: apiKey ?? KEY, retryClock: clock }),
    good: anthropicBody(GOOD),
    rateLimited: [
      {
        headers: { 'retry-after': '7' },
        body: '{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}',
      },
    ],
  },
  {
    name: 'gemini',
    host: 'generativelanguage.googleapis.com',
    make: (server, clock, apiKey) =>
      new GeminiSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: apiKey ?? KEY, retryClock: clock }),
    good: geminiBody(GOOD),
    rateLimited: [
      {
        body: JSON.stringify({
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'quota',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }],
          },
        }),
      },
    ],
  },
]

describe('OpenAiCompatibleSummarizer (RF-40)', () => {
  it('posts to {baseUrl}/chat/completions with the key as a Bearer token and the schema as strict json_schema', async () => {
    const server = await serve()
    server.script({ body: openaiBody(GOOD) })
    const summarizer = new OpenAiCompatibleSummarizer({ model: 'gpt-x', baseUrl: `${server.baseUrl}/v1/`, apiKey: KEY })
    expect(await summarizer.summarize(REQUEST)).toEqual({ ok: true, value: VALID_SUMMARY })
    const sent = server.seen[0]
    expect(sent?.url).toBe('/v1/chat/completions')
    expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(sent?.url).not.toContain(KEY)
    expect(sent?.json).toEqual({
      model: 'gpt-x',
      messages: [
        { role: 'system', content: REQUEST.systemPrompt },
        { role: 'user', content: REQUEST.transcript },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'chat_summary', strict: true, schema: STRICT_SUMMARY_JSON_SCHEMA },
      },
    })
  })

  it('needs no key for a server of its own (LM Studio, OpenRouter...) and then sends no Authorization header', async () => {
    const server = await serve()
    server.script({ body: openaiBody(GOOD) })
    const summarizer = new OpenAiCompatibleSummarizer({ model: 'local', baseUrl: server.baseUrl })
    expect((await summarizer.summarize(REQUEST)).ok).toBe(true)
    expect(server.seen[0]?.headers.authorization).toBeUndefined()
  })

  it('json_object mode asks for a JSON object and puts the schema in the prompt', async () => {
    const server = await serve()
    server.script({ body: openaiBody(GOOD) })
    await new OpenAiCompatibleSummarizer({
      model: 'm',
      baseUrl: server.baseUrl,
      structuredOutput: 'json_object',
    }).summarize(REQUEST)
    const body = server.seen[0]?.json as { response_format: unknown; messages: { content: string }[] }
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages[0]?.content).toContain(REQUEST.systemPrompt)
    expect(body.messages[0]?.content).toContain('necesita_respuesta')
  })

  it('prompt mode sends no response_format, and accepts the JSON in a code fence', async () => {
    const server = await serve()
    server.script({ body: openaiBody(`\`\`\`json\n${GOOD}\n\`\`\``) })
    const result = await new OpenAiCompatibleSummarizer({
      model: 'm',
      baseUrl: server.baseUrl,
      structuredOutput: 'prompt',
    }).summarize(REQUEST)
    expect(result).toEqual({ ok: true, value: VALID_SUMMARY })
    expect(server.seen[0]?.json).not.toHaveProperty('response_format')
  })

  it('reports a refusal as a failed call', async () => {
    const server = await serve()
    server.script({ body: openaiBody('', { content: null, refusal: 'no puedo' }) })
    const result = await new OpenAiCompatibleSummarizer({ model: 'm', baseUrl: server.baseUrl }).summarize(REQUEST)
    expect(result).toEqual({ ok: false, error: 'openai refused to answer' })
  })

  it('requires a key for api.openai.com, and fails before any request is made', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await new OpenAiCompatibleSummarizer({ model: 'm' }).summarize(REQUEST)
    expect(result).toEqual({ ok: false, error: 'no API key for openai: set it with "msum secret set openai"' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('AnthropicSummarizer (RF-40)', () => {
  it('posts to /v1/messages with x-api-key, anthropic-version and the schema in output_config.format', async () => {
    const server = await serve()
    server.script({ body: anthropicBody(GOOD) })
    const summarizer = new AnthropicSummarizer({
      model: 'claude-x',
      baseUrl: server.baseUrl,
      apiKey: KEY,
      maxTokens: 777,
    })
    expect(await summarizer.summarize(REQUEST)).toEqual({ ok: true, value: VALID_SUMMARY })
    const sent = server.seen[0]
    expect(sent?.url).toBe('/v1/messages')
    expect(sent?.headers['x-api-key']).toBe(KEY)
    expect(sent?.headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(sent?.headers.authorization).toBeUndefined()
    expect(sent?.url).not.toContain(KEY)
    expect(sent?.json).toEqual({
      model: 'claude-x',
      max_tokens: 777,
      system: REQUEST.systemPrompt,
      messages: [{ role: 'user', content: REQUEST.transcript }],
      output_config: { format: { type: 'json_schema', schema: STRICT_SUMMARY_JSON_SCHEMA } },
    })
    // forced tool use is refused by the current models, so no tools are sent at all
    expect(sent?.json).not.toHaveProperty('tools')
    expect(sent?.json).not.toHaveProperty('tool_choice')
  })

  it('asks for 16000 max_tokens by default, and sends output_config.effort only when configured', async () => {
    const server = await serve()
    server.script({ body: anthropicBody(GOOD) })
    await new AnthropicSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: KEY }).summarize(REQUEST)
    expect(server.seen[0]?.json?.max_tokens).toBe(16_000)
    expect(server.seen[0]?.json?.output_config).not.toHaveProperty('effort')

    await new AnthropicSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: KEY, effort: 'low' }).summarize(
      REQUEST,
    )
    expect(server.seen[1]?.json?.output_config).toEqual({
      format: { type: 'json_schema', schema: STRICT_SUMMARY_JSON_SCHEMA },
      effort: 'low',
    })
  })

  it('reads the JSON from the text block, even when it is not the first block', async () => {
    const server = await serve()
    server.script({
      body: JSON.stringify({ content: [{ type: 'thinking' }, { type: 'text', text: GOOD }], stop_reason: 'end_turn' }),
    })
    const summarizer = new AnthropicSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: KEY })
    expect(await summarizer.summarize(REQUEST)).toEqual({ ok: true, value: VALID_SUMMARY })
  })

  it('reports a refusal and a cut answer as failed calls', async () => {
    const server = await serve()
    const summarizer = new AnthropicSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: KEY })
    server.script({ body: anthropicBody('', 'refusal') })
    expect(await summarizer.summarize(REQUEST)).toEqual({ ok: false, error: 'anthropic refused to answer' })
    server.script({ body: anthropicBody('{"resumen":"cut', 'max_tokens') })
    expect(await summarizer.summarize(REQUEST)).toEqual({ ok: false, error: 'anthropic cut the answer at max_tokens' })
  })

  it('fails without a key, before any request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await new AnthropicSummarizer({ model: 'm' }).summarize(REQUEST)
    expect(result).toEqual({ ok: false, error: 'no API key for anthropic: set it with "msum secret set anthropic"' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('GeminiSummarizer (RF-40)', () => {
  it('posts to the generateContent path with the key in x-goog-api-key and never in the URL', async () => {
    const server = await serve()
    server.script({ body: geminiBody(GOOD) })
    const summarizer = new GeminiSummarizer({ model: 'gemini-x', baseUrl: server.baseUrl, apiKey: KEY })
    expect(await summarizer.summarize(REQUEST)).toEqual({ ok: true, value: VALID_SUMMARY })
    const sent = server.seen[0]
    expect(sent?.url).toBe('/v1beta/models/gemini-x:generateContent')
    expect(sent?.url).not.toMatch(/key=|api_key/i)
    expect(sent?.url).not.toContain(KEY)
    expect(sent?.headers['x-goog-api-key']).toBe(KEY)
    expect(sent?.json).toEqual({
      systemInstruction: { parts: [{ text: REQUEST.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: REQUEST.transcript }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: STRICT_SUMMARY_JSON_SCHEMA },
    })
  })

  it('joins the parts of the answer', async () => {
    const server = await serve()
    const half = GOOD.length >> 1
    server.script({
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ text: GOOD.slice(0, half) }, { text: GOOD.slice(half) }] } }],
      }),
    })
    const summarizer = new GeminiSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: KEY })
    expect(await summarizer.summarize(REQUEST)).toEqual({ ok: true, value: VALID_SUMMARY })
  })

  it('reports a blocked prompt and an answer with no text as failed calls', async () => {
    const server = await serve()
    const summarizer = new GeminiSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: KEY })
    server.script({ body: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) })
    expect(await summarizer.summarize(REQUEST)).toEqual({ ok: false, error: 'gemini blocked the prompt (SAFETY)' })
    server.script({ body: JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] }) })
    expect(await summarizer.summarize(REQUEST)).toEqual({ ok: false, error: 'gemini returned no text (MAX_TOKENS)' })
  })

  it('fails without a key, before any request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await new GeminiSummarizer({ model: 'm' }).summarize(REQUEST)
    expect(result).toEqual({ ok: false, error: 'no API key for gemini: set it with "msum secret set gemini"' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe.each(providers)('$name: the same prompt for the model, built the same way', (provider) => {
  it('replaces lone surrogates (a truncated chat can split a pair) before sending', async () => {
    const server = await serve()
    server.script({ body: provider.good })
    await provider.make(server, recordingClock(), KEY).summarize({ ...REQUEST, transcript: 'hola \uDE00 chau \uD83D' })
    expect(server.seen[0]?.raw).not.toMatch(/\\ud[89ab]|\\ud[c-f]/i)
    expect(server.seen[0]?.raw).toContain('hola � chau �')
  })

  it('looks the key up at the time of each call, so a new key works without a restart', async () => {
    const server = await serve()
    server.script({ body: provider.good })
    let current = 'first-key-aaaaaaaa'
    const summarizer =
      provider.name === 'openai'
        ? new OpenAiCompatibleSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: () => current })
        : provider.name === 'anthropic'
          ? new AnthropicSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: () => current })
          : new GeminiSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: () => current })
    await summarizer.summarize(REQUEST)
    current = 'second-key-bbbbbbbb'
    await summarizer.summarize(REQUEST)
    const header = (i: number) =>
      String(
        server.seen[i]?.headers.authorization ??
          server.seen[i]?.headers['x-api-key'] ??
          server.seen[i]?.headers['x-goog-api-key'],
      )
    expect(header(0)).toContain('first-key-aaaaaaaa')
    expect(header(1)).toContain('second-key-bbbbbbbb')
  })
})

describe.each(providers)('$name: rate limits (RF-46)', (provider) => {
  it('waits what the provider says and tries again', async () => {
    const server = await serve()
    const clock = recordingClock()
    server.script(
      { status: 429, ...provider.rateLimited[0], body: provider.rateLimited[0]?.body ?? '' },
      { body: provider.good },
    )
    expect(await provider.make(server, clock, KEY).summarize(REQUEST)).toEqual({ ok: true, value: VALID_SUMMARY })
    expect(clock.waits).toEqual([7_000])
    expect(server.seen).toHaveLength(2)
  })

  it('retries an overloaded server (503, 529) with backoff when it gives no hint', async () => {
    const server = await serve()
    const clock = recordingClock()
    server.script(
      { status: 529, body: '{"error":{"message":"overloaded"}}' },
      { status: 503, body: '{}' },
      { body: provider.good },
    )
    expect((await provider.make(server, clock, KEY).summarize(REQUEST)).ok).toBe(true)
    expect(clock.waits).toEqual([500, 1_000])
  })

  it('retries a network error', async () => {
    const server = await serve()
    const clock = recordingClock()
    const summarizer = provider.make(server, clock, KEY)
    await server.close()
    const result = await summarizer.summarize(REQUEST)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('gave up after 3 retries')
    expect(clock.waits).toHaveLength(3)
  })

  it('does not retry a 5xx that is not an overload, nor a 4xx', async () => {
    const server = await serve()
    const clock = recordingClock()
    server.script({ status: 500, body: '{}' })
    expect((await provider.make(server, clock, KEY).summarize(REQUEST)).ok).toBe(false)
    server.script({ status: 400, body: '{}' })
    expect((await provider.make(server, clock, KEY).summarize(REQUEST)).ok).toBe(false)
    expect(clock.waits).toEqual([])
    expect(server.seen).toHaveLength(2)
  })

  it('fails, with its reason, when the retries of the budget are used up', async () => {
    const server = await serve()
    const clock = recordingClock()
    server.script({ status: 429, ...provider.rateLimited[0], body: provider.rateLimited[0]?.body ?? '' })
    const result = await provider.make(server, clock, KEY).summarize(REQUEST)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('429')
    expect(server.seen).toHaveLength(4)
  })
})

describe('where each provider says how long to wait', () => {
  it('Retry-After as an HTTP date', async () => {
    const server = await serve()
    const clock = recordingClock()
    const date = new Date(Date.now() + 10_000).toUTCString()
    server.script({ status: 429, headers: { 'retry-after': date }, body: '{}' }, { body: openaiBody(GOOD) })
    await new OpenAiCompatibleSummarizer({ model: 'm', baseUrl: server.baseUrl, retryClock: clock }).summarize(REQUEST)
    expect(clock.waits).toHaveLength(1)
    expect(clock.waits[0]).toBeGreaterThan(7_000)
    expect(clock.waits[0]).toBeLessThanOrEqual(10_000)
  })

  it('retry-after-ms', async () => {
    const server = await serve()
    const clock = recordingClock()
    server.script({ status: 429, headers: { 'retry-after-ms': '250' }, body: '{}' }, { body: openaiBody(GOOD) })
    await new OpenAiCompatibleSummarizer({ model: 'm', baseUrl: server.baseUrl, retryClock: clock }).summarize(REQUEST)
    expect(clock.waits).toEqual([250])
  })

  it('Anthropic retry-after', async () => {
    const server = await serve()
    const clock = recordingClock()
    server.script(
      { status: 429, headers: { 'retry-after': '3' }, body: '{"type":"error"}' },
      { body: anthropicBody(GOOD) },
    )
    await new AnthropicSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: KEY, retryClock: clock }).summarize(
      REQUEST,
    )
    expect(clock.waits).toEqual([3_000])
  })

  it('Gemini RetryInfo.retryDelay in the error body', async () => {
    const server = await serve()
    const clock = recordingClock()
    const body = JSON.stringify({
      error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2.5s' }] },
    })
    server.script({ status: 429, body }, { body: geminiBody(GOOD) })
    await new GeminiSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: KEY, retryClock: clock }).summarize(
      REQUEST,
    )
    expect(clock.waits).toEqual([2_500])
  })

  it('a wait over the budget fails at once: the conversation is left for the fallback and the report', async () => {
    const server = await serve()
    const clock = recordingClock()
    server.script({ status: 429, headers: { 'retry-after': '3600' }, body: '{}' }, { body: openaiBody(GOOD) })
    const result = await new OpenAiCompatibleSummarizer({
      model: 'm',
      baseUrl: server.baseUrl,
      retryClock: clock,
      retry: { maxRetries: 3, maxTotalWaitMs: 120_000 },
    }).summarize(REQUEST)
    expect(result.ok).toBe(false)
    expect(clock.waits).toEqual([])
    expect(server.seen).toHaveLength(1)
  })

  it('the budget is configurable', async () => {
    const server = await serve()
    const clock = recordingClock()
    server.script({ status: 429, headers: { 'retry-after': '5' }, body: '{}' })
    await new OpenAiCompatibleSummarizer({
      model: 'm',
      baseUrl: server.baseUrl,
      retryClock: clock,
      retry: { maxRetries: 1, maxTotalWaitMs: 60_000 },
    }).summarize(REQUEST)
    expect(server.seen).toHaveLength(2)
  })
})

describe('the hosts the adapters contact (RNF-01)', () => {
  it.each(providers)(
    '$name goes to $host by default, and the network guard stops it in the tests',
    async (provider) => {
      const clock = recordingClock()
      const summarizer =
        provider.name === 'openai'
          ? new OpenAiCompatibleSummarizer({ model: 'm', apiKey: KEY, retryClock: clock })
          : provider.name === 'anthropic'
            ? new AnthropicSummarizer({ model: 'm', apiKey: KEY, retryClock: clock })
            : new GeminiSummarizer({ model: 'm', apiKey: KEY, retryClock: clock })
      const result = await summarizer.summarize(REQUEST)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain(`Undeclared network call to ${provider.host}`)
        expect(result.error).not.toContain(KEY)
      }
    },
  )
})
