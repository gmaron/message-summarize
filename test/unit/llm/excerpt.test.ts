import { describe, expect, it } from 'vitest'
import { pullOllamaModel } from '../../../src/infrastructure/llm/ollama-admin.js'
import { excerpt } from '../../../src/infrastructure/llm/summary-schema.js'

const ESC = '\u001b'

describe('excerpt (text from a provider or server, shown on the terminal)', () => {
  it('removes terminal escape sequences, other control characters and bidi overrides', () => {
    const hostile = `ok${ESC}]0;owned\u0007${ESC}[2Jdone\u009b31m‮evil\u0000`
    const out = excerpt(hostile)
    for (const ch of out) {
      const code = ch.codePointAt(0) ?? 0
      expect(code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e)).toBe(false)
    }
    expect(out).toContain('ok')
    expect(out).toContain('done')
  })

  it('still flattens whitespace and cuts long text', () => {
    expect(excerpt('a\n\tb   c')).toBe('a b c')
    expect(excerpt('x'.repeat(300), 10)).toBe(`${'x'.repeat(10)}...`)
  })

  it('pull progress and errors from a hostile server reach the caller without escape sequences', async () => {
    const lines = [
      JSON.stringify({ status: `pulling${ESC}[2J${ESC}]0;title\u0007` }),
      JSON.stringify({ error: `bad${ESC}[31m model` }),
    ].join('\n')
    const fetchFn = async () => new Response(`${lines}\n`, { status: 200 })
    const statuses: string[] = []
    const result = await pullOllamaModel('http://127.0.0.1:11434', 'qwen3:4b', {
      fetch: fetchFn as typeof fetch,
      onProgress: (p) => statuses.push(p.status),
    })
    for (const s of statuses) expect(s).not.toContain(ESC)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(String(result.error)).not.toContain(ESC)
  })
})
