import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type DownloadProgress,
  downloadModel,
  findModel,
  findModelByFile,
  isModelHost,
  MODEL_BASE_URL,
  MODEL_HOST,
  modelFileName,
  modelUrl,
  resolveModelPath,
  WHISPER_MODELS,
  type WhisperModel,
} from '../../../src/infrastructure/transcription/index.js'

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

// A tiny "model" with a pinned checksum: the real ones are 77 MB and up, and the network is never used in tests.
const CONTENT = Buffer.from('pretend these are the weights of a model '.repeat(100))
const TABLE: readonly WhisperModel[] = [{ name: 'tiny-test', bytes: CONTENT.length, sha256: sha(CONTENT) }]

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const modelsDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'msum-models-'))
  dirs.push(dir)
  return join(dir, 'models') // does not exist yet: the download creates it
}

interface FakeFetch {
  readonly fetch: typeof fetch
  readonly urls: string[]
  readonly init: (RequestInit | undefined)[]
}

/** A fetch that answers with `chunks` (or fails), and records what it was asked. */
function fakeFetch(
  respond: () => { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; failAfter?: number } | Error,
): FakeFetch {
  const urls: string[] = []
  const init: (RequestInit | undefined)[] = []
  const impl = async (input: Parameters<typeof fetch>[0], options?: RequestInit): Promise<Response> => {
    urls.push(String(input))
    init.push(options)
    const answer = respond()
    if (answer instanceof Error) throw answer
    const chunks = answer.chunks ?? []
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (answer.failAfter !== undefined && sent >= answer.failAfter) {
          controller.error(new Error('connection reset'))
          return
        }
        const next = chunks[sent++]
        if (next === undefined) controller.close()
        else controller.enqueue(new Uint8Array(next))
      },
    })
    return new Response(body, { status: answer.status ?? 200, headers: answer.headers ?? {} })
  }
  return { fetch: impl as typeof fetch, urls, init }
}

const slices = (data: Buffer, size: number): Buffer[] => {
  const out: Buffer[] = []
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, i + size))
  return out
}
const filesIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])

describe('downloadModel (RF-22)', () => {
  describe('a good download', () => {
    it('writes the model into the models directory, verified, and reports it', async () => {
      const dir = modelsDir()
      const http = fakeFetch(() => ({
        chunks: slices(CONTENT, 700),
        headers: { 'content-length': String(CONTENT.length) },
      }))
      const result = await downloadModel('tiny-test', { modelsDir: dir, fetch: http.fetch, table: TABLE })
      const path = join(dir, 'ggml-tiny-test.bin')
      expect(result).toEqual({ ok: true, value: { path, bytes: CONTENT.length, alreadyThere: false } })
      expect(readFileSync(path).equals(CONTENT)).toBe(true)
      expect(filesIn(dir)).toEqual(['ggml-tiny-test.bin']) // no temporary file left
    })

    it('reports the progress as it goes: increasing, ending at the pinned size', async () => {
      const dir = modelsDir()
      const http = fakeFetch(() => ({ chunks: slices(CONTENT, 500) }))
      const seen: DownloadProgress[] = []
      await downloadModel('tiny-test', {
        modelsDir: dir,
        fetch: http.fetch,
        table: TABLE,
        onProgress: (p) => seen.push(p),
      })
      expect(seen.length).toBeGreaterThan(3)
      expect(seen.map((p) => p.received)).toEqual([...seen.map((p) => p.received)].sort((a, b) => a - b))
      expect(seen.every((p) => p.total === CONTENT.length)).toBe(true)
      expect(seen.at(-1)?.received).toBe(CONTENT.length)
    })

    it('creates the models directory private (0700) and the file private (0600)', async () => {
      if (process.platform === 'win32') return
      const dir = modelsDir()
      await downloadModel('tiny-test', {
        modelsDir: dir,
        fetch: fakeFetch(() => ({ chunks: [CONTENT] })).fetch,
        table: TABLE,
      })
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(join(dir, 'ggml-tiny-test.bin')).mode & 0o777).toBe(0o600)
    })

    it('does not download again a model that is there and whose checksum is right', async () => {
      const dir = modelsDir()
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'ggml-tiny-test.bin'), CONTENT)
      const http = fakeFetch(() => new Error('the network must not be used'))
      const result = await downloadModel('tiny-test', { modelsDir: dir, fetch: http.fetch, table: TABLE })
      expect(result).toMatchObject({ ok: true, value: { alreadyThere: true } })
      expect(http.urls).toEqual([])
    })

    it('replaces a damaged file of the same name, only once the new one is verified', async () => {
      const dir = modelsDir()
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'ggml-tiny-test.bin'), 'damaged')
      const http = fakeFetch(() => ({ chunks: [CONTENT] }))
      const result = await downloadModel('tiny-test', { modelsDir: dir, fetch: http.fetch, table: TABLE })
      expect(result).toMatchObject({ ok: true, value: { alreadyThere: false } })
      expect(readFileSync(join(dir, 'ggml-tiny-test.bin')).equals(CONTENT)).toBe(true)
    })
  })

  describe('a download that goes wrong leaves nothing behind', () => {
    const expectNothing = (dir: string): void => expect(filesIn(dir)).toEqual([])

    it('a checksum that is not the pinned one: refused, and no model, no partial file', async () => {
      const dir = modelsDir()
      const tampered = Buffer.from(CONTENT)
      tampered[10] = (tampered[10] ?? 0) ^ 0xff // same size, one byte different
      const http = fakeFetch(() => ({ chunks: slices(tampered, 900) }))
      const result = await downloadModel('tiny-test', { modelsDir: dir, fetch: http.fetch, table: TABLE })
      expect(result).toEqual({ ok: false, error: { kind: 'checksum' } })
      expectNothing(dir)
    })

    it('a bad checksum leaves alone the file that was already there (nothing is replaced before it is verified)', async () => {
      const dir = modelsDir()
      mkdirSync(dir, { recursive: true })
      // An older file that is not the pinned content (so it is downloaded again) and a download that is also wrong.
      writeFileSync(join(dir, 'ggml-tiny-test.bin'), 'older')
      const tampered = Buffer.alloc(CONTENT.length, 1)
      const result = await downloadModel('tiny-test', {
        modelsDir: dir,
        fetch: fakeFetch(() => ({ chunks: [tampered] })).fetch,
        table: TABLE,
      })
      expect(result).toEqual({ ok: false, error: { kind: 'checksum' } })
      expect(filesIn(dir)).toEqual(['ggml-tiny-test.bin'])
      expect(readFileSync(join(dir, 'ggml-tiny-test.bin'), 'utf8')).toBe('older')
    })

    it('a file shorter than the pinned size: refused', async () => {
      const dir = modelsDir()
      const http = fakeFetch(() => ({ chunks: [CONTENT.subarray(0, CONTENT.length - 5)] }))
      expect(await downloadModel('tiny-test', { modelsDir: dir, fetch: http.fetch, table: TABLE })).toEqual({
        ok: false,
        error: { kind: 'size' },
      })
      expectNothing(dir)
    })

    it('SIZE CAP: a body longer than the pinned size is cut off as soon as it passes it', async () => {
      const dir = modelsDir()
      let pulled = 0
      const endless = fakeFetch(() => {
        pulled++
        return { chunks: Array.from({ length: 10_000 }, () => Buffer.alloc(1000, 7)) }
      })
      const result = await downloadModel('tiny-test', { modelsDir: dir, fetch: endless.fetch, table: TABLE })
      expect(result).toEqual({ ok: false, error: { kind: 'size' } })
      expect(pulled).toBe(1)
      expectNothing(dir)
    })

    it('an announced size that is not the pinned one: refused before reading the body', async () => {
      const dir = modelsDir()
      const http = fakeFetch(() => ({ chunks: [CONTENT], headers: { 'content-length': String(CONTENT.length + 1) } }))
      expect(await downloadModel('tiny-test', { modelsDir: dir, fetch: http.fetch, table: TABLE })).toEqual({
        ok: false,
        error: { kind: 'size' },
      })
      expectNothing(dir)
    })

    it('an HTTP error: reported with its status', async () => {
      const dir = modelsDir()
      const http = fakeFetch(() => ({ status: 404 }))
      expect(await downloadModel('tiny-test', { modelsDir: dir, fetch: http.fetch, table: TABLE })).toEqual({
        ok: false,
        error: { kind: 'http', status: 404 },
      })
      expectNothing(dir)
    })

    it('a connection that fails to open: a network error', async () => {
      const dir = modelsDir()
      const http = fakeFetch(() => new TypeError('fetch failed'))
      expect(await downloadModel('tiny-test', { modelsDir: dir, fetch: http.fetch, table: TABLE })).toEqual({
        ok: false,
        error: { kind: 'network' },
      })
      expectNothing(dir)
    })

    it('a connection that drops half way: a network error, and the half file is removed', async () => {
      const dir = modelsDir()
      const http = fakeFetch(() => ({ chunks: slices(CONTENT, 300), failAfter: 3 }))
      expect(await downloadModel('tiny-test', { modelsDir: dir, fetch: http.fetch, table: TABLE })).toEqual({
        ok: false,
        error: { kind: 'network' },
      })
      expectNothing(dir)
    })

    it('a connection that stalls: given up after the idle time', async () => {
      const dir = modelsDir()
      const stalled: typeof fetch = ((_input: unknown, options?: RequestInit) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })) as typeof fetch
      const started = Date.now()
      const result = await downloadModel('tiny-test', { modelsDir: dir, fetch: stalled, table: TABLE, stallMs: 50 })
      expect(result).toEqual({ ok: false, error: { kind: 'network' } })
      expect(Date.now() - started).toBeLessThan(5_000)
      expectNothing(dir)
    })

    it('an unknown model: refused without any request', async () => {
      const dir = modelsDir()
      const http = fakeFetch(() => new Error('the network must not be used'))
      expect(await downloadModel('../../etc/passwd', { modelsDir: dir, fetch: http.fetch, table: TABLE })).toEqual({
        ok: false,
        error: { kind: 'unknownModel' },
      })
      expect(http.urls).toEqual([])
    })

    it('a directory it cannot write to: a write error', async () => {
      const dir = modelsDir()
      mkdirSync(join(dir, '..'), { recursive: true })
      writeFileSync(dir, 'a file where the directory should be')
      const result = await downloadModel('tiny-test', {
        modelsDir: dir,
        fetch: fakeFetch(() => ({ chunks: [CONTENT] })).fetch,
        table: TABLE,
      })
      expect(result).toEqual({ ok: false, error: { kind: 'write' } })
    })
  })

  describe('where it downloads from (RNF-01)', () => {
    it('asks the official whisper.cpp repository on Hugging Face, and nothing else', async () => {
      const dir = modelsDir()
      const http = fakeFetch(() => ({ status: 404 }))
      await downloadModel('base', { modelsDir: dir, fetch: http.fetch })
      expect(http.urls).toEqual(['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'])
      expect(modelUrl('base')).toBe(`${MODEL_BASE_URL}/ggml-base.bin`)
      expect(new URL(modelUrl('large-v3-turbo-q5_0')).hostname).toBe(MODEL_HOST)
      expect(MODEL_HOST).toBe('huggingface.co')
    })

    it('follows the redirect to the CDN of Hugging Face, one checked hop at a time', async () => {
      const dir = modelsDir()
      const answers = [
        { status: 302, headers: { location: 'https://us.aws.cdn.hf.co/xet-bridge-us/abc/def?sig=1' } },
        { chunks: [CONTENT] },
      ]
      const http = fakeFetch(() => answers.shift() ?? { status: 500 })
      const result = await downloadModel('tiny-test', { modelsDir: dir, fetch: http.fetch, table: TABLE })
      expect(result.ok).toBe(true)
      expect(http.urls).toEqual([
        'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-test.bin',
        'https://us.aws.cdn.hf.co/xet-bridge-us/abc/def?sig=1',
      ])
      expect(http.init.every((options) => options?.redirect === 'manual')).toBe(true)
    })

    it('refuses a redirect to any other host, to plain http, or past five hops: nothing is requested from there', async () => {
      const bad = [
        'https://evil.example/ggml.bin',
        'http://huggingface.co/ggml.bin',
        'https://huggingface.co.evil.example/x',
        'https://nothf.co/x',
        'https://192.168.1.1/x',
        'https://user@evil.example/x',
      ]
      for (const location of bad) {
        const dir = modelsDir()
        const http = fakeFetch(() => ({ status: 302, headers: { location } }))
        const result = await downloadModel('tiny-test', { modelsDir: dir, fetch: http.fetch, table: TABLE })
        expect(result, location).toEqual({ ok: false, error: { kind: 'network' } })
        expect(http.urls, location).toHaveLength(1) // the hop was not followed
        expect(filesIn(dir), location).toEqual([])
      }
      const loop = fakeFetch(() => ({ status: 302, headers: { location: 'https://huggingface.co/again' } }))
      expect(await downloadModel('tiny-test', { modelsDir: modelsDir(), fetch: loop.fetch, table: TABLE })).toEqual({
        ok: false,
        error: { kind: 'network' },
      })
      expect(loop.urls.length).toBeLessThanOrEqual(6)
    })

    it('knows which hosts are Hugging Face', () => {
      for (const host of ['huggingface.co', 'HuggingFace.co', 'hf.co', 'us.aws.cdn.hf.co', 'cas-bridge.xethub.hf.co']) {
        expect(isModelHost(host), host).toBe(true)
      }
      for (const host of ['evil.example', 'huggingface.co.evil.example', 'nothf.co', 'hf.co.evil.example', '']) {
        expect(isModelHost(host), host).toBe(false)
      }
    })
  })
})

describe('the table of pinned models', () => {
  it('has a complete, well formed row for every model', () => {
    expect(WHISPER_MODELS.length).toBeGreaterThanOrEqual(12)
    for (const model of WHISPER_MODELS) {
      expect(model.sha256, model.name).toMatch(/^[0-9a-f]{64}$/)
      expect(model.bytes, model.name).toBeGreaterThan(1_000_000)
      expect(model.name, model.name).toMatch(/^[a-z0-9][a-z0-9._-]*$/) // no path syntax: a name becomes a file name
      expect(modelFileName(model.name)).toBe(`ggml-${model.name}.bin`)
    }
  })

  it('has no repeated name and no repeated checksum', () => {
    const names = WHISPER_MODELS.map((m) => m.name)
    expect(new Set(names).size).toBe(names.length)
    const sums = WHISPER_MODELS.map((m) => m.sha256)
    expect(new Set(sums).size).toBe(sums.length)
  })

  it('has the models people ask for, with the checksums the repository lists', () => {
    // Values taken from the listing of the repository (lfs.oid); `tiny` was also downloaded and hashed to confirm.
    expect(findModel('tiny')).toEqual({
      name: 'tiny',
      bytes: 77691713,
      sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    })
    expect(findModel('base')?.sha256).toBe('60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe')
    expect(findModel('small')?.sha256).toBe('1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b')
    for (const name of ['tiny.en', 'base.en', 'small.en', 'medium', 'large-v3', 'large-v3-turbo']) {
      expect(findModel(name), name).toBeDefined()
    }
    expect(findModel('nope')).toBeUndefined()
  })

  it('finds a model by the name of its file', () => {
    expect(findModelByFile('ggml-base.bin')?.name).toBe('base')
    expect(findModelByFile('base.bin')).toBeUndefined()
    expect(findModelByFile('ggml-mine.bin')).toBeUndefined()
  })
})

describe('resolveModelPath', () => {
  const models = '/data/models'
  const data = '/data'
  it('takes a bare name or a file name as a model of the models directory', () => {
    expect(resolveModelPath(models, data, 'base')).toBe(join('/data/models', 'ggml-base.bin'))
    expect(resolveModelPath(models, data, 'small.en')).toBe(join('/data/models', 'ggml-small.en.bin'))
    expect(resolveModelPath(models, data, 'ggml-base.bin')).toBe(join('/data/models', 'ggml-base.bin'))
    expect(resolveModelPath(models, data, 'mine.bin')).toBe(join('/data/models', 'mine.bin'))
  })
  it('takes an absolute path as it is, and a relative one with a separator from the data directory', () => {
    expect(resolveModelPath(models, data, '/opt/whisper/ggml-x.bin')).toBe('/opt/whisper/ggml-x.bin')
    expect(resolveModelPath(models, data, 'custom/ggml-x.bin')).toBe(resolve('/data', 'custom/ggml-x.bin'))
  })
})
