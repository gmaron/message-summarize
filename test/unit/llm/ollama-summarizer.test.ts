import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { OllamaSummarizer, SUMMARY_JSON_SCHEMA } from '../../../src/infrastructure/llm/index.js'

// The network guard already lets loopback through (127.0.0.1), so this test needs no allowNetwork(): the server is
// bound to 127.0.0.1 and the adapter is pointed at it. Nothing leaves the machine.

const VALID = { resumen: 'Hablaron de la cena.', pendientes: [], necesita_respuesta: false, prioridad: 'baja' }
const request = {
  conversation: { id: 'c1', name: 'Ana', isGroup: false },
  systemPrompt: 'Sistema',
  transcript: 'Chat con: Ana\n\nAna: hola',
}

let server: Server | undefined
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

async function listen(handler: (req: IncomingMessage, body: string, res: import('node:http').ServerResponse) => void) {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => {
      body += d
    })
    req.on('end', () => handler(req, body, res))
  })
  const started = server
  await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(started.address() as AddressInfo).port}`
}

describe('OllamaSummarizer (RF-40)', () => {
  it('posts to /api/chat with the schema as format, stream false and the model', async () => {
    let seen: { method?: string; url?: string; body: Record<string, unknown> } | undefined
    const baseUrl = await listen((req, body, res) => {
      seen = { method: req.method, url: req.url, body: JSON.parse(body) }
      res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(VALID) } }))
    })
    const result = await new OllamaSummarizer({ model: 'qwen3:4b', baseUrl: `${baseUrl}/` }).summarize(request)
    expect(result).toEqual({ ok: true, value: VALID })
    expect(seen?.method).toBe('POST')
    expect(seen?.url).toBe('/api/chat')
    expect(seen?.body).toEqual({
      model: 'qwen3:4b',
      stream: false,
      think: false,
      keep_alive: '1m',
      format: SUMMARY_JSON_SCHEMA,
      options: { temperature: 0.2, num_ctx: 16384 },
      messages: [
        { role: 'system', content: 'Sistema' },
        { role: 'user', content: request.transcript },
      ],
    })
  })

  it('sends the configured num_ctx and keep_alive', async () => {
    let body: Record<string, unknown> = {}
    const baseUrl = await listen((_req, raw, res) => {
      body = JSON.parse(raw)
      res.end(JSON.stringify({ message: { content: JSON.stringify(VALID) } }))
    })
    await new OllamaSummarizer({ model: 'm', baseUrl, numCtx: 4096, keepAlive: '10m' }).summarize(request)
    expect(body.keep_alive).toBe('10m')
    expect(body.options).toEqual({ temperature: 0.2, num_ctx: 4096 })
  })

  it('reports a body that is not JSON without quoting it', async () => {
    const baseUrl = await listen((_req, _body, res) => res.end('<html>SECRETO-DEL-CHAT</html>'))
    const result = await new OllamaSummarizer({ model: 'm', baseUrl }).summarize(request)
    expect(result).toEqual({ ok: false, error: 'ollama returned a body that is not JSON' })
  })

  it('returns an error on a non-2xx status', async () => {
    const baseUrl = await listen((_req, _body, res) => {
      res.statusCode = 500
      res.end('model not found')
    })
    const result = await new OllamaSummarizer({ model: 'm', baseUrl }).summarize(request)
    expect(result).toEqual({ ok: false, error: 'ollama answered 500: model not found' })
  })

  it('returns an error when the content is not JSON', async () => {
    const baseUrl = await listen((_req, _body, res) => res.end(JSON.stringify({ message: { content: 'hola' } })))
    expect(await new OllamaSummarizer({ model: 'm', baseUrl }).summarize(request)).toEqual({
      ok: false,
      error: 'ollama returned content that is not JSON',
    })
  })

  it('returns an error when there is no message content', async () => {
    const baseUrl = await listen((_req, _body, res) => res.end('{}'))
    expect(await new OllamaSummarizer({ model: 'm', baseUrl }).summarize(request)).toEqual({
      ok: false,
      error: 'ollama returned no message content',
    })
  })

  it('times out', async () => {
    const baseUrl = await listen(() => {})
    const result = await new OllamaSummarizer({ model: 'm', baseUrl, timeoutMs: 100 }).summarize(request)
    expect(result).toEqual({ ok: false, error: 'ollama timed out after 0.1s' })
  })

  it('reports an unreachable server', async () => {
    const baseUrl = await listen((_req, _body, res) => res.end('{}'))
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    const result = await new OllamaSummarizer({ model: 'm', baseUrl }).summarize(request)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/^could not reach ollama/)
  })

  it('defaults to the local Ollama address, and the guard rejects any other host', async () => {
    // Pointing it at an external host must fail at the guard, proving nothing else is contacted.
    const result = await new OllamaSummarizer({ model: 'm', baseUrl: 'https://example.com' }).summarize(request)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Undeclared network call to example.com')
  })
})
