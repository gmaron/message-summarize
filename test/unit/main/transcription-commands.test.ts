import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WhisperModel } from '../../../src/infrastructure/transcription/index.js'
import { WHISPER_MODELS } from '../../../src/infrastructure/transcription/index.js'
import { runMain } from '../../../src/main/app.js'
import type { CommandProbe } from '../../../src/main/context.js'
import { disposeHarnesses, type Harness, ME, makeHarness } from '../../support/cli-harness.js'

afterEach(() => {
  disposeHarnesses()
})

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

// A tiny "model" with a pinned checksum, handed to the commands in place of the real table.
const CONTENT = Buffer.from('pretend these are the weights of a model '.repeat(250))
const TABLE: readonly WhisperModel[] = [
  { name: 'tiny-test', bytes: CONTENT.length, sha256: sha(CONTENT) },
  { name: 'other-test', bytes: 5_000_000, sha256: 'f'.repeat(64) },
]

function fetching(chunks: Buffer[] | number | Error): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    urls.push(String(input))
    if (chunks instanceof Error) throw chunks
    if (typeof chunks === 'number') return new Response(null, { status: chunks })
    let sent = 0
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks[sent++]
          if (next === undefined) controller.close()
          else controller.enqueue(new Uint8Array(next))
        },
      }),
      { status: 200 },
    )
  }
  return { fetch: impl as typeof fetch, urls }
}
const pieces = (data: Buffer, size: number): Buffer[] => {
  const out: Buffer[] = []
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, i + size))
  return out
}
const withContext = (h: Harness, extra: Record<string, unknown>): void => {
  Object.assign(h.ctx, extra)
}

describe('msum whisper models (RF-22)', () => {
  it('lists the known models with their sizes, marks the ones downloaded and says how to get one', async () => {
    const h = await makeHarness({ config: { language: 'en' } })
    mkdirSync(h.layout.modelsDir, { recursive: true })
    writeFileSync(join(h.layout.modelsDir, 'ggml-base.bin'), 'x')
    expect(await run(h, 'whisper', 'models')).toBe(0)
    const text = h.out.join('\n')
    expect(text).toContain('whisper.cpp models')
    for (const model of WHISPER_MODELS) expect(text).toContain(model.name)
    expect(text).toMatch(/base\s+148 MB\s+\[downloaded\]/)
    expect(text).toMatch(/tiny\s+78 MB\s*$/m)
    expect(text).toMatch(/large-v3\s+3\.1 GB/)
    expect(text).toContain('msum whisper download <name>')
    expect(text).toContain(h.layout.modelsDir)
    expect(h.err).toEqual([])
  })

  it('"msum whisper" alone is the same list, and it never touches the network', async () => {
    const h = await makeHarness({ config: { language: 'en' } })
    const http = fetching(new Error('the network must not be used'))
    withContext(h, { fetch: http.fetch })
    expect(await run(h, 'whisper')).toBe(0)
    expect(http.urls).toEqual([])
  })

  it('speaks Spanish when the configuration says so', async () => {
    const h = await makeHarness({ config: { language: 'es' } })
    mkdirSync(h.layout.modelsDir, { recursive: true })
    writeFileSync(join(h.layout.modelsDir, 'ggml-tiny.bin'), 'x')
    await run(h, 'whisper', 'models')
    expect(h.out.join('\n')).toContain('Modelos de whisper.cpp')
    expect(h.out.join('\n')).toContain('[descargado]')
  })
})

describe('msum whisper download <name> (RF-22)', () => {
  it('downloads into <data>/models with a progress line at every tenth, verifies the checksum and says how to enable it', async () => {
    const h = await makeHarness({ config: { language: 'en' } })
    const http = fetching(pieces(CONTENT, 400))
    withContext(h, { fetch: http.fetch, whisperModels: TABLE })
    expect(await run(h, 'whisper', 'download', 'tiny-test')).toBe(0)
    const path = join(h.layout.modelsDir, 'ggml-tiny-test.bin')
    expect(readFileSync(path).equals(CONTENT)).toBe(true)
    expect(readdirSync(h.layout.modelsDir)).toEqual(['ggml-tiny-test.bin'])
    const out = h.out.join('\n')
    expect(out).toContain('Downloading the model "tiny-test"')
    expect(out).toContain('from huggingface.co')
    const percents = [...out.matchAll(/^ {2}(\d+)%/gm)].map((m) => Number(m[1]))
    expect(percents).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    expect(out).toContain(`downloaded and its SHA-256 checksum is right: ${path}`)
    expect(out).toContain('"transcription": { "enabled": true, "model": "tiny-test" }')
    expect(http.urls).toEqual(['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-test.bin'])
    if (process.platform !== 'win32') expect(statSync(h.layout.modelsDir).mode & 0o777).toBe(0o700)
  })

  it('a bad checksum: exit 1, the reason, and nothing left behind', async () => {
    const h = await makeHarness({ config: { language: 'en' } })
    const tampered = Buffer.alloc(CONTENT.length, 3)
    withContext(h, { fetch: fetching([tampered]).fetch, whisperModels: TABLE })
    expect(await run(h, 'whisper', 'download', 'tiny-test')).toBe(1)
    expect(h.err.join('\n')).toContain('checksum of the downloaded file is not the expected one')
    expect(readdirSync(h.layout.modelsDir)).toEqual([])
    expect(h.out.join('\n')).not.toContain('SHA-256 checksum is right')
  })

  it('an HTTP error, a network failure and a short file each say what happened and save nothing', async () => {
    const cases: [Buffer[] | number | Error, string][] = [
      [404, 'HTTP 404'],
      [new TypeError('fetch failed'), 'connection failed or stopped'],
      [[CONTENT.subarray(0, 100)], 'does not have the expected size'],
    ]
    for (const [answer, expected] of cases) {
      const h = await makeHarness({ config: { language: 'en' } })
      withContext(h, { fetch: fetching(answer).fetch, whisperModels: TABLE })
      expect(await run(h, 'whisper', 'download', 'tiny-test')).toBe(1)
      expect(h.err.join('\n')).toContain(expected)
      expect(readdirSync(h.layout.modelsDir)).toEqual([])
    }
  })

  it('an unknown name is a usage error that lists the known models, and no request is made', async () => {
    const h = await makeHarness({ config: { language: 'en' } })
    const http = fetching(new Error('the network must not be used'))
    withContext(h, { fetch: http.fetch, whisperModels: TABLE })
    expect(await run(h, 'whisper', 'download', '../../etc/passwd')).toBe(2)
    expect(h.err.join('\n')).toContain('is not a known model. Known models: tiny-test, other-test.')
    expect(http.urls).toEqual([])
  })

  it('a missing name is a usage error', async () => {
    const h = await makeHarness({ config: { language: 'en' } })
    expect(await run(h, 'whisper', 'download')).toBe(2)
    expect(h.err.join('\n')).toContain('<name>')
  })

  it('a model that is there and verified is not downloaded again', async () => {
    const h = await makeHarness({ config: { language: 'en' } })
    mkdirSync(h.layout.modelsDir, { recursive: true })
    writeFileSync(join(h.layout.modelsDir, 'ggml-tiny-test.bin'), CONTENT)
    const http = fetching(new Error('the network must not be used'))
    withContext(h, { fetch: http.fetch, whisperModels: TABLE })
    expect(await run(h, 'whisper', 'download', 'tiny-test')).toBe(0)
    expect(http.urls).toEqual([])
    expect(h.out.join('\n')).toContain('is already there and its checksum is right')
  })

  it('speaks Spanish when the configuration says so', async () => {
    const h = await makeHarness({ config: { language: 'es' } })
    withContext(h, { fetch: fetching(pieces(CONTENT, 1000)).fetch, whisperModels: TABLE })
    expect(await run(h, 'whisper', 'download', 'tiny-test')).toBe(0)
    expect(h.out.join('\n')).toContain('Descargando el modelo "tiny-test"')
    expect(h.out.join('\n')).toContain('checksum SHA-256 es correcto')
  })
})

describe('msum doctor: transcription (RF-81, RF-21)', () => {
  const config = (transcription: Record<string, unknown> | undefined, language = 'en') => ({
    language,
    provider: { primary: 'claude-cli' },
    ...(transcription === undefined ? {} : { transcription }),
  })
  const linked = async (h: Harness): Promise<void> => {
    const runtime = h.runtime()
    runtime.identity.bind(ME)
    runtime.close()
    writeFileSync(join(h.account.authDir, 'creds.json'), JSON.stringify({ me: { id: ME } }))
  }
  const probes = (found: { whisper?: boolean; ffmpeg?: boolean } = {}) => {
    const calls: { command: string; args: readonly string[] }[] = []
    return {
      calls,
      probes: {
        commandProbe: async (command: string, args: readonly string[]): Promise<CommandProbe> => {
          calls.push({ command, args })
          const isWhisper = command.includes('whisper')
          const started = isWhisper ? found.whisper !== false : found.ffmpeg !== false
          return {
            started,
            ok: !isWhisper && started,
            line: isWhisper ? 'error: unknown argument' : 'ffmpeg version 7.0',
          }
        },
      },
    }
  }
  const installModel = (h: Harness, file: string, content: Buffer | string): string => {
    mkdirSync(h.layout.modelsDir, { recursive: true, mode: 0o700 })
    const path = join(h.layout.modelsDir, file)
    writeFileSync(path, content)
    return path
  }

  it('a models directory that others can read is reported, like the rest of the data directory (RNF-04)', async () => {
    if (process.platform === 'win32') return
    const h = await makeHarness({ config: config(undefined), probes: probes().probes })
    await linked(h)
    mkdirSync(h.layout.modelsDir, { recursive: true })
    chmodSync(h.layout.modelsDir, 0o755)
    expect(await run(h, 'doctor')).toBe(1)
    expect(h.out.join('\n')).toContain(`${h.layout.modelsDir} has permissions 755`)
  })

  it('an audio directory that others can read is reported too', async () => {
    if (process.platform === 'win32') return
    const h = await makeHarness({ config: config(undefined), probes: probes().probes })
    await linked(h)
    mkdirSync(h.account.mediaDir, { recursive: true })
    chmodSync(h.account.mediaDir, 0o755)
    expect(await run(h, 'doctor')).toBe(1)
    expect(h.out.join('\n')).toContain(`${h.account.mediaDir} has permissions 755`)
  })

  it('off is fine: it says so, and doctor passes', async () => {
    const h = await makeHarness({ config: config(undefined) })
    await linked(h)
    expect(await run(h, 'doctor')).toBe(0)
    const text = h.out.join('\n')
    expect(text).toContain(
      '[ok]   Transcription: off: audios show as "(audio not transcribed)" and everything else works',
    )
    expect(text).not.toContain('whisper.cpp:')
    expect(text).not.toContain('ffmpeg:')
  })

  it('on and complete: whisper found, ffmpeg with its version, and the model verified by its checksum', async () => {
    const p = probes()
    const h = await makeHarness({
      config: config({ enabled: true, model: 'tiny-test', language: 'es' }),
      probes: p.probes,
    })
    await linked(h)
    withContext(h, { whisperModels: TABLE })
    const path = installModel(h, 'ggml-tiny-test.bin', CONTENT)
    expect(await run(h, 'doctor')).toBe(0)
    const text = h.out.join('\n')
    expect(text).toContain('[ok]   Transcription: on (language: es)')
    expect(text).toContain('[ok]   whisper.cpp: found')
    expect(text).toContain('[ok]   ffmpeg: found (ffmpeg version 7.0)')
    expect(text).toContain(`[ok]   Whisper model: ${path} (checksum right)`)
    expect(p.calls).toEqual([
      { command: 'whisper-cli', args: ['--version'] },
      { command: 'ffmpeg', args: ['-version'] },
    ])
  })

  it('shows "detected for each audio" for the automatic language', async () => {
    const h = await makeHarness({ config: config({ enabled: true, model: 'x' }), probes: probes().probes })
    await linked(h)
    await run(h, 'doctor')
    expect(h.out.join('\n')).toContain('on (language: detected for each audio)')
  })

  it('a model whose checksum does not match: fail, with how to fix it', async () => {
    const h = await makeHarness({ config: config({ enabled: true, model: 'tiny-test' }), probes: probes().probes })
    await linked(h)
    withContext(h, { whisperModels: TABLE })
    installModel(h, 'ggml-tiny-test.bin', 'a file that was cut short')
    expect(await run(h, 'doctor')).toBe(1)
    const text = h.out.join('\n')
    expect(text).toContain('[fail] Whisper model:')
    expect(text).toContain('does not match the checksum of its model')
    expect(text).toContain('msum whisper download <name>')
  })

  it('a model of your own (not in the table): a warning, not a failure', async () => {
    const h = await makeHarness({ config: config({ enabled: true, model: 'mine.bin' }), probes: probes().probes })
    await linked(h)
    installModel(h, 'mine.bin', 'my own model')
    expect(await run(h, 'doctor')).toBe(0)
    const text = h.out.join('\n')
    expect(text).toContain('[warn] Whisper model:')
    expect(text).toContain('no checksum to compare it with')
  })

  it('a model path outside the models directory is checked where it points', async () => {
    const h = await makeHarness({ config: config({ enabled: true, model: join(process.cwd(), 'nope', 'ggml-x.bin') }) })
    await linked(h)
    expect(await run(h, 'doctor')).toBe(1)
    expect(h.out.join('\n')).toContain(`the file does not exist: ${join(process.cwd(), 'nope', 'ggml-x.bin')}`)
  })

  it('says what is missing and how to get it: whisper, ffmpeg and the model, each on its own', async () => {
    const p = probes({ whisper: false, ffmpeg: false })
    const h = await makeHarness({ config: config({ enabled: true }), probes: p.probes })
    await linked(h)
    expect(await run(h, 'doctor')).toBe(1)
    const text = h.out.join('\n')
    expect(text).toContain('[fail] whisper.cpp: could not run "whisper-cli"')
    expect(text).toContain('install whisper.cpp')
    expect(text).toContain('Until then audios stay untranscribed')
    expect(text).toContain('[fail] ffmpeg: could not run "ffmpeg"')
    expect(text).toContain('[fail] Whisper model: no model chosen')
    expect(text).toContain('msum whisper download base')
  })

  it('uses the commands of the configuration', async () => {
    const p = probes()
    const h = await makeHarness({
      config: config({
        enabled: true,
        model: 'x',
        whisperCommand: '/opt/w/whisper-cli',
        ffmpegCommand: '/opt/f/ffmpeg',
      }),
      probes: p.probes,
    })
    await linked(h)
    await run(h, 'doctor')
    expect(p.calls.map((c) => c.command)).toEqual(['/opt/w/whisper-cli', '/opt/f/ffmpeg'])
  })

  it('speaks Spanish when the configuration says so', async () => {
    const h = await makeHarness({ config: config({ enabled: true }, 'es'), probes: probes({ whisper: false }).probes })
    await linked(h)
    await run(h, 'doctor')
    const text = h.out.join('\n')
    expect(text).toContain('Transcripción: activada')
    expect(text).toContain('no se pudo ejecutar "whisper-cli"')
    expect(text).toContain('no hay modelo elegido')
  })
})

describe('msum unlink and the audio files (RF-03, RF-15)', () => {
  it('deletes the downloaded audios with the account, and leaves the models of the installation alone', async () => {
    const h = await makeHarness({ config: { language: 'en' } })
    const runtime = h.runtime()
    runtime.identity.bind(ME)
    runtime.close()
    mkdirSync(h.account.mediaDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(h.account.mediaDir, 'private-voice-note.ogg'), 'PRIVATE AUDIO BYTES')
    mkdirSync(h.layout.modelsDir, { recursive: true })
    writeFileSync(join(h.layout.modelsDir, 'ggml-base.bin'), 'a model')
    expect(await run(h, 'unlink', '--yes')).toBe(0)
    expect(existsSync(h.account.mediaDir)).toBe(false)
    expect(existsSync(h.account.dir)).toBe(false)
    expect(existsSync(join(h.layout.modelsDir, 'ggml-base.bin'))).toBe(true)
  })

  it('only the audios of the account that is unlinked go: another account keeps its own', async () => {
    const h = await makeHarness({ config: { language: 'en' }, accounts: ['one', 'two'] })
    for (const id of ['one', 'two']) {
      const account = h.accountOf(id)
      mkdirSync(account.mediaDir, { recursive: true })
      writeFileSync(join(account.mediaDir, `${id}.ogg`), id)
    }
    expect(await run(h, 'unlink', '--account', 'one', '--yes')).toBe(0)
    expect(existsSync(h.accountOf('one').mediaDir)).toBe(false)
    expect(readFileSync(join(h.accountOf('two').mediaDir, 'two.ogg'), 'utf8')).toBe('two')
  })
})
