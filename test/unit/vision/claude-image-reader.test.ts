import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ClaudeImageReader,
  IMAGE_READER_REQUIRED_FLAGS,
  imageReaderArgs,
  imageTextOf,
  MAX_IMAGE_TEXT_CHARS,
  resultOfStream,
} from '../../../src/infrastructure/vision/index.js'
import { CLAUDE_HELP, envNamesOf, type FakeCli, installFakeCli } from '../../support/fake-cli.js'
import { allowSubprocess } from '../../support/network-guard.js'

const result = (text: string, extra: object = {}): string =>
  `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${JSON.stringify({ type: 'result', is_error: false, result: text, ...extra })}\n`

const HELP_WITH_INPUT = `${CLAUDE_HELP}  --input-format <format>               Input format\n`
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

// The fake claude is a node script with a shebang, which Windows cannot run without a shell (RF-49).
describe.skipIf(process.platform === 'win32')('ClaudeImageReader', () => {
  let dir: string
  let image: string
  const fakes: FakeCli[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'image-reader-test-'))
    image = join(dir, 'a.jpg')
    writeFileSync(image, JPEG)
  })
  afterEach(() => {
    for (const fake of fakes.splice(0)) fake.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const install = (text: string, options: Parameters<typeof installFakeCli>[0] = {}): FakeCli => {
    const fake = installFakeCli({ help: HELP_WITH_INPUT, steps: [{ kind: 'text', text }], ...options })
    fakes.push(fake)
    return fake
  }
  const reader = (fake: FakeCli, extra: Partial<ConstructorParameters<typeof ClaudeImageReader>[0]> = {}) =>
    new ClaudeImageReader({ command: fake.path, model: 'sonnet', timeoutMs: 20_000, killGraceMs: 200, ...extra })
  const request = (path = image) => ({ audioPath: path, language: 'es', kind: 'image' as const })

  it('sends the image as base64 through stdin, with its caption, and returns the text', async () => {
    const fake = install(result('Concierto, viernes 20 hs, Teatro Coliseo'))
    const out = await reader(fake).transcribe({ ...request(), caption: '[imagen] Vamos?' })
    expect(out).toEqual({ ok: true, value: 'Concierto, viernes 20 hs, Teatro Coliseo' })
    const [call] = fake.calls('run')
    const line = JSON.parse(call?.stdin ?? '') as {
      message: { content: { type: string; source?: { media_type: string; data: string }; text?: string }[] }
    }
    const [picture, text] = line.message.content
    expect(picture?.source?.media_type).toBe('image/jpeg')
    expect(Buffer.from(picture?.source?.data ?? '', 'base64')).toEqual(JPEG)
    expect(text?.text).toContain('[imagen] Vamos?')
  })

  it('runs with no tools, no session, no hooks and no MCP servers, and the image never goes in an argument', async () => {
    const fake = install(result('x'))
    await reader(fake).transcribe(request())
    const argv = fake.calls('run')[0]?.argv ?? []
    expect(argv).toEqual(imageReaderArgs('sonnet'))
    expect(argv).toContain('--strict-mcp-config')
    expect(argv).toContain('--safe-mode')
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
    expect(argv.join(' ')).not.toContain(JPEG.toString('base64'))
  })

  it('runs in an empty directory of its own and with a minimal environment', async () => {
    const fake = install(result('x'))
    const env = { PATH: process.env.PATH ?? '', HOME: '/h', ANTHROPIC_API_KEY: 'secret', TOKEN: 't' }
    await reader(fake, { env }).transcribe(request())
    const call = fake.calls('run')[0]
    expect(call?.cwdEntries).toEqual([])
    expect(call?.cwd).not.toBe(dir)
    expect(envNamesOf(call?.env)).toEqual(['HOME', 'PATH'])
  })

  it('NADA means the image has nothing to read: an empty text, not a failure', async () => {
    const fake = install(result('NADA'))
    expect(await reader(fake).transcribe(request())).toEqual({ ok: true, value: '' })
  })

  it('a failure of the model is a fixed word, never what it printed', async () => {
    const fake = install(result('the text of a private chat', { is_error: true }))
    const out = await reader(fake).transcribe(request())
    expect(out).toEqual({ ok: false, error: { kind: 'failed', reason: 'claude-exit-0' } })
    expect(JSON.stringify(out)).not.toContain('private chat')
  })

  it('says unavailable when the program is not there, so the image stays queued', async () => {
    const missing = join(dir, 'nope')
    const revoke = allowSubprocess(missing)
    const out = await new ClaudeImageReader({ command: missing, model: 'sonnet' }).transcribe(request())
    revoke()
    expect(out).toEqual({ ok: false, error: { kind: 'unavailable', reason: 'claude-not-found' } })
  })

  it('refuses to run a CLI that cannot be verified to run without tools', async () => {
    const fake = install(result('x'), { help: CLAUDE_HELP }) // no --input-format
    const out = await reader(fake, { verify: true, env: { PATH: process.env.PATH ?? '' } }).transcribe(request())
    expect(out).toEqual({ ok: false, error: { kind: 'unavailable', reason: 'claude-missingFlags' } })
    expect(fake.calls('run')).toEqual([])
  })

  it('runs a CLI that lists every flag', async () => {
    const fake = install(result('ok'))
    const out = await reader(fake, { verify: true, env: { PATH: process.env.PATH ?? '' } }).transcribe(request())
    expect(out).toEqual({ ok: true, value: 'ok' })
  })

  it('times out and kills the process', async () => {
    const fake = install('', { steps: [{ kind: 'hang' }] })
    const out = await reader(fake, { timeoutMs: 300 }).transcribe(request())
    expect(out).toEqual({ ok: false, error: { kind: 'timeout' } })
  })

  it('does not read a format the vision API does not take', async () => {
    const fake = install(result('x'))
    const gif = join(dir, 'a.gif')
    writeFileSync(gif, 'GIF89a')
    expect(await reader(fake).transcribe(request(gif))).toEqual({
      ok: false,
      error: { kind: 'failed', reason: 'unsupported-format' },
    })
    expect(fake.calls('run')).toEqual([])
  })

  it('a file that is gone is a failure of that image', async () => {
    const fake = install(result('x'))
    expect(await reader(fake).transcribe(request(join(dir, 'gone.jpg')))).toEqual({
      ok: false,
      error: { kind: 'failed', reason: 'unreadable' },
    })
  })

  it('after close it refuses new work', async () => {
    const fake = install(result('x'))
    const r = reader(fake)
    await r.close()
    expect(await r.transcribe(request())).toEqual({ ok: false, error: { kind: 'unavailable', reason: 'closed' } })
  })
})

describe('the pure helpers', () => {
  it('takes the last result of the stream and ignores progress lines', () => {
    expect(resultOfStream(`not json\n${JSON.stringify({ type: 'result', result: 'a' })}\n`)).toBe('a')
    expect(resultOfStream(JSON.stringify({ type: 'assistant' }))).toBeNull()
    expect(resultOfStream('')).toBeNull()
  })

  it('NADA, in any case and followed by a stop, is nothing; anything else is kept and bounded', () => {
    expect(imageTextOf(' nada. ')).toBe('')
    expect(imageTextOf('Nadie viene hoy')).toBe('Nadie viene hoy')
    expect(imageTextOf('x'.repeat(MAX_IMAGE_TEXT_CHARS + 50))).toHaveLength(MAX_IMAGE_TEXT_CHARS + 1)
  })

  it('lists, as required flags, every flag it passes', () => {
    const args = imageReaderArgs('m')
    for (const flag of IMAGE_READER_REQUIRED_FLAGS) expect(args).toContain(flag)
  })
})
