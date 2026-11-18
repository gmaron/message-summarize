import { afterEach, describe, expect, it } from 'vitest'
import type { SummarizeRequest, Summarizer } from '../../../src/application/ports/summarizer.js'
import {
  AnthropicSummarizer,
  composeSummarizer,
  GeminiSummarizer,
  LOCAL_ONLY_UNAVAILABLE,
  OllamaSummarizer,
  OpenAiCompatibleSummarizer,
} from '../../../src/infrastructure/llm/index.js'
import { type AppConfig, parseConfig } from '../../../src/main/config.js'
import { buildSummarizer } from '../../../src/main/providers.js'
import { VALID_SUMMARY } from '../../contract/summarizer.contract.js'
import { type FakeServer, startFakeServer } from '../../support/fake-http-server.js'

// RF-43: all three API providers are EXTERNAL, an OpenAI-compatible server on localhost included (a URL cannot be
// verified to stay local: proxies, DNS). "Local only" is Ollama only.

const NO_WAIT = { sleep: async () => {}, random: () => 0 }
const GOOD_BODIES = {
  openai: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_SUMMARY) } }] }),
  anthropic: JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(VALID_SUMMARY) }],
    stop_reason: 'end_turn',
  }),
  gemini: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(VALID_SUMMARY) }] } }] }),
} as const
type Kind = keyof typeof GOOD_BODIES

const request = (name: string): SummarizeRequest => ({
  conversation: { id: `${name.toLowerCase().replace(/\W/g, '')}@s.whatsapp.net`, name, isGroup: false },
  systemPrompt: 'prompt',
  transcript: `Chat con: ${name}\n\n${name}: el PIN del banco es 0000`,
})

const servers: FakeServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function fake(kind: Kind): Promise<{ summarizer: Summarizer; server: FakeServer }> {
  const server = await startFakeServer()
  servers.push(server)
  server.script({ body: GOOD_BODIES[kind] })
  const summarizer: Summarizer =
    kind === 'openai'
      ? new OpenAiCompatibleSummarizer({ model: 'm', baseUrl: server.baseUrl, retryClock: NO_WAIT })
      : kind === 'anthropic'
        ? new AnthropicSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: 'k-test-123456', retryClock: NO_WAIT })
        : new GeminiSummarizer({ model: 'm', baseUrl: server.baseUrl, apiKey: 'k-test-123456', retryClock: NO_WAIT })
  return { summarizer, server }
}

describe.each(['openai', 'anthropic', 'gemini'] as const)('%s is external (RF-43)', (kind) => {
  it('a local-only conversation never reaches it when Ollama is missing: it is skipped and reported', async () => {
    const { summarizer, server } = await fake(kind)
    const composed = composeSummarizer({ primary: summarizer, localOnlyPatterns: ['banco'] })
    expect(await composed.summarize(request('Banco Ana'))).toEqual({ ok: false, error: LOCAL_ONLY_UNAVAILABLE })
    expect(server.seen).toHaveLength(0)
  })

  it('nor when it is the primary AND the backup', async () => {
    const { summarizer, server } = await fake(kind)
    const composed = composeSummarizer({ primary: summarizer, backup: summarizer, localOnlyPatterns: ['banco'] })
    expect((await composed.summarize(request('Banco Ana'))).ok).toBe(false)
    expect(server.seen).toHaveLength(0)
  })

  it('nor when Ollama is there but fails', async () => {
    const { summarizer, server } = await fake(kind)
    const ollama = new OllamaSummarizer({ model: 'm', baseUrl: 'http://127.0.0.1:1' })
    const composed = composeSummarizer({
      primary: summarizer,
      backup: summarizer,
      local: ollama,
      localOnlyPatterns: ['banco'],
    })
    const result = await composed.summarize(request('Banco Ana'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/^could not reach ollama/)
    expect(server.seen).toHaveLength(0)
  })

  it('an ordinary conversation does reach it', async () => {
    const { summarizer, server } = await fake(kind)
    const composed = composeSummarizer({ primary: summarizer, localOnlyPatterns: ['banco'] })
    expect(await composed.summarize(request('Trabajo'))).toMatchObject({ ok: true, value: VALID_SUMMARY })
    expect(server.seen).toHaveLength(1)
  })
})

describe('buildSummarizer with the API providers', () => {
  const config = (provider: Record<string, unknown>): AppConfig => {
    const parsed = parseConfig(
      {
        localOnlyPatterns: ['banco'],
        provider: { ollama: { model: 'qwen', baseUrl: 'http://127.0.0.1:1' }, ...provider },
      },
      'UTC',
    )
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
    return parsed.value
  }

  it('an OpenAI-compatible server on localhost is external too: a local-only chat goes to Ollama, not to it', async () => {
    const server = await startFakeServer()
    servers.push(server)
    server.script({ body: GOOD_BODIES.openai })
    const summarizer = buildSummarizer(
      config({ primary: 'openai', openai: { model: 'm', baseUrl: server.baseUrl } }),
      {},
    )
    const result = await summarizer?.summarize(request('Banco Ana'))
    expect(result?.ok).toBe(false)
    if (result && !result.ok) expect(result.error).toMatch(/^could not reach ollama/)
    expect(server.seen).toHaveLength(0)

    expect((await summarizer?.summarize(request('Trabajo')))?.ok).toBe(true)
    expect(server.seen).toHaveLength(1)
  })

  it.each([
    ['anthropic', 'ANTHROPIC_API_KEY', 'api.anthropic.com'],
    ['gemini', 'GEMINI_API_KEY', 'generativelanguage.googleapis.com'],
  ] as const)(
    '%s: a local-only chat goes to Ollama; an ordinary one is sent to %s (stopped by the guard here)',
    async (kind, variable, host) => {
      const summarizer = buildSummarizer(config({ primary: kind, [kind]: { model: 'm' } }), {
        [variable]: 'k-test-123456',
      })
      const local = await summarizer?.summarize(request('Banco Ana'))
      expect(local?.ok).toBe(false)
      if (local && !local.ok) expect(local.error).toMatch(/^could not reach ollama/)

      // the retry waits are real here (backoff), so the budget is set to zero retries
      const external = buildSummarizer(config({ primary: kind, [kind]: { model: 'm' }, retry: { maxRetries: 0 } }), {
        [variable]: 'k-test-123456',
      })
      const ordinary = await external?.summarize(request('Trabajo'))
      expect(ordinary?.ok).toBe(false)
      if (ordinary && !ordinary.ok) expect(ordinary.error).toContain(host)
    },
  )

  it('reports a missing key as a failed call, naming the command that fixes it', async () => {
    const summarizer = buildSummarizer(config({ primary: 'anthropic', anthropic: { model: 'm' } }), {})
    const result = await summarizer?.summarize(request('Trabajo'))
    expect(result).toEqual({ ok: false, error: 'no API key for anthropic: set it with "msum secret set anthropic"' })
  })

  it('takes the key from the secrets files, the account one first', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'msum-prov-'))
    try {
      const installationSecretsFile = join(dir, 'root.json')
      const secretsFile = join(dir, 'account.json')
      writeFileSync(installationSecretsFile, JSON.stringify({ 'openai-compatible': 'root-key-0000' }))
      writeFileSync(secretsFile, JSON.stringify({ 'openai-compatible': 'account-key-1111' }))
      const server = await startFakeServer()
      servers.push(server)
      server.script({ body: GOOD_BODIES.openai })
      const summarizer = buildSummarizer(
        config({ primary: 'openai', openai: { model: 'm', baseUrl: server.baseUrl } }),
        {},
        { secretsFile, installationSecretsFile },
      )
      await summarizer?.summarize(request('Trabajo'))
      expect(server.seen[0]?.headers.authorization).toBe('Bearer account-key-1111')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the stored "openai" key (account and installation) is never sent to a custom baseUrl: no Authorization at all', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'msum-prov-'))
    try {
      const installationSecretsFile = join(dir, 'root.json')
      const secretsFile = join(dir, 'account.json')
      writeFileSync(installationSecretsFile, JSON.stringify({ openai: 'real-openai-root-0000' }))
      writeFileSync(secretsFile, JSON.stringify({ openai: 'real-openai-account-1111' }))
      const server = await startFakeServer()
      servers.push(server)
      server.script({ body: GOOD_BODIES.openai })
      const summarizer = buildSummarizer(
        config({ primary: 'openai', openai: { model: 'm', baseUrl: server.baseUrl } }),
        { MSUM_OPENAI_API_KEY: '', OPENAI_API_KEY: 'real-openai-env-2222' },
        { secretsFile, installationSecretsFile },
      )
      await summarizer?.summarize(request('Trabajo'))
      expect(server.seen[0]?.headers.authorization).toBeUndefined()
      expect(server.seen[0]?.raw).not.toContain('real-openai')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an origin that is not exactly https://api.openai.com is a compatible server, whatever its host looks like', async () => {
    const { isOpenAiHost } = await import('../../../src/infrastructure/llm/index.js')
    expect(isOpenAiHost('https://api.openai.com/v1')).toBe(true)
    expect(isOpenAiHost('http://api.openai.com/v1')).toBe(false)
    expect(isOpenAiHost('https://api.openai.com:8443/v1')).toBe(false)
    expect(isOpenAiHost('https://api.openai.com.evil.example/v1')).toBe(false)
    expect(isOpenAiHost('not a url')).toBe(false)
  })

  it('does not send OPENAI_API_KEY to a server that is not api.openai.com', async () => {
    const server = await startFakeServer()
    servers.push(server)
    server.script({ body: GOOD_BODIES.openai })
    const summarizer = buildSummarizer(config({ primary: 'openai', openai: { model: 'm', baseUrl: server.baseUrl } }), {
      OPENAI_API_KEY: 'my-real-openai-key-999',
    })
    await summarizer?.summarize(request('Trabajo'))
    expect(server.seen[0]?.headers.authorization).toBeUndefined()
    expect(server.seen[0]?.raw).not.toContain('my-real-openai-key')
  })
})
