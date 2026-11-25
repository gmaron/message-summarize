import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Answerer } from '../../../src/application/ports/answerer.js'
import type { Summarizer } from '../../../src/application/ports/summarizer.js'
import {
  AnthropicSummarizer,
  composeSummarizer,
  GeminiSummarizer,
  OpenAiCompatibleSummarizer,
  redactSecrets,
} from '../../../src/infrastructure/llm/index.js'
import { createLogger } from '../../../src/main/logging/logger.js'
import { REQUEST } from '../../contract/summarizer.contract.js'
import { type FakeServer, startFakeServer } from '../../support/fake-http-server.js'

// RNF-04: a provider can echo the key in an error ("Incorrect API key provided: ..."). Whatever an adapter returns or
// throws, the key must not be in it, and so it cannot reach a log, stdout or stderr.

const KEY = 'sk-live-ABCDEF0123456789SECRETKEY'
const NO_WAIT = { sleep: async () => {}, random: () => 0 }

const servers: FakeServer[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const echoBodies = [
  JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. You can find your key at ...` } }),
  `plain text that also says ${KEY}`,
  JSON.stringify({ error: { message: 'bad key sk-other-ZZZZZZZZZZZZZZ (a different one, but shaped like a key)' } }),
]

async function adapters(): Promise<{ name: string; summarizer: Summarizer; server: FakeServer }[]> {
  const make = async (name: string, build: (baseUrl: string) => Summarizer) => {
    const server = await startFakeServer()
    servers.push(server)
    return { name, summarizer: build(server.baseUrl), server }
  }
  return [
    await make(
      'openai',
      (baseUrl) => new OpenAiCompatibleSummarizer({ model: 'm', baseUrl, apiKey: KEY, retryClock: NO_WAIT }),
    ),
    await make(
      'anthropic',
      (baseUrl) => new AnthropicSummarizer({ model: 'm', baseUrl, apiKey: KEY, retryClock: NO_WAIT }),
    ),
    await make('gemini', (baseUrl) => new GeminiSummarizer({ model: 'm', baseUrl, apiKey: KEY, retryClock: NO_WAIT })),
  ]
}

describe('redactSecrets', () => {
  it('removes the key wherever it appears, and anything shaped like a key', () => {
    const text = `a ${KEY} b ${KEY} c sk-another-1234567890 d AIzaSyA1234567890abcdefghijk`
    const clean = redactSecrets(text, [KEY, undefined, ''])
    expect(clean).not.toContain(KEY)
    expect(clean).not.toContain('sk-another')
    expect(clean).not.toContain('AIzaSy')
    expect(clean).toContain('[redacted]')
  })
})

// Keys that match neither the sk- nor the AIza shape: only the exact removal of the configured key can catch them.
const PLAIN_KEY = 'not-a-real-key-aaaa'
const OTHER_KEY = 'another-fake-key-bbbb'

describe('redactSecrets removes the exact secret, whatever its shape', () => {
  it('removes a key that matches no known shape', () => {
    expect(redactSecrets(`bad key ${PLAIN_KEY}`, [PLAIN_KEY])).toBe('bad key [redacted]')
  })

  it('removes every occurrence of a secret', () => {
    expect(redactSecrets(`${PLAIN_KEY} and ${PLAIN_KEY}, again ${PLAIN_KEY}`, [PLAIN_KEY])).toBe(
      '[redacted] and [redacted], again [redacted]',
    )
  })

  it('removes several secrets', () => {
    const clean = redactSecrets(`a ${PLAIN_KEY} b ${OTHER_KEY} c`, [PLAIN_KEY, OTHER_KEY])
    expect(clean).toBe('a [redacted] b [redacted] c')
  })

  it('skips an undefined or empty secret without touching the text, and still removes the others', () => {
    expect(redactSecrets('nothing to hide', [undefined, ''])).toBe('nothing to hide')
    expect(redactSecrets('nothing to hide', [])).toBe('nothing to hide')
    expect(redactSecrets(`x ${PLAIN_KEY} y`, [undefined, '', PLAIN_KEY, undefined])).toBe('x [redacted] y')
  })

  it('leaves text that has no secret as it is', () => {
    expect(redactSecrets('rate limit, try later', [PLAIN_KEY])).toBe('rate limit, try later')
  })
})

describe('each API adapter passes its own key to the redaction', () => {
  const echo = JSON.stringify({ error: { message: `Invalid credentials ${PLAIN_KEY} rejected` } })
  const cases: [string, (baseUrl: string) => Summarizer & Answerer][] = [
    [
      'openai',
      (baseUrl) => new OpenAiCompatibleSummarizer({ model: 'm', baseUrl, apiKey: PLAIN_KEY, retryClock: NO_WAIT }),
    ],
    [
      'anthropic',
      (baseUrl) => new AnthropicSummarizer({ model: 'm', baseUrl, apiKey: PLAIN_KEY, retryClock: NO_WAIT }),
    ],
    ['gemini', (baseUrl) => new GeminiSummarizer({ model: 'm', baseUrl, apiKey: PLAIN_KEY, retryClock: NO_WAIT })],
    [
      'openai with a key from a function',
      (baseUrl) =>
        new OpenAiCompatibleSummarizer({ model: 'm', baseUrl, apiKey: () => PLAIN_KEY, retryClock: NO_WAIT }),
    ],
  ]

  it.each(cases)('%s: the error of a summary and of an answer has no key', async (_name, build) => {
    const server = await startFakeServer()
    servers.push(server)
    const adapter = build(server.baseUrl)
    server.script({ status: 401, body: echo })
    const summary = await adapter.summarize(REQUEST)
    expect(summary.ok).toBe(false)
    if (!summary.ok) {
      expect(summary.error).not.toContain(PLAIN_KEY)
      expect(summary.error).toContain('[redacted]')
    }
    server.script({ status: 401, body: echo })
    const answer = await adapter.answer({ systemPrompt: 's', input: 'i' })
    expect(answer.ok).toBe(false)
    if (!answer.ok) {
      expect(answer.error).not.toContain(PLAIN_KEY)
      expect(answer.error).toContain('[redacted]')
    }
  })
})

describe('a key echoed by the provider never reaches an error, a log, stdout or stderr', () => {
  it.each(echoBodies.map((body, index) => [index, body] as const))('error body %#', async (_index, body) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const lines: string[] = []
    const sink = { write: (text: string) => lines.push(text) }
    const logger = createLogger(sink, sink)

    for (const { name, summarizer, server } of await adapters()) {
      // every status the adapters handle differently: a plain error, a rate limit that is retried, an overload
      for (const status of [400, 401, 429, 529, 500]) {
        server.script({ status, body })
        const result = await summarizer.summarize(REQUEST)
        expect(result.ok, `${name} ${status}`).toBe(false)
        if (!result.ok) {
          expect(result.error, `${name} ${status}`).not.toContain(KEY)
          expect(result.error).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/)
          logger.warn('summary.failed', { reason: result.error })
        }
      }
      // a 200 whose content is the key
      server.script({ body })
      const odd = await summarizer.summarize(REQUEST)
      if (!odd.ok) expect(odd.error).not.toContain(KEY)
    }

    // the same, through the real composition (primary and backup both failing, errors joined)
    const [first, second] = await adapters()
    if (first && second) {
      first.server.script({ status: 401, body })
      second.server.script({ status: 401, body })
      const composed = composeSummarizer({
        primary: first.summarizer,
        backup: second.summarizer,
        localOnlyPatterns: [],
      })
      const result = await composed.summarize(REQUEST)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).not.toContain(KEY)
    }

    const everything = [
      ...lines,
      ...stdout.mock.calls.map((call) => String(call[0])),
      ...stderr.mock.calls.map((call) => String(call[0])),
    ].join('\n')
    expect(everything).not.toContain(KEY)
  })

  it('also when the key comes from a function and the network error mentions it', async () => {
    const summarizer = new OpenAiCompatibleSummarizer({
      model: 'm',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: () => KEY,
      retryClock: NO_WAIT,
    })
    const result = await summarizer.summarize(REQUEST)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).not.toContain(KEY)
  })

  it('the logger drops any field that is not in its allowlist, so a provider body cannot be added to a log line', () => {
    const lines: string[] = []
    const sink = { write: (text: string) => lines.push(text) }
    createLogger(sink, sink).warn('summary.failed', { body: KEY, response: KEY } as never)
    expect(lines.join('')).not.toContain(KEY)
  })
})
