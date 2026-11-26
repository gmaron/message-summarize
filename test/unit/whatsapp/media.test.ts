import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AudioDescriptor,
  classifyFailure,
  createAudioFetcher,
  DEFAULT_MAX_AUDIO_BYTES,
  DEFAULT_MAX_IMAGE_BYTES,
  extensionForMimetype,
  isSafeDirectPath,
  MEDIA_DIR_MODE,
  MEDIA_FILE_MODE,
  mediaDirectoryBytes,
  mediaKindOfMimetype,
  mediaRefOf,
} from '../../../src/infrastructure/whatsapp/media.js'
import { until } from '../../support/cli-harness.js'

const posix = process.platform === 'win32' ? it.skip : it
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const mediaDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'msum-media-'))
  roots.push(root)
  return join(root, 'media') // does not exist: the first download creates it
}

const KEY = { conversationId: '9961674862244@s.whatsapp.net', messageId: 'MSG-1' }
const DIRECT_PATH = '/v/t62.7117-24/123_456_n.enc?ccb=11-4&oh=abc&oe=65f0'
/** The download descriptor of an audio, as the capture stores it (the key is 32 bytes, as WhatsApp's are). */
const audioMessage = (
  fileLength?: number,
  mimetype = 'audio/ogg; codecs=opus',
  overrides: Partial<AudioDescriptor> = {},
): AudioDescriptor => ({
  directPath: DIRECT_PATH,
  mediaKey: new Uint8Array(32).fill(4),
  mimetype,
  fileLength: fileLength ?? null,
  ...overrides,
})
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])

describe('what the sender writes is checked before anything is requested', () => {
  it('accepts the directPath of WhatsApp and nothing else', () => {
    expect(isSafeDirectPath(DIRECT_PATH)).toBe(true)
    expect(isSafeDirectPath('/o1/v/t62.7117-24/f/m234/AQ-abc_def.enc?ccb=11-4&oh=01_Q5&oe=1&_nc_sid=5e03e0')).toBe(true)
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'v/no-slash',
      '@evil.example/x',
      '/v/x@evil.example',
      'https://evil.example/x',
      '//evil.example/x',
      '/v//x',
      '/v\\x',
      '/v/../x',
      '/v/x y',
      '/v/x\n',
      `/${'a'.repeat(2_001)}`,
    ]) {
      expect(isSafeDirectPath(bad), String(bad)).toBe(false)
    }
  })

  it('maps the mimetypes of WhatsApp audio to an extension, ignoring parameters and case', () => {
    expect(extensionForMimetype('audio/ogg; codecs=opus')).toBe('ogg')
    expect(extensionForMimetype('AUDIO/OGG')).toBe('ogg')
    expect(extensionForMimetype('audio/opus')).toBe('ogg')
    expect(extensionForMimetype('audio/mpeg')).toBe('mp3')
    expect(extensionForMimetype('audio/mp4')).toBe('m4a')
    expect(extensionForMimetype('audio/x-m4a')).toBe('m4a')
    expect(extensionForMimetype('audio/aac')).toBe('aac')
    expect(extensionForMimetype('audio/amr')).toBe('amr')
    for (const unknown of [
      'video/mp4',
      'audio/x-matroska',
      'application/octet-stream',
      '',
      undefined,
      null,
      '__proto__',
    ]) {
      expect(extensionForMimetype(unknown), String(unknown)).toBeUndefined()
    }
  })

  it('knows the image formats the vision model takes, and tells an image from an audio', () => {
    expect(extensionForMimetype('image/jpeg')).toBe('jpg')
    expect(extensionForMimetype('IMAGE/PNG')).toBe('png')
    expect(extensionForMimetype('image/webp')).toBe('webp')
    expect(extensionForMimetype('image/gif')).toBeUndefined()
    expect(extensionForMimetype('image/svg+xml')).toBeUndefined()
    expect(mediaKindOfMimetype('image/jpeg')).toBe('image')
    expect(mediaKindOfMimetype('audio/ogg; codecs=opus')).toBe('audio')
    expect(mediaKindOfMimetype('video/mp4')).toBeUndefined()
    expect(mediaKindOfMimetype(null)).toBeUndefined()
  })

  it('downloads an image into a file with the extension of its format, under the same checks as an audio', async () => {
    const dir = mediaDir()
    const fetcher = createAudioFetcher({
      mediaDir: dir,
      openAudio: async () => Readable.from([Buffer.from('jpegbytes')]),
    })
    const result = await fetcher.fetch(audioMessage(9, 'image/jpeg'), KEY)
    expect(result).toEqual({ ok: true, value: mediaRefOf(KEY.conversationId, KEY.messageId, 'jpg') })
    let opened = 0
    const refusing = createAudioFetcher({
      mediaDir: mediaDir(),
      openAudio: async () => {
        opened++
        return Readable.from([Buffer.from('x')])
      },
    })
    expect(await refusing.fetch(audioMessage(9, 'image/jpeg', { directPath: '//evil/x' }), KEY)).toEqual({
      ok: false,
      error: 'invalid-media-path',
    })
    expect(await refusing.fetch(audioMessage(9, 'image/jpeg', { mediaKey: new Uint8Array(5) }), KEY)).toEqual({
      ok: false,
      error: 'invalid-media',
    })
    expect(opened).toBe(0)
  })

  it('an image has its own size limit (10 MB by default), apart from the one of an audio', async () => {
    const fetcher = createAudioFetcher({
      mediaDir: mediaDir(),
      openAudio: async () => Readable.from([Buffer.from('x')]),
    })
    expect(DEFAULT_MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024)
    expect(await fetcher.fetch(audioMessage(DEFAULT_MAX_IMAGE_BYTES + 1, 'image/jpeg'), KEY)).toEqual({
      ok: false,
      error: 'too-large',
    })
    // The same size is fine for an audio (25 MB limit).
    expect((await fetcher.fetch(audioMessage(DEFAULT_MAX_IMAGE_BYTES + 1), KEY)).ok).toBe(true)
    const small = createAudioFetcher({
      mediaDir: mediaDir(),
      maxImageBytes: 4,
      openAudio: async () => Readable.from([Buffer.from('0123456789')]),
    })
    expect(await small.fetch(audioMessage(undefined, 'image/jpeg'), KEY)).toEqual({ ok: false, error: 'too-large' })
  })

  it('gives the file the extension of its format, so the transcriber can force the right demuxer', async () => {
    for (const [mimetype, extension] of [
      ['audio/ogg; codecs=opus', 'ogg'],
      ['audio/mpeg', 'mp3'],
      ['audio/mp4', 'm4a'],
      ['audio/aac', 'aac'],
      ['audio/amr', 'amr'],
    ] as const) {
      const dir = mediaDir()
      const fetcher = createAudioFetcher({ mediaDir: dir, openAudio: async () => Readable.from([Buffer.from('x')]) })
      const result = await fetcher.fetch(audioMessage(undefined, mimetype), KEY)
      expect(result).toEqual({ ok: true, value: mediaRefOf(KEY.conversationId, KEY.messageId, extension) })
    }
  })

  it('refuses an unknown mimetype or none: unsupported-format, and the socket is never asked', async () => {
    for (const mimetype of ['video/mp4', 'application/zip', '']) {
      let opened = 0
      const fetcher = createAudioFetcher({
        mediaDir: mediaDir(),
        openAudio: async () => {
          opened++
          return Readable.from([Buffer.from('x')])
        },
      })
      expect(await fetcher.fetch(audioMessage(undefined, mimetype), KEY)).toEqual({
        ok: false,
        error: 'unsupported-format',
      })
      expect(opened).toBe(0)
    }
  })

  it('refuses a message with no usable directPath: invalid-media-path, and the socket is never asked', async () => {
    for (const directPath of ['', '@evil/x', '/a//b', 'https://evil.example/x', '/v/../x']) {
      let opened = 0
      const fetcher = createAudioFetcher({
        mediaDir: mediaDir(),
        openAudio: async () => {
          opened++
          return Readable.from([Buffer.from('x')])
        },
      })
      const result = await fetcher.fetch(audioMessage(undefined, 'audio/ogg', { directPath }), KEY)
      expect(result, directPath).toEqual({ ok: false, error: 'invalid-media-path' })
      expect(opened).toBe(0)
    }
  })

  it('refuses a key that is not 32 bytes: invalid-media, and the socket is never asked', async () => {
    let opened = 0
    const fetcher = createAudioFetcher({
      mediaDir: mediaDir(),
      openAudio: async () => {
        opened++
        return Readable.from([Buffer.from('x')])
      },
    })
    for (const mediaKey of [new Uint8Array(0), new Uint8Array(16), new Uint8Array(33)]) {
      expect(await fetcher.fetch(audioMessage(undefined, 'audio/ogg', { mediaKey }), KEY)).toEqual({
        ok: false,
        error: 'invalid-media',
      })
    }
    expect(opened).toBe(0)
  })

  it('does not even create the media directory for an audio it refuses', async () => {
    const dir = mediaDir()
    const fetcher = createAudioFetcher({ mediaDir: dir, openAudio: async () => Readable.from([Buffer.from('x')]) })
    await fetcher.fetch(audioMessage(undefined, 'audio/ogg', { directPath: '' }), KEY)
    expect(existsSync(dir)).toBe(false)
  })

  it('tells expired media (HTTP 403, 404 or 410, as Baileys throws it) from a network failure', async () => {
    for (const [status, expected] of [
      [410, 'expired'],
      [404, 'expired'],
      [403, 'expired'],
      [500, 'download-failed'],
      [undefined, 'download-failed'],
    ] as const) {
      const fetcher = createAudioFetcher({
        mediaDir: mediaDir(),
        openAudio: async () => {
          throw Object.assign(
            new Error('Failed to fetch stream'),
            status === undefined ? {} : { output: { statusCode: status } },
          )
        },
      })
      expect(await fetcher.fetch(audioMessage(), KEY), String(status)).toEqual({ ok: false, error: expected })
    }
  })

  it('classifies each failure for the queue: permanent, transient (counted) or unavailable (not counted)', () => {
    for (const permanent of [
      'too-large',
      'invalid-media-path',
      'invalid-media',
      'unsupported-format',
      'expired',
      'empty',
    ] as const) {
      expect(classifyFailure(permanent), permanent).toBe('permanent')
    }
    for (const transient of ['timeout', 'download-failed', 'write-failed'] as const) {
      expect(classifyFailure(transient), transient).toBe('transient')
    }
    // a full media folder is not the fault of the audio: it waits for room
    expect(classifyFailure('media-cap')).toBe('unavailable')
    expect(classifyFailure('aborted')).toBe('unavailable')
  })
})

describe('MEDIA CAP, abort and the connection going away', () => {
  it('refuses a download that would not fit in the media directory: media-cap', async () => {
    const dir = mediaDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'existing.ogg'), Buffer.alloc(80))
    let opened = 0
    const fetcher = createAudioFetcher({
      mediaDir: dir,
      maxDirBytes: 100,
      openAudio: async () => {
        opened++
        return Readable.from([Buffer.alloc(10)])
      },
    })
    expect(await fetcher.fetch(audioMessage(30), KEY)).toEqual({ ok: false, error: 'media-cap' }) // 80 + 30 > 100
    expect(opened).toBe(0)
    expect((await fetcher.fetch(audioMessage(20), KEY)).ok).toBe(true) // 80 + 20 fits
  })

  it('an audio bigger than the whole limit with an empty folder is too-large: waiting would never help', async () => {
    const dir = mediaDir()
    const fetcher = createAudioFetcher({
      mediaDir: dir,
      maxDirBytes: 100,
      openAudio: async () => Readable.from([Buffer.alloc(1)]),
    })
    expect(await fetcher.fetch(audioMessage(200), KEY)).toEqual({ ok: false, error: 'too-large' })
  })

  it('counts the partial files too, and a full folder refuses even an audio that announces no size', async () => {
    const dir = mediaDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.x.part'), Buffer.alloc(101))
    const fetcher = createAudioFetcher({
      mediaDir: dir,
      maxDirBytes: 100,
      openAudio: async () => Readable.from([Buffer.alloc(1)]),
    })
    expect(await fetcher.fetch(audioMessage(), KEY)).toEqual({ ok: false, error: 'media-cap' })
  })

  it('measures the directory: files only, 0 when it does not exist', async () => {
    const dir = mediaDir()
    expect(await mediaDirectoryBytes(dir)).toBe(0)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a'), Buffer.alloc(7))
    writeFileSync(join(dir, 'b'), Buffer.alloc(5))
    mkdirSync(join(dir, 'sub'))
    expect(await mediaDirectoryBytes(dir)).toBe(12)
  })

  it('is aborted by a signal: the stream is destroyed, the partial file removed, and the answer is aborted', async () => {
    const dir = mediaDir()
    const stuck = new PassThrough()
    stuck.write(Buffer.from('bytes, then silence'))
    const controller = new AbortController()
    const fetcher = createAudioFetcher({ mediaDir: dir, openAudio: async () => stuck })
    const running = fetcher.fetch(audioMessage(), KEY, controller.signal)
    await until(() => files(dir).some((name) => name.endsWith('.part')), 'a partial file')
    controller.abort()
    expect(await running).toEqual({ ok: false, error: 'aborted' })
    expect(stuck.destroyed).toBe(true)
    expect(files(dir)).toEqual([])
  })

  it('does nothing with a signal that is aborted already', async () => {
    const dir = mediaDir()
    let opened = 0
    const fetcher = createAudioFetcher({
      mediaDir: dir,
      openAudio: async () => {
        opened++
        return Readable.from([Buffer.from('x')])
      },
    })
    const controller = new AbortController()
    controller.abort()
    expect(await fetcher.fetch(audioMessage(), KEY, controller.signal)).toEqual({ ok: false, error: 'aborted' })
    expect(opened).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })

  it('is aborted while the socket is still opening, and closes the stream when it finally opens', async () => {
    const dir = mediaDir()
    let open: (stream: PassThrough) => void = () => {}
    const late = new Promise<PassThrough>((resolve) => {
      open = resolve
    })
    const controller = new AbortController()
    const fetcher = createAudioFetcher({ mediaDir: dir, openAudio: () => late })
    const running = fetcher.fetch(audioMessage(), KEY, controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    expect(await running).toEqual({ ok: false, error: 'aborted' })
    const stream = new PassThrough()
    open(stream)
    await until(() => stream.destroyed, 'the late stream to be closed')
    expect(files(dir)).toEqual([])
  })

  it('throws away a download that finishes after the connection went away: nothing is stored', async () => {
    const dir = mediaDir()
    let live = true
    const fetcher = createAudioFetcher({
      mediaDir: dir,
      isLive: () => live,
      openAudio: async () => {
        // the last bytes arrive, and the connection is gone before the file would be put in place
        const stream = new Readable({
          read() {
            live = false
            this.push(Buffer.from('last bytes'))
            this.push(null)
          },
        })
        return stream
      },
    })
    expect(await fetcher.fetch(audioMessage(), KEY)).toEqual({ ok: false, error: 'aborted' })
    expect(files(dir)).toEqual([])
  })

  it('does not start when the connection is already gone', async () => {
    let opened = 0
    const fetcher = createAudioFetcher({
      mediaDir: mediaDir(),
      isLive: () => false,
      openAudio: async () => {
        opened++
        return Readable.from([Buffer.from('x')])
      },
    })
    expect(await fetcher.fetch(audioMessage(), KEY)).toEqual({ ok: false, error: 'aborted' })
    expect(opened).toBe(0)
  })
})

describe('downloading an audio (RF-15)', () => {
  describe('a good download', () => {
    it('stores the bytes under a file name derived from the ids, and returns that name as the media reference', async () => {
      const dir = mediaDir()
      const fetcher = createAudioFetcher({
        mediaDir: dir,
        openAudio: async () => Readable.from([Buffer.from('OggS fake voice note')]),
      })
      const result = await fetcher.fetch(audioMessage(20), KEY)
      const ref = mediaRefOf(KEY.conversationId, KEY.messageId)
      expect(result).toEqual({ ok: true, value: ref })
      expect(ref).toMatch(/^[0-9a-f]{32}\.ogg$/)
      expect(ref).not.toContain('9961674862244') // the number of the contact is not in the file name
      expect(readFileSync(join(dir, ref), 'utf8')).toBe('OggS fake voice note')
      expect(files(dir)).toEqual([ref]) // no temporary file left
    })

    it('passes the descriptor to the socket to open', async () => {
      const dir = mediaDir()
      const asked: AudioDescriptor[] = []
      const fetcher = createAudioFetcher({
        mediaDir: dir,
        openAudio: async (message) => {
          asked.push(message)
          return Readable.from([Buffer.from('x')])
        },
      })
      const message = audioMessage()
      await fetcher.fetch(message, KEY)
      expect(asked).toEqual([message])
    })

    it('gives two messages two files, and the same message always the same one', async () => {
      expect(mediaRefOf('a', 'm1')).toBe(mediaRefOf('a', 'm1'))
      expect(mediaRefOf('a', 'm1')).not.toBe(mediaRefOf('a', 'm2'))
      expect(mediaRefOf('a', 'm1')).not.toBe(mediaRefOf('b', 'm1'))
      // The separator is part of the input: ("ab","c") and ("a","bc") are not the same message.
      expect(mediaRefOf('ab', 'c')).not.toBe(mediaRefOf('a', 'bc'))
    })

    it('an id that looks like a path cannot make a path: the name is a hash', async () => {
      const dir = mediaDir()
      const fetcher = createAudioFetcher({ mediaDir: dir, openAudio: async () => Readable.from([Buffer.from('x')]) })
      const result = await fetcher.fetch(audioMessage(), { conversationId: 'c', messageId: '../../etc/passwd' })
      expect(result.ok).toBe(true)
      expect(files(dir)).toHaveLength(1)
      expect(files(dir)[0]).toMatch(/^[0-9a-f]{32}\.ogg$/)
    })
  })

  describe('permissions (RNF-04)', () => {
    posix('creates the media directory private (0700) and the audio file private (0600)', async () => {
      const dir = mediaDir()
      const fetcher = createAudioFetcher({
        mediaDir: dir,
        openAudio: async () => Readable.from([Buffer.from('audio')]),
      })
      const result = await fetcher.fetch(audioMessage(), KEY)
      expect(result.ok).toBe(true)
      expect(MEDIA_DIR_MODE).toBe(0o700)
      expect(MEDIA_FILE_MODE).toBe(0o600)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      if (result.ok) expect(statSync(join(dir, result.value)).mode & 0o777).toBe(0o600)
    })

    posix('tightens a media directory that existed with looser permissions', async () => {
      const dir = mediaDir()
      mkdirSync(dir, { recursive: true })
      chmodSync(dir, 0o755)
      const fetcher = createAudioFetcher({
        mediaDir: dir,
        openAudio: async () => Readable.from([Buffer.from('audio')]),
      })
      await fetcher.fetch(audioMessage(), KEY)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    })

    posix('refuses to write through a link where the media directory should be', async () => {
      const dir = mediaDir()
      const elsewhere = mkdtempSync(join(tmpdir(), 'msum-elsewhere-'))
      roots.push(elsewhere)
      mkdirSync(join(dir, '..'), { recursive: true })
      symlinkSync(elsewhere, dir)
      const fetcher = createAudioFetcher({
        mediaDir: dir,
        openAudio: async () => Readable.from([Buffer.from('audio')]),
      })
      expect(await fetcher.fetch(audioMessage(), KEY)).toEqual({ ok: false, error: 'write-failed' })
      expect(readdirSync(elsewhere)).toEqual([])
    })
  })

  describe('a download that fails is reported, never thrown, and leaves no file', () => {
    it('the media is gone (the socket cannot open it): download-failed', async () => {
      const dir = mediaDir()
      const fetcher = createAudioFetcher({
        mediaDir: dir,
        openAudio: async () => {
          throw new Error('Request failed with status code 410')
        },
      })
      expect(await fetcher.fetch(audioMessage(), KEY)).toEqual({ ok: false, error: 'download-failed' })
      expect(files(dir)).toEqual([])
    })

    it('the stream breaks half way: download-failed, and the half file is removed', async () => {
      const dir = mediaDir()
      const broken = new Readable({
        read() {
          this.push(Buffer.from('first half'))
          this.destroy(new Error('connection reset'))
        },
      })
      const fetcher = createAudioFetcher({ mediaDir: dir, openAudio: async () => broken })
      expect(await fetcher.fetch(audioMessage(), KEY)).toEqual({ ok: false, error: 'download-failed' })
      expect(files(dir)).toEqual([])
    })

    it('an empty stream is not an audio: empty', async () => {
      const dir = mediaDir()
      const fetcher = createAudioFetcher({ mediaDir: dir, openAudio: async () => Readable.from([]) })
      expect(await fetcher.fetch(audioMessage(), KEY)).toEqual({ ok: false, error: 'empty' })
      expect(files(dir)).toEqual([])
    })
  })

  describe('SIZE CAP', () => {
    it('refuses a file that announces itself as too big, without opening it', async () => {
      const dir = mediaDir()
      let opened = 0
      const fetcher = createAudioFetcher({
        mediaDir: dir,
        maxBytes: 1000,
        openAudio: async () => {
          opened++
          return Readable.from([Buffer.from('x')])
        },
      })
      expect(await fetcher.fetch(audioMessage(1001), KEY)).toEqual({ ok: false, error: 'too-large' })
      expect(opened).toBe(0)
      expect(files(dir)).toEqual([])
    })

    it('accepts a file of exactly the limit', async () => {
      const dir = mediaDir()
      const fetcher = createAudioFetcher({
        mediaDir: dir,
        maxBytes: 1000,
        openAudio: async () => Readable.from([Buffer.alloc(1000, 1)]),
      })
      expect((await fetcher.fetch(audioMessage(1000), KEY)).ok).toBe(true)
    })

    it('cuts off a stream that grows past the limit, whatever the message announced', async () => {
      const dir = mediaDir()
      const endless = new Readable({
        read() {
          this.push(Buffer.alloc(400, 9))
        },
      })
      const fetcher = createAudioFetcher({ mediaDir: dir, maxBytes: 1000, openAudio: async () => endless })
      // It announced 10 bytes (a lie) and sends forever: the download ends, the stream is closed and nothing is kept.
      expect(await fetcher.fetch(audioMessage(10), KEY)).toEqual({ ok: false, error: 'too-large' })
      expect(endless.destroyed).toBe(true)
      expect(files(dir)).toEqual([])
    })

    it('has a default limit that is large for a voice note and small for a movie', () => {
      expect(DEFAULT_MAX_AUDIO_BYTES).toBe(25 * 1024 * 1024)
    })
  })

  describe('the time limit', () => {
    it('gives up on a stream that never ends: timeout, the partial file removed and the stream closed', async () => {
      const dir = mediaDir()
      const stuck = new PassThrough()
      stuck.write(Buffer.from('some bytes, then silence'))
      const fetcher = createAudioFetcher({ mediaDir: dir, timeoutMs: 80, openAudio: async () => stuck })
      const started = Date.now()
      expect(await fetcher.fetch(audioMessage(), KEY)).toEqual({ ok: false, error: 'timeout' })
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(stuck.destroyed).toBe(true)
      expect(files(dir)).toEqual([])
    })

    it('gives up on a download that never even opens: timeout', async () => {
      const dir = mediaDir()
      const fetcher = createAudioFetcher({
        mediaDir: dir,
        timeoutMs: 50,
        openAudio: () => new Promise<Readable>(() => {}),
      })
      expect(await fetcher.fetch(audioMessage(), KEY)).toEqual({ ok: false, error: 'timeout' })
      expect(files(dir)).toEqual([])
    })
  })

  it('leaves a file that was written before alone when a replay fails', async () => {
    const dir = mediaDir()
    const good = createAudioFetcher({ mediaDir: dir, openAudio: async () => Readable.from([Buffer.from('first')]) })
    const first = await good.fetch(audioMessage(), KEY)
    const bad = createAudioFetcher({
      mediaDir: dir,
      openAudio: async () => {
        throw new Error('gone')
      },
    })
    expect(await bad.fetch(audioMessage(), KEY)).toEqual({ ok: false, error: 'download-failed' })
    expect(first.ok).toBe(true)
    if (first.ok) expect(readFileSync(join(dir, first.value), 'utf8')).toBe('first')
  })
})
