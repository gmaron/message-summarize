import { describe, expect, it } from 'vitest'
import { listOllamaModels } from '../../../src/infrastructure/llm/ollama-admin.js'

describe('the list of models of an Ollama', () => {
  it('is read with a byte limit: an endless body is cut, not held in memory', async () => {
    let cancelled = false
    let pulled = 0
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
    const result = await listOllamaModels('http://127.0.0.1:11434', { fetch: fn })
    expect(result.ok).toBe(false)
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThanOrEqual(8)
  })

  it('still reads a normal list', async () => {
    const fn = (async () =>
      new Response(JSON.stringify({ models: [{ name: 'qwen3:4b' }, { name: 'llama3.2:latest' }] }))) as typeof fetch
    expect(await listOllamaModels(undefined, { fetch: fn })).toEqual({
      ok: true,
      value: ['qwen3:4b', 'llama3.2:latest'],
    })
  })
})
