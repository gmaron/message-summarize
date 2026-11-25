import { readFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { err, ok } from '../../../../src/domain/result.js'
import { listOllamaModels, ollamaHasModel, pullOllamaModel } from '../../../../src/infrastructure/llm/index.js'
import { runMain } from '../../../../src/main/app.js'
import { isValidTag } from '../../../../src/main/commands/ollama.js'
import { disposeHarnesses, type Harness, makeHarness } from '../../../support/cli-harness.js'

// A fake Ollama on 127.0.0.1 (the network guard lets loopback through). It records what it receives and answers /api/tags
// and /api/pull with what the test scripts: pull events are written one by one, so a test can break the stream half way.

interface Seen {
  method: string | undefined
  url: string | undefined
  body: string
}
interface FakeOllama {
  baseUrl: string
  seen: Seen[]
}

let server: Server | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  disposeHarnesses()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

type Handler = (req: Seen, res: ServerResponse) => void
async function fakeOllama(handler: Handler): Promise<FakeOllama> {
  const seen: Seen[] = []
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, body }
      seen.push(entry)
      handler(entry, res)
    })
  })
  const started = server
  await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${(started.address() as AddressInfo).port}`, seen }
}

const ndjson = (res: ServerResponse, events: unknown[], status = 200): void => {
  res.writeHead(status, { 'content-type': 'application/x-ndjson' })
  for (const event of events) res.write(`${JSON.stringify(event)}\n`)
  res.end()
}
const layer = (digest: string, total: number, completed: number) => ({
  status: `pulling ${digest}`,
  digest,
  total,
  completed,
})
const GOOD_PULL = [
  { status: 'pulling manifest' },
  layer('sha256:aaa', 1_000_000_000, 0),
  layer('sha256:aaa', 1_000_000_000, 500_000_000),
  layer('sha256:aaa', 1_000_000_000, 1_000_000_000),
  layer('sha256:bbb', 100_000_000, 100_000_000),
  { status: 'verifying sha256 digest' },
  { status: 'writing manifest' },
  { status: 'success' },
]

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const out = (h: Harness) => h.out.join('\n')
const GB = 1024 ** 3

describe('ollamaHasModel and listOllamaModels', () => {
  it('matches a tag exactly, and a bare name as :latest', () => {
    expect(ollamaHasModel('qwen3:4b', ['qwen3:4b', 'llama3.2:latest'])).toBe(true)
    expect(ollamaHasModel('qwen3:8b', ['qwen3:4b'])).toBe(false)
    expect(ollamaHasModel('llama3.2', ['llama3.2:latest'])).toBe(true)
    expect(ollamaHasModel('llama3.2', ['llama3.2:3b'])).toBe(false)
  })

  it('reads /api/tags and explains failures', async () => {
    const fake = await fakeOllama((req, res) => {
      if (req.url === '/api/tags') ndjson(res, [{ models: [{ name: 'qwen3:4b' }, { name: 'x:1' }, { nope: 1 }] }])
      else if (req.url === '/api/bad') res.writeHead(500).end('nope')
    })
    expect(await listOllamaModels(fake.baseUrl)).toEqual(ok(['qwen3:4b', 'x:1']))
    expect(await listOllamaModels(`${fake.baseUrl}/`)).toEqual(ok(['qwen3:4b', 'x:1']))
    const fetchStub = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    expect(await listOllamaModels(fake.baseUrl, { fetch: fetchStub })).toEqual(err('ollama returned no model list'))
    const failing = (async () => new Response('', { status: 503 })) as unknown as typeof fetch
    expect(await listOllamaModels(fake.baseUrl, { fetch: failing })).toEqual(err('ollama answered 503'))
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
    const down = await listOllamaModels(fake.baseUrl)
    expect(down.ok).toBe(false)
    expect(!down.ok && down.error).toMatch(/could not reach ollama/)
  })

  it('gives up when the server does not answer in time', async () => {
    const fake = await fakeOllama(() => {})
    const result = await listOllamaModels(fake.baseUrl, { timeoutMs: 50 })
    expect(result).toEqual(err('ollama did not answer in time'))
  })
})

describe('pullOllamaModel', () => {
  it('streams progress summed over the layers and succeeds on "success"', async () => {
    const fake = await fakeOllama((_req, res) => ndjson(res, GOOD_PULL))
    const seen: { status: string; completed: number; total: number }[] = []
    expect(await pullOllamaModel(fake.baseUrl, 'qwen3:4b', { onProgress: (p) => seen.push(p) })).toEqual(ok(undefined))
    expect(JSON.parse(fake.seen[0]?.body ?? '')).toEqual({ model: 'qwen3:4b', stream: true })
    expect(fake.seen[0]).toMatchObject({ method: 'POST', url: '/api/pull' })
    expect(seen.at(0)).toEqual({ status: 'pulling manifest', completed: 0, total: 0 })
    expect(seen.find((p) => p.completed === 500_000_000)).toMatchObject({ total: 1_000_000_000 })
    expect(seen.at(-1)).toEqual({ status: 'success', completed: 1_100_000_000, total: 1_100_000_000 })
  })

  it('fails with the error sent in the middle of the stream, and stops reading', async () => {
    const fake = await fakeOllama((_req, res) =>
      ndjson(res, [
        { status: 'pulling manifest' },
        layer('sha256:aaa', 1000, 100),
        { error: 'pull model manifest: file does not exist' },
        { status: 'success' },
      ]),
    )
    const result = await pullOllamaModel(fake.baseUrl, 'nope:1b')
    expect(result).toEqual(err('pull model manifest: file does not exist'))
  })

  it('fails when the stream ends without "success", on an HTTP error and on a line that is not JSON', async () => {
    const early = await fakeOllama((_req, res) =>
      ndjson(res, [{ status: 'pulling manifest' }, layer('sha256:a', 10, 5)]),
    )
    expect(await pullOllamaModel(early.baseUrl, 'm:1')).toEqual(
      err('the download ended without "success" (last status: "pulling sha256:a")'),
    )
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    const http = await fakeOllama((_req, res) => res.writeHead(500).end('internal   boom'))
    expect(await pullOllamaModel(http.baseUrl, 'm:1')).toEqual(err('ollama answered 500: internal boom'))
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    const junk = await fakeOllama((_req, res) => res.writeHead(200).end('<html>\n'))
    expect(await pullOllamaModel(junk.baseUrl, 'm:1')).toEqual(err('ollama sent a line that is not JSON'))
  })

  it('handles events split across chunks and a last line without newline', async () => {
    const fake = await fakeOllama((_req, res) => {
      res.writeHead(200)
      res.write('{"status":"pulling man')
      setTimeout(() => {
        res.write('ifest"}\n{"status":"succ')
        setTimeout(() => res.end('ess"}'), 5)
      }, 5)
    })
    const statuses: string[] = []
    expect(await pullOllamaModel(fake.baseUrl, 'm:1', { onProgress: (p) => statuses.push(p.status) })).toEqual(
      ok(undefined),
    )
    expect(statuses).toEqual(['pulling manifest', 'success'])
  })

  it('fails when nothing arrives for the idle time, and when the server is not there', async () => {
    const fake = await fakeOllama((_req, res) => {
      res.writeHead(200)
      res.write('{"status":"pulling manifest"}\n')
    })
    expect(await pullOllamaModel(fake.baseUrl, 'm:1', { idleTimeoutMs: 80 })).toEqual(
      err('ollama sent nothing for 0.08s'),
    )
    await new Promise<void>((resolve) => server?.closeAllConnections() ?? resolve())
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
    const down = await pullOllamaModel(fake.baseUrl, 'm:1')
    expect(!down.ok && down.error).toMatch(/could not reach ollama/)
  })

  it('fails with a redacted error when a line grows past 64 KB, with or without a newline', async () => {
    const endless = await fakeOllama((_req, res) => {
      res.writeHead(200)
      res.write('{"status":"pulling manifest"}\n')
      res.end(`{"status":"${'x'.repeat(70 * 1024)}`)
    })
    expect(await pullOllamaModel(endless.baseUrl, 'm:1')).toEqual(err('ollama sent a line longer than 64 KB'))
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    const long = await fakeOllama((_req, res) => {
      res.writeHead(200)
      res.end(`{"error":"sk-abcdefghijklmnop ${'y'.repeat(70 * 1024)}"}\n{"status":"success"}\n`)
    })
    const result = await pullOllamaModel(long.baseUrl, 'm:1')
    expect(result).toEqual(err('ollama sent a line longer than 64 KB'))
    // a line just under the cap is still read
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    const fine = await fakeOllama((_req, res) =>
      res.writeHead(200).end(`{"status":"pulling manifest","note":"${'z'.repeat(60 * 1024)}"}\n{"status":"success"}\n`),
    )
    expect(await pullOllamaModel(fine.baseUrl, 'm:1')).toEqual(ok(undefined))
  })

  it('redacts key-shaped text in what the server says', async () => {
    const fake = await fakeOllama((_req, res) =>
      ndjson(res, [{ error: 'unauthorized: sk-abcdefghijklmnop was rejected' }]),
    )
    const result = await pullOllamaModel(fake.baseUrl, 'm:1')
    expect(result).toEqual(err('unauthorized: [redacted] was rejected'))
  })
})

describe('msum ollama recommend', () => {
  const recommend = async (bytes: number, ...flags: string[]) => {
    const h = await makeHarness({ config: { language: 'en' } })
    Object.assign(h.ctx, { totalMemBytes: bytes })
    const before = readFileSync(h.layout.configFile, 'utf8')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await run(h, 'ollama', 'recommend', ...flags)).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    // nothing is chosen or written
    expect(readFileSync(h.layout.configFile, 'utf8')).toBe(before)
    expect(out(h)).not.toContain('Recommended')
    return out(h)
  }
  const order = (text: string): string[] =>
    text
      .split('\n')
      .filter((line) => /^ {2}\S+:\S+ {2}\d/.test(line))
      .map((line) => line.trim().split(' ')[0] as string)

  it('lists what fits with the evaluated models first, with their numbers, and leaves the choice to the user', async () => {
    const text = await recommend(16 * GB)
    expect(text).toContain('This machine has about 16 GB of RAM.')
    expect(order(text)).toEqual([
      'qwen3.5:4b',
      'qwen3:8b',
      'qwen2.5:7b',
      'gemma3:4b',
      'gemma4:e4b',
      'llama3.2:3b',
      'llama3.1:8b',
      'phi4-mini:3.8b',
      'qwen2.5:3b',
      'qwen3:4b',
    ])
    expect(text).toContain(
      '  qwen3.5:4b  3.3 GB  8 GB RAM  PASSED the evaluation of 2026-11-18: valid JSON 100%, "needs reply" 92% on the clear cases, 3.6 s per summary',
    )
    expect(text).toMatch(/qwen3:4b {2}2\.5 GB {2}8 GB RAM {2}FAILED the evaluation of 2026-11-18: .*"needs reply" 63%/)
    expect(text).toMatch(/gemma3:4b {2}3\.4 GB {2}8 GB RAM {2}not evaluated/)
    expect(text).toContain('You choose: nothing is picked or written for you.')
    expect(text).toContain('msum ollama pull <tag>')
    expect(text).toContain('msum provider use ollama --model <tag>')
    expect(text).toContain('provider.ollama.model')
    expect(text).not.toContain('hidden')
  })

  it('hides what needs more RAM and says how many, and --all shows it marked', async () => {
    const hiddenText = await recommend(8 * GB)
    expect(order(hiddenText)).toEqual([
      'qwen3.5:4b',
      'gemma3:4b',
      'llama3.2:3b',
      'phi4-mini:3.8b',
      'qwen2.5:3b',
      'qwen3:4b',
    ])
    expect(hiddenText).toContain('4 more candidates need more RAM than this machine has and are hidden')
    expect(hiddenText).toContain('msum ollama recommend --all')
    const allText = await recommend(8 * GB, '--all')
    expect(order(allText)).toHaveLength(10)
    expect(allText).toMatch(/qwen3:8b {2}5\.2 GB {2}16 GB RAM .*\[needs more RAM than this machine has\]/)
    expect(allText).not.toMatch(/qwen3\.5:4b.*\[needs more RAM/)
    expect(allText).not.toContain('are hidden')
  })

  it('says when nothing fits', async () => {
    const text = await recommend(4 * GB)
    expect(text).toContain('No candidate fits')
    expect(order(text)).toEqual([])
    expect(text).toContain('You choose')
  })

  it('speaks Spanish with the language of the configuration', async () => {
    const h = await makeHarness({ config: { language: 'es' } })
    Object.assign(h.ctx, { totalMemBytes: 16 * GB })
    expect(await run(h, 'ollama', 'recommend')).toBe(0)
    expect(out(h)).toContain('CUMPLIÓ la evaluación del 2026-11-18')
    expect(out(h)).toContain('Elegís vos: no se elige ni se escribe nada por vos.')
  })
})

describe('msum ollama pull', () => {
  const config = (baseUrl: string) => ({
    language: 'en',
    provider: { primary: 'ollama', ollama: { model: 'qwen3:4b', baseUrl } },
  })

  it('downloads through the configured Ollama with a progress line, and sends only the tag', async () => {
    const fake = await fakeOllama((_req, res) => ndjson(res, GOOD_PULL))
    const h = await makeHarness({ config: config(fake.baseUrl) })
    expect(await run(h, 'ollama', 'pull', 'qwen3:4b')).toBe(0)
    const text = out(h)
    expect(text).toContain('Asking the Ollama at')
    expect(text).toContain('No chat text is sent, only the tag.')
    expect(text).toMatch(/ {2}50% {2}\(500 MB of 1\.0 GB\)/)
    expect(text).toMatch(/ {2}100% {2}\(1\.0 GB of 1\.0 GB\)/)
    expect(text).toContain('  verifying sha256 digest')
    expect(text).toContain('  success')
    expect(text).not.toContain('pulling sha256')
    expect(text).toContain('The model "qwen3:4b" was downloaded.')
    expect(text).toContain('msum provider use ollama --model qwen3:4b')
    expect(fake.seen).toHaveLength(1)
    expect(JSON.parse(fake.seen[0]?.body ?? '')).toEqual({ model: 'qwen3:4b', stream: true })
  })

  it('fails with a redacted reason when the stream breaks half way', async () => {
    const fake = await fakeOllama((_req, res) =>
      ndjson(res, [
        { status: 'pulling manifest' },
        layer('sha256:aaa', 1_000_000_000, 300_000_000),
        { error: 'disk full while writing sk-abcdefghijklmnop' },
      ]),
    )
    const h = await makeHarness({ config: config(fake.baseUrl) })
    expect(await run(h, 'ollama', 'pull', 'qwen3:4b')).toBe(1)
    expect(out(h)).toMatch(/30% /)
    expect(h.err.join('\n')).toContain('The download failed: disk full while writing [redacted]')
    expect(out(h)).not.toContain('was downloaded')
  })

  it('refuses an Ollama that is not on this machine, without a request, unless --allow-remote is given', async () => {
    const h = await makeHarness({ config: config('http://192.168.1.50:11434') })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await run(h, 'ollama', 'pull', 'qwen3:4b')).toBe(1)
    expect(h.err.join('\n')).toContain('http://192.168.1.50:11434, which is not this machine')
    expect(h.err.join('\n')).toContain('--allow-remote')
    expect(fetchSpy).not.toHaveBeenCalled()

    const requested: string[] = []
    const stub = (async (url: string | URL | Request) => {
      requested.push(String(url))
      return new Response(`${GOOD_PULL.map((event) => JSON.stringify(event)).join('\n')}\n`)
    }) as unknown as typeof fetch
    Object.assign(h.ctx, { fetch: stub })
    expect(await run(h, 'ollama', 'pull', 'qwen3:4b', '--allow-remote')).toBe(0)
    expect(requested).toEqual(['http://192.168.1.50:11434/api/pull'])
  })

  it('accepts real tags and refuses odd ones', () => {
    for (const good of ['qwen3:4b', 'phi4-mini:3.8b', 'llama3.2', 'hf.co/user/model:Q4_K_M', 'a']) {
      expect(isValidTag(good), good).toBe(true)
    }
    for (const bad of [
      '',
      'a b',
      '../x',
      'a/../b',
      'a..b',
      'a//b',
      '/a',
      'a/',
      ':a',
      'a:',
      '-a',
      'a-',
      'a.',
      'a;b',
      'x'.repeat(201),
    ]) {
      expect(isValidTag(bad), bad).toBe(false)
    }
  })

  it('rejects a tag that does not look like one, without a request', async () => {
    const h = await makeHarness({ config: config('http://127.0.0.1:1') })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await run(h, 'ollama', 'pull', 'bad tag; rm')).toBe(2)
    expect(h.err.join('\n')).toContain('does not look like an Ollama model tag')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports an Ollama that is not running', async () => {
    const h = await makeHarness({ config: config('http://127.0.0.1:1') })
    expect(await run(h, 'ollama', 'pull', 'qwen3:4b')).toBe(1)
    expect(h.err.join('\n')).toContain('The download failed: could not reach ollama')
  })
})

describe('msum doctor with Ollama (model check)', () => {
  const config = {
    language: 'en',
    provider: { primary: 'ollama', ollama: { model: 'qwen3:4b' } },
  }
  const doctor = async (
    extra: string[],
    models: ReturnType<typeof ok<string[]>> | ReturnType<typeof err<string>>,
    override = config,
  ) => {
    const asked: string[] = []
    const h = await makeHarness({
      config: override,
      probes: {
        ollamaModels: async (baseUrl) => {
          asked.push(baseUrl)
          return models
        },
      },
    })
    const code = await run(h, 'doctor', ...extra)
    return { h, code, asked, text: out(h) }
  }

  it('is happy when the configured model is installed', async () => {
    const { text, asked } = await doctor([], ok(['qwen3:4b']))
    expect(text).toContain('the model "qwen3:4b" is installed in that Ollama')
    expect(asked).toEqual(['http://127.0.0.1:11434'])
  })

  it('fails and says how to pull the model when it is missing', async () => {
    const { text, code } = await doctor([], ok(['llama3.2:latest']))
    expect(code).toBe(1)
    expect(text).toContain('[fail] LLM provider: Ollama does not have the model "qwen3:4b"')
    expect(text).toContain('msum ollama pull qwen3:4b')
    expect(text).toContain('msum doctor --skip-model-check')
  })

  it('warns, without failing, when the list cannot be read', async () => {
    const { text } = await doctor([], err('ollama did not answer in time'))
    expect(text).toContain('could not read the list of models of Ollama (ollama did not answer in time)')
    expect(text).toContain('[warn]')
  })

  it('does not ask for the models with --skip-model-check', async () => {
    const { asked, text } = await doctor(['--skip-model-check'], ok([]))
    expect(asked).toEqual([])
    expect(text).not.toContain('Ollama does not have')
  })

  it('also checks Ollama when it only serves the "local only" chats', async () => {
    const { text, asked } = await doctor([], ok(['other:1b']), {
      language: 'en',
      localOnlyPatterns: ['secret'],
      provider: { primary: 'claude-cli', ollama: { model: 'qwen3:4b' } },
    } as never)
    expect(asked).toEqual(['http://127.0.0.1:11434'])
    expect(text).toContain('Ollama does not have the model "qwen3:4b"')
  })

  it('does not ask an Ollama that is not selected', async () => {
    const { asked } = await doctor([], ok([]), { language: 'en', provider: { primary: 'claude-cli' } } as never)
    expect(asked).toEqual([])
  })
})
