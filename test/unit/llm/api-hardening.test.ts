import { afterEach, describe, expect, it } from 'vitest'
import type { Summarizer } from '../../../src/application/ports/summarizer.js'
import {
  AnthropicSummarizer,
  GeminiSummarizer,
  MAX_RESPONSE_BYTES,
  OpenAiCompatibleSummarizer,
  RESPONSE_TOO_LARGE,
  readBodyCapped,
} from '../../../src/infrastructure/llm/index.js'
import { REQUEST, VALID_SUMMARY } from '../../contract/summarizer.contract.js'
import { type FakeServer, startFakeServer } from '../../support/fake-http-server.js'

const KEY = 'sk-hardening-0123456789abcdef'
const NO_WAIT = { sleep: async () => {}, random: () => 0 }
const GOOD = JSON.stringify(VALID_SUMMARY)

const servers: FakeServer[] = []
const serve = async (): Promise<FakeServer> => {
  const server = await startFakeServer()
  servers.push(server)
  return server
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const kinds = ['openai', 'anthropic', 'gemini'] as const
const make = (kind: (typeof kinds)[number], baseUrl: string, extra: Record<string, unknown> = {}): Summarizer => {
  const common = { model: 'm', apiKey: KEY, retryClock: NO_WAIT, ...extra }
  if (kind === 'openai') return new OpenAiCompatibleSummarizer({ ...common, baseUrl })
  if (kind === 'anthropic') return new AnthropicSummarizer({ ...common, baseUrl })
  return new GeminiSummarizer({ ...common, baseUrl })
}

describe.each(kinds)('%s: redirects are never followed (RNF-01)', (kind) => {
  it.each([307, 308, 302])(
    'a %i to another server fails the call, and the other server gets nothing',
    async (status) => {
      const target = await serve()
      target.script({ body: GOOD })
      const origin = await serve()
      origin.script({ status, headers: { location: `${target.baseUrl}/elsewhere` }, body: '' })
      const result = await make(kind, origin.baseUrl).summarize(REQUEST)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('redirect')
        expect(result.error).not.toContain(KEY)
      }
      expect(target.seen).toHaveLength(0)
      // a redirect is not a network error: it is not retried
      expect(origin.seen).toHaveLength(1)
    },
  )
})

describe('readBodyCapped', () => {
  const chunkSize = 64 * 1024

  it('reads a body under the cap as text, and a missing body as empty', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hola '))
        controller.enqueue(new TextEncoder().encode('chau'))
        controller.close()
      },
    })
    expect(await readBodyCapped(stream)).toBe('hola chau')
    expect(await readBodyCapped(null)).toBe('')
  })

  it('stops at the cap, cancels the stream, and never holds more than the cap plus one chunk', async () => {
    let pulledBytes = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulledBytes += chunkSize
          controller.enqueue(new Uint8Array(chunkSize))
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    const cap = 1024 * 1024
    expect(await readBodyCapped(stream, cap)).toBeNull()
    expect(cancelled).toBe(true)
    expect(pulledBytes).toBeGreaterThan(cap)
    expect(pulledBytes).toBeLessThanOrEqual(cap + chunkSize)
  })

  it('the cap is 2 MB', () => {
    expect(MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024)
  })
})

describe.each(kinds)('%s: a response over the size cap', (kind) => {
  it.each([200, 500, 429])(
    'an oversized body (status %i) fails with response-too-large and is not retried',
    async (status) => {
      const server = await serve()
      server.script({ status, body: ' '.repeat(MAX_RESPONSE_BYTES + 10) })
      const result = await make(kind, server.baseUrl).summarize(REQUEST)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain(RESPONSE_TOO_LARGE)
      expect(server.seen).toHaveLength(1)
    },
  )

  it.each([200, 500])('an endless body (status %i) is cut at the cap: the server is not drained', async (status) => {
    const server = await serve()
    server.script({ endless: true, status })
    const result = await make(kind, server.baseUrl).summarize(REQUEST)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(RESPONSE_TOO_LARGE)
    await new Promise((resolve) => setTimeout(resolve, 100))
    // the client stopped reading: backpressure and the closed connection keep the server far from endless
    expect(server.endlessBytes()).toBeLessThan(16 * 1024 * 1024)
  })
})

describe('Gemini thought parts', () => {
  it('ignores parts with thought: true when it joins the text', async () => {
    const server = await serve()
    server.script({
      body: JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Voy a pensar cómo resumir esto { no es JSON', thought: true },
                { text: GOOD },
                { text: 'otro pensamiento', thought: true },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
    })
    const result = await new GeminiSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: KEY }).summarize(REQUEST)
    expect(result).toEqual({ ok: true, value: VALID_SUMMARY })
  })

  it('fails when only thought parts came back', async () => {
    const server = await serve()
    server.script({ body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] }) })
    const result = await new GeminiSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: KEY }).summarize(REQUEST)
    expect(result.ok).toBe(false)
  })
})

describe.each(kinds)('%s: the total deadline of a call', (kind) => {
  it('an attempt never outlives it, even when the timeout of the attempt is longer', async () => {
    const server = await serve()
    server.script({ hang: true })
    const started = Date.now()
    const result = await make(kind, server.baseUrl, {
      timeoutMs: 60_000,
      retry: { maxRetries: 3, maxTotalWaitMs: 1000, maxTotalMs: 200 },
    }).summarize(REQUEST)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('total time limit')
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
