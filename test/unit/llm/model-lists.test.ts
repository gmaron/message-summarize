import { describe, expect, it } from 'vitest'
import { FALLBACK_MODELS } from '../../../src/infrastructure/llm/model-fallbacks.js'
import {
  anthropicModels,
  CLAUDE_CLI_MODELS,
  geminiModels,
  listProviderModels,
  openAiModels,
} from '../../../src/infrastructure/llm/model-lists.js'

// Made up: shaped like a key, worth nothing.
const KEY = 'sk-test-AAAAAAAAAAAAAAAAAAAAAAAA-FAKE'

interface Seen {
  url: string
  headers: Record<string, string>
  redirect: string | undefined
  method: string | undefined
}

/** A fetch that answers `body` (or `status`) and remembers what it was asked. */
function fakeFetch(answer: { status?: number; body?: unknown; raw?: string; throws?: Error }) {
  const seen: Seen[] = []
  const fn = (async (input: unknown, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      redirect: init?.redirect,
      method: init?.method,
    })
    if (answer.throws !== undefined) throw answer.throws
    return new Response(answer.raw ?? JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 })
  }) as typeof fetch
  return { fn, seen }
}

const OPENAI_BODY = {
  data: [
    { id: 'text-embedding-3-small', created: 1_700_000_100 },
    { id: 'gpt-4o-mini', created: 1_700_000_300 },
    { id: 'whisper-1', created: 1_700_000_050 },
    { id: 'gpt-4o-realtime-preview', created: 1_700_000_900 },
    { id: 'tts-1', created: 1_700_000_060 },
    { id: 'gpt-4o-audio-preview', created: 1_700_000_800 },
    { id: 'dall-e-3', created: 1_700_000_070 },
    { id: 'omni-moderation-latest', created: 1_700_000_080 },
    { id: 'gpt-image-1', created: 1_700_000_090 },
    { id: 'gpt-4o', created: 1_700_000_500 },
    { id: 'o3-mini', created: 1_700_000_700 },
    { id: 'gpt-3.5-turbo-instruct', created: 1_700_000_010 },
    { id: 'babbage-002', created: 1_700_000_001 },
    { id: 'o1-pro', created: 1_700_000_950 },
    { id: 'o3-deep-research', created: 1_700_000_960 },
    { id: 'gpt-5-codex', created: 1_700_000_970 },
    { id: 'computer-use-preview', created: 1_700_000_980 },
    { id: 'gpt-4o-search-preview', created: 1_700_000_990 },
  ],
}

describe('the models of OpenAI', () => {
  it('keeps the chat families, drops the models of other jobs and the ones /chat/completions cannot use (pro, deep research, codex, computer use, search), newest first', () => {
    expect(openAiModels(OPENAI_BODY, true).map((m) => m.id)).toEqual(['o3-mini', 'gpt-4o', 'gpt-4o-mini'])
  })

  it('does not filter a compatible server (it cannot be known what its models do), and sorts the same date by name', () => {
    const body = { data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'nomic-embed-text' }] }
    expect(openAiModels(body, false).map((m) => m.id)).toEqual(['alpha', 'nomic-embed-text', 'zeta'])
  })

  it('ignores what is not a list, and entries with no id', () => {
    expect(openAiModels(null, true)).toEqual([])
    expect(openAiModels({ data: 'x' }, true)).toEqual([])
    expect(openAiModels({ data: [null, { created: 1 }, { id: 7 }] }, true)).toEqual([])
  })
})

describe('the models of Anthropic', () => {
  it('keeps all of them, with their friendly name, newest first', () => {
    const body = {
      data: [
        { id: 'claude-old', display_name: 'Claude Old', created_at: '2025-01-01T00:00:00Z' },
        { id: 'claude-new', display_name: 'Claude New', created_at: '2026-06-01T00:00:00Z' },
        { id: 'claude-nodate' },
      ],
    }
    expect(anthropicModels(body)).toEqual([
      { id: 'claude-new', name: 'Claude New' },
      { id: 'claude-old', name: 'Claude Old' },
      { id: 'claude-nodate' },
    ])
  })
})

describe('the models of Gemini', () => {
  const body = {
    models: [
      {
        name: 'models/gemini-2.0-flash',
        displayName: 'Gemini 2.0 Flash',
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/imagen-3.0-generate', supportedGenerationMethods: ['predict'] },
      { name: 'models/veo-2', supportedGenerationMethods: ['predictLongRunning'] },
      { name: 'models/gemini-embedding-exp', supportedGenerationMethods: ['generateContent', 'embedContent'] },
      { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
    ],
  }

  it('keeps the models that generate content and are not embedding, image or video ones, highest version first', () => {
    expect(geminiModels(body)).toEqual([
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
    ])
  })
})

describe('listing the models of a provider', () => {
  it('asks OpenAI with the key in a header only, with no redirects, and answers the filtered list', async () => {
    const { fn, seen } = fakeFetch({ body: OPENAI_BODY })
    const result = await listProviderModels('openai', { key: KEY, fetch: fn })
    expect(result.ok && result.value.map((m) => m.id)).toEqual(['o3-mini', 'gpt-4o', 'gpt-4o-mini'])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.openai.com/v1/models')
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(seen[0]?.url).not.toContain(KEY)
    expect(seen[0]?.redirect).toBe('error')
    expect(seen[0]?.method).toBe('GET')
  })

  it('asks Anthropic and Gemini at their own hosts, with their own key headers', async () => {
    const a = fakeFetch({ body: { data: [{ id: 'claude-x' }] } })
    expect((await listProviderModels('anthropic', { key: KEY, fetch: a.fn })).ok).toBe(true)
    expect(a.seen[0]?.url.startsWith('https://api.anthropic.com/v1/models')).toBe(true)
    expect(a.seen[0]?.headers['x-api-key']).toBe(KEY)
    expect(a.seen[0]?.headers['anthropic-version']).toBeTruthy()
    const g = fakeFetch({
      body: { models: [{ name: 'models/gemini-x', supportedGenerationMethods: ['generateContent'] }] },
    })
    expect((await listProviderModels('gemini', { key: KEY, fetch: g.fn })).ok).toBe(true)
    expect(g.seen[0]?.url.startsWith('https://generativelanguage.googleapis.com/v1beta/models')).toBe(true)
    expect(g.seen[0]?.headers['x-goog-api-key']).toBe(KEY)
    expect(g.seen[0]?.url).not.toContain(KEY)
  })

  it('asks a compatible server at its own address, with no key needed', async () => {
    const { fn, seen } = fakeFetch({ body: { data: [{ id: 'local-model' }] } })
    const result = await listProviderModels('openai', { baseUrl: 'http://localhost:1234/v1/', fetch: fn })
    expect(result).toEqual({ ok: true, value: [{ id: 'local-model' }] })
    expect(seen[0]?.url).toBe('http://localhost:1234/v1/models')
    expect(seen[0]?.headers.authorization).toBeUndefined()
  })

  it('says noKey without any request when a provider that needs a key has none', async () => {
    for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
      const { fn, seen } = fakeFetch({ body: {} })
      expect(await listProviderModels(provider, { fetch: fn })).toEqual({ ok: false, error: 'noKey' })
      expect(await listProviderModels(provider, { key: '', fetch: fn })).toEqual({ ok: false, error: 'noKey' })
      expect(seen).toEqual([])
    }
  })

  it('reduces every failure to a code that holds neither the key nor anything the provider said', async () => {
    const echo = `Incorrect API key provided: ${KEY}`
    const cases: Array<[string, Parameters<typeof fakeFetch>[0], string]> = [
      ['a rejected key', { status: 401, raw: echo }, 'rejected'],
      ['a forbidden one', { status: 403, raw: echo }, 'rejected'],
      ['a server error', { status: 500, raw: echo }, 'failed'],
      ['a body that is not JSON', { raw: `not json ${KEY}` }, 'failed'],
      ['a body that is not a list', { body: { hello: KEY } }, 'failed'],
      ['an empty list', { body: { data: [] } }, 'failed'],
      ['a list that is too big', { raw: 'x'.repeat(2_000_001) }, 'failed'],
      ['a network error', { throws: new Error(`connect failed with ${KEY}`) }, 'unreachable'],
      ['a timeout', { throws: Object.assign(new Error('t'), { name: 'TimeoutError' }) }, 'unreachable'],
      [
        'a refused redirect',
        { throws: new TypeError('fetch failed', { cause: new Error('redirect mode is set to error') }) },
        'unreachable',
      ],
    ]
    for (const [label, answer, code] of cases) {
      const { fn } = fakeFetch(answer)
      const result = await listProviderModels('openai', { key: KEY, fetch: fn })
      expect(result, label).toEqual({ ok: false, error: code })
      expect(JSON.stringify(result), label).not.toContain(KEY)
    }
  })

  it('has fixed aliases for Claude Code and a fallback list for Anthropic only (OpenAI and Gemini have none on purpose)', () => {
    expect(CLAUDE_CLI_MODELS.map((m) => m.id)).toEqual(['sonnet', 'opus', 'haiku'])
    expect(FALLBACK_MODELS.anthropic.map((m) => m.id)).toEqual([
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-opus-5-5',
    ])
    expect(Object.keys(FALLBACK_MODELS)).toEqual(['anthropic'])
  })

  it('reads the body with a byte limit and cuts the stream when it passes it, with or without a length header', async () => {
    let pulled = 0
    let cancelled = false
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(500_000).fill(120))
      },
      cancel() {
        cancelled = true
      },
    })
    const fn = (async () => new Response(endless, { status: 200 })) as typeof fetch
    expect(await listProviderModels('openai', { key: KEY, fetch: fn })).toEqual({ ok: false, error: 'failed' })
    expect(cancelled).toBe(true)
    // It stopped soon after the limit: it did not read an endless body.
    expect(pulled).toBeLessThanOrEqual(8)
  })
})
