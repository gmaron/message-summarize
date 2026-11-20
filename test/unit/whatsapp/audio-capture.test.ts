import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createCaptureMessages } from '../../../src/application/capture-messages.js'
import type { DownloadOutcome } from '../../../src/application/download-audios.js'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import {
  SqliteCaptureRepository,
  SqliteCaptureWriter,
  SqliteTranscriptionStore,
} from '../../../src/infrastructure/persistence/sqlite/index.js'
import { createWhatsAppConnection, OwnConversationIds } from '../../../src/infrastructure/whatsapp/index.js'
import { mediaRefOf } from '../../../src/infrastructure/whatsapp/media.js'
import { createTranslator } from '../../../src/infrastructure/whatsapp/translate.js'
import type { WaMessage } from '../../../src/infrastructure/whatsapp/wa-types.js'
import { FixedClock } from '../../support/application-fakes.js'
import { until } from '../../support/cli-harness.js'
import { TempDatabase } from '../../support/persistence-backends.js'
import { fakeSocketFactory, recordingCapture } from '../../support/whatsapp-fakes.js'

const ANA = '9911963367943@s.whatsapp.net'
const NOW = 1_800_000_000_000
const SECONDS = NOW / 1000
const DAY = 86_400

/** The decryption key of the audios of these tests. */
const SECRET_KEY = Buffer.alloc(32, 0xab)
const DIRECT_PATH = '/v/t62.7117-24/123_456_n.enc?ccb=11-4&oh=abc&oe=65f0&_nc_sid=5e03e0'

const audio = (id: string, extra: Partial<WaMessage> = {}): WaMessage => ({
  key: { remoteJid: ANA, id, fromMe: false },
  message: {
    audioMessage: {
      fileLength: 20,
      mimetype: 'audio/ogg; codecs=opus',
      directPath: DIRECT_PATH,
      mediaKey: SECRET_KEY,
    },
  },
  messageTimestamp: SECONDS - 60,
  ...extra,
})
const withAudio = (audioMessage: Record<string, unknown>, id = 'X1'): WaMessage => ({
  key: { remoteJid: ANA, id, fromMe: false },
  message: { audioMessage },
  messageTimestamp: SECONDS - 60,
})

const roots: string[] = []
const temps: TempDatabase[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const temp of temps.splice(0)) temp.dispose()
})

describe('the translator hands the capture the download descriptor (RF-15, RNF-08)', () => {
  /** A capture that says "download it" for every audio, and records what the translator reports back. */
  function setup(downloadAudio: boolean, ports: Partial<Parameters<typeof createTranslator>[0]> = {}) {
    const { capture, calls } = recordingCapture()
    const received = capture.receiveMessage
    capture.receiveMessage = async (event) => {
      const outcome = await received(event)
      return { ...outcome, downloadAudio: downloadAudio && event.message.kind === 'audio' }
    }
    let kicks = 0
    const translator = createTranslator({
      capture,
      catalog: getCatalog('es'),
      clock: new FixedClock(NOW),
      ownIds: new OwnConversationIds(),
      audio: {
        kick: () => {
          kicks++
        },
      },
      ...ports,
    })
    const reported = () =>
      calls.filter((c) => c.method === 'queueMedia' || c.method === 'mediaFailed').map((c) => [c.method, c.event])
    return { translator, calls, reported, kicks: () => kicks }
  }

  it('queues a live audio the capture asks for, with the path, the key, the format and the size, and wakes the worker', async () => {
    const t = setup(true)
    await t.translator.messagesUpsert({ type: 'notify', messages: [audio('A1')] })
    expect(t.reported()).toEqual([
      [
        'queueMedia',
        {
          conversationId: ANA,
          isGroup: false,
          conversationName: null,
          messageId: 'A1',
          descriptor: {
            directPath: DIRECT_PATH,
            mediaKey: new Uint8Array(SECRET_KEY),
            mimetype: 'audio/ogg; codecs=opus',
            fileLength: 20,
          },
        },
      ],
    ])
    expect(t.kicks()).toBe(1)
  })

  it('queues the audios of the history sync that the capture asks for (those of the last N days, RF-15)', async () => {
    const t = setup(true)
    await t.translator.historySet({ chats: [], contacts: [], messages: [audio('H1'), audio('H2')] })
    expect(t.reported().map(([method, event]) => [method, (event as { messageId: string }).messageId])).toEqual([
      ['queueMedia', 'H1'],
      ['queueMedia', 'H2'],
    ])
  })

  it('does not queue what the capture does not ask for (older than N days, a transcript is there, or queued before)', async () => {
    const t = setup(false)
    await t.translator.historySet({ chats: [], contacts: [], messages: [audio('H1')] })
    await t.translator.messagesUpsert({ type: 'notify', messages: [audio('A1')] })
    expect(t.reported()).toEqual([])
    expect(t.kicks()).toBe(0)
    expect(t.calls.filter((c) => c.method === 'receiveMessage')).toHaveLength(2) // they are still captured
  })

  it('without the audio port (transcription off) nothing is queued or recorded', async () => {
    const t = setup(true, { audio: undefined })
    await t.translator.messagesUpsert({ type: 'notify', messages: [audio('A1')] })
    expect(t.reported()).toEqual([])
  })

  it('accepts the key as base64 text too', async () => {
    const t = setup(true)
    const message = audio('A1')
    ;(message.message?.audioMessage as { mediaKey: unknown }).mediaKey = SECRET_KEY.toString('base64')
    await t.translator.messagesUpsert({ type: 'notify', messages: [message] })
    const [first] = t.reported()
    const event = first?.[1] as { descriptor: { mediaKey: Uint8Array } }
    expect(event.descriptor.mediaKey).toEqual(new Uint8Array(SECRET_KEY))
  })

  describe('what the sender wrote is checked here: an audio that can never be downloaded is recorded and NOT queued', () => {
    const ok = { mimetype: 'audio/ogg', mediaKey: SECRET_KEY }
    const cases: [string, Record<string, unknown>, string][] = [
      ['only a url to a host of the sender', { url: 'https://evil.example/x', ...ok }, 'invalid-media-path'],
      ['a url to the local network', { url: 'http://192.168.1.10/admin', ...ok }, 'invalid-media-path'],
      ['no directPath', { ...ok }, 'invalid-media-path'],
      ['a directPath that starts with @', { directPath: '@evil.example/x', ...ok }, 'invalid-media-path'],
      ['a directPath with @ inside', { directPath: '/v/x@evil.example', ...ok }, 'invalid-media-path'],
      ['a whole address as directPath', { directPath: 'https://evil.example/x', ...ok }, 'invalid-media-path'],
      ['a protocol-relative directPath', { directPath: '//evil.example/x', ...ok }, 'invalid-media-path'],
      ['a directPath with a backslash', { directPath: '/v\\evil', ...ok }, 'invalid-media-path'],
      ['a directPath that climbs out', { directPath: '/v/../../admin', ...ok }, 'invalid-media-path'],
      ['an empty directPath', { directPath: '', ...ok }, 'invalid-media-path'],
      [
        'a format that is not audio',
        { directPath: DIRECT_PATH, mimetype: 'video/x-matroska', mediaKey: SECRET_KEY },
        'unsupported-format',
      ],
      ['no format', { directPath: DIRECT_PATH, mediaKey: SECRET_KEY }, 'unsupported-format'],
      ['no key', { directPath: DIRECT_PATH, mimetype: 'audio/ogg' }, 'invalid-media'],
      [
        'a key of the wrong size',
        { directPath: DIRECT_PATH, mimetype: 'audio/ogg', mediaKey: Buffer.alloc(16) },
        'invalid-media',
      ],
    ]
    for (const [name, audioMessage, reason] of cases) {
      it(`${name}: ${reason}`, async () => {
        const t = setup(true)
        await t.translator.messagesUpsert({ type: 'notify', messages: [withAudio(audioMessage)] })
        expect(t.reported()).toEqual([
          ['mediaFailed', { conversationId: ANA, isGroup: false, conversationName: null, messageId: 'X1', reason }],
        ])
        expect(t.kicks()).toBe(0) // nothing was queued: nothing to wake
      })
    }
  })

  it('an error while handing the audio over is a warning, never a failure of the capture: the next audio still goes', async () => {
    const warnings: string[] = []
    const failing = {
      ...recordingCapture().capture,
      receiveMessage: async () => ({ stored: true, isNew: true, downloadAudio: true }),
      queueMedia: async () => {
        throw new Error('disk on fire')
      },
    }
    const translator = createTranslator({
      capture: failing,
      catalog: getCatalog('es'),
      clock: new FixedClock(NOW),
      ownIds: new OwnConversationIds(),
      audio: { kick: () => undefined },
      onWarning: (code) => warnings.push(code),
    })
    await translator.messagesUpsert({ type: 'notify', messages: [audio('A1'), audio('A2')] })
    expect(warnings).toEqual(['item-failed', 'item-failed'])
  })
})

describe('the WhatsApp connection, the capture and SQLite together (RF-15, RNF-08)', () => {
  /** One installation: a database, a media directory and a capture, which several connections can work on in turn. */
  function world(media: { maxDirBytes?: number; maxAttempts?: number } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'msum-audio-'))
    roots.push(root)
    const mediaDir = join(root, 'media')
    const temp = new TempDatabase()
    temps.push(temp)
    const db = temp.open()
    const clock = new FixedClock(NOW)
    const capture = createCaptureMessages({
      repository: new SqliteCaptureRepository(new SqliteCaptureWriter(db, () => NOW)),
      clock,
      excludePatterns: () => [],
      ownConversationIds: () => [],
    })
    const queue = new SqliteTranscriptionStore(db)
    const warnings: string[] = []
    const outcomes: DownloadOutcome[] = []
    let downloaded = 0
    const connect = () => {
      const fake = fakeSocketFactory()
      const connection = createWhatsAppConnection({
        authDir: join(root, 'auth'),
        language: 'es',
        capture,
        clock,
        ownIds: new OwnConversationIds(),
        socketFactory: fake.factory,
        media: {
          mediaDir,
          queue,
          ...media,
          onDownloaded: () => {
            downloaded++
          },
          onOutcome: (outcome) => outcomes.push(outcome),
        },
        onWarning: (code) => warnings.push(code),
      })
      return {
        connection,
        fake,
        /** Starts the connection and opens it, as WhatsApp does; returns its fake socket. */
        async open() {
          await connection.start()
          const socket = fake.sockets.at(-1)
          if (socket === undefined) throw new Error('no socket')
          socket.ev.emit('connection.update', { connection: 'open' })
          return socket
        },
      }
    }
    interface Row {
      id: string
      media_ref: string | null
      transcribe_status: string | null
      transcribe_error: string | null
      dl_attempts: number
      has_descriptor: number
    }
    const rows = (): Row[] =>
      db
        .prepare(
          `SELECT id, media_ref, transcribe_status, transcribe_error, dl_attempts,
                  (dl_direct_path IS NOT NULL OR dl_media_key IS NOT NULL) AS has_descriptor
           FROM messages ORDER BY timestamp, seq`,
        )
        .all() as unknown as Row[]
    const statuses = (): Record<string, string | null> =>
      Object.fromEntries(rows().map((r) => [r.id, r.transcribe_status]))
    const files = (): string[] => (existsSync(mediaDir) ? readdirSync(mediaDir).sort() : [])
    return {
      db,
      mediaDir,
      queue,
      capture,
      clock,
      connect,
      rows,
      statuses,
      files,
      warnings,
      outcomes,
      downloaded: () => downloaded,
    }
  }

  const history = (...messages: WaMessage[]) => ({ chats: [], contacts: [], messages })

  it('downloads a live voice note into media/ (0700, files 0600), queues it for transcription and clears the key', async () => {
    const w = world()
    const c = w.connect()
    const socket = await c.open()
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [audio('A1')] })
    await until(() => w.statuses().A1 === 'pending', 'the audio to be downloaded')
    const ref = mediaRefOf(ANA, 'A1')
    expect(w.rows()).toEqual([
      {
        id: 'A1',
        media_ref: ref,
        transcribe_status: 'pending',
        transcribe_error: null,
        dl_attempts: 0,
        has_descriptor: 0, // the decryption key is gone from the database
      },
    ])
    expect(readFileSync(join(w.mediaDir, ref), 'utf8')).toBe('fake ogg bytes')
    expect(w.downloaded()).toBe(1)
    expect(socket.audioRequests).toEqual([
      {
        directPath: DIRECT_PATH,
        mediaKey: new Uint8Array(SECRET_KEY),
        mimetype: 'audio/ogg; codecs=opus',
        fileLength: 20,
      },
    ])
    if (process.platform !== 'win32') {
      expect(statSync(w.mediaDir).mode & 0o777).toBe(0o700)
      expect(statSync(join(w.mediaDir, ref)).mode & 0o777).toBe(0o600)
    }
    expect(socket.forbiddenCalls).toEqual([]) // it only downloaded: nothing was sent
    await c.connection.stop()
  })

  it('a replay of the same message does not download it again', async () => {
    const w = world()
    const c = w.connect()
    const socket = await c.open()
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [audio('A1')] })
    await until(() => w.statuses().A1 === 'pending', 'the audio to be downloaded')
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [audio('A1')] })
    await c.connection.stop()
    expect(socket.audioRequests).toHaveLength(1)
    expect(w.downloaded()).toBe(1)
  })

  it('downloads the audios of the history of the last N days (RF-15), and leaves older ones as untranscribed audio', async () => {
    const w = world() // the default: 14 days
    const c = w.connect()
    const socket = await c.open()
    socket.ev.emit(
      'messaging-history.set',
      history(
        audio('recent', { messageTimestamp: SECONDS - 13 * DAY }),
        audio('old', { messageTimestamp: SECONDS - 15 * DAY }),
      ),
    )
    await until(() => w.statuses().recent === 'pending', 'the recent audio to be downloaded')
    expect(w.statuses()).toEqual({ old: null, recent: 'pending' })
    expect(socket.audioRequests).toHaveLength(1)
    await c.connection.stop()
  })

  describe('what the sender writes in the message never chooses where we connect (SSRF)', () => {
    const ok = { mimetype: 'audio/ogg', mediaKey: SECRET_KEY }
    const hostile: [string, Record<string, unknown>][] = [
      ['only a url to a host of the sender', { url: 'https://evil.example/steal.enc', ...ok }],
      ['only a url to the local network', { url: 'http://192.168.1.10:8080/admin', ...ok }],
      ['no directPath at all', { ...ok }],
      ['a directPath that starts with @', { directPath: '@evil.example/x', ...ok }],
      ['a protocol-relative directPath', { directPath: '//evil.example/x', ...ok }],
      ['a directPath that climbs out', { directPath: '/v/../../admin', ...ok }],
    ]
    for (const [name, audioMessage] of hostile) {
      it(`${name}: recorded as invalid-media-path, never queued, nothing requested`, async () => {
        const w = world()
        const c = w.connect()
        const socket = await c.open()
        socket.ev.emit('messages.upsert', { type: 'notify', messages: [withAudio(audioMessage)] })
        await until(() => w.statuses().X1 === 'failed', 'the failure to be recorded')
        // Asserted on the fake socket: it was never asked to open anything.
        expect(socket.audioRequests).toEqual([])
        expect(w.rows()[0]).toMatchObject({ transcribe_error: 'invalid-media-path', has_descriptor: 0 })
        expect(await w.queue.countDownloads()).toBe(0)
        expect(w.files()).toEqual([])
        await c.connection.stop()
      })
    }
  })

  it('an audio format that is not one of WhatsApp is recorded as unsupported-format, with nothing requested', async () => {
    const w = world()
    const c = w.connect()
    const socket = await c.open()
    socket.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [withAudio({ directPath: DIRECT_PATH, mimetype: 'video/x-matroska', mediaKey: SECRET_KEY })],
    })
    await until(() => w.statuses().X1 === 'failed', 'the failure to be recorded')
    expect(w.rows()[0]?.transcribe_error).toBe('unsupported-format')
    expect(socket.audioRequests).toEqual([])
    await c.connection.stop()
  })

  it('without the media option (transcription off) nothing is queued, downloaded or created', async () => {
    const root = mkdtempSync(join(tmpdir(), 'msum-audio-'))
    roots.push(root)
    const temp = new TempDatabase()
    temps.push(temp)
    const db = temp.open()
    const fake = fakeSocketFactory()
    const clock = new FixedClock(NOW)
    const connection = createWhatsAppConnection({
      authDir: join(root, 'auth'),
      language: 'es',
      capture: createCaptureMessages({
        repository: new SqliteCaptureRepository(new SqliteCaptureWriter(db, () => NOW)),
        clock,
        excludePatterns: () => [],
        ownConversationIds: () => [],
      }),
      clock,
      ownIds: new OwnConversationIds(),
      socketFactory: fake.factory,
    })
    await connection.start()
    const socket = fake.sockets[0]
    socket?.ev.emit('connection.update', { connection: 'open' })
    socket?.ev.emit('messages.upsert', { type: 'notify', messages: [audio('A1')] })
    await connection.stop()
    expect(socket?.audioRequests).toEqual([])
    expect(existsSync(join(root, 'media'))).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n, MAX(transcribe_status) AS s FROM messages').get()).toEqual({
      n: 1,
      s: null,
    })
  })

  describe('the durable queue: nothing received is lost to a restart (RNF-08)', () => {
    it('300 history audios are ALL downloaded eventually, one at a time (the first link of a busy account)', async () => {
      const w = world()
      const c = w.connect()
      const socket = await c.open()
      let running = 0
      let most = 0
      let served = 0
      ;(socket.socket as { openAudio: unknown }).openAudio = async () => {
        running++
        most = Math.max(most, running)
        await new Promise((resolve) => setImmediate(resolve))
        running--
        served++
        return Readable.from([Buffer.from('voice note')])
      }
      const messages = Array.from({ length: 300 }, (_, i) =>
        audio(`h${String(i).padStart(3, '0')}`, { messageTimestamp: SECONDS - 3600 + i }),
      )
      socket.ev.emit('messaging-history.set', history(...messages))
      // Legitimately slow on a loaded runner (300 downloads, each with its own writes). So the wait is not a fixed total
      // time but a stall check: it fails only when no download completes for 30 s. Progress is read from a counter, not
      // by scanning the 300 rows every few milliseconds, which would itself slow the work down.
      let seen = -1
      let lastProgress = Date.now()
      await until(
        () => {
          if (served !== seen) {
            seen = served
            lastProgress = Date.now()
          }
          if (Date.now() - lastProgress > 30_000) throw new Error(`no audio was downloaded for 30 s (${served} of 300)`)
          return served === 300
        },
        'all 300 audios to be downloaded',
        600_000,
      )
      await until(
        () => w.rows().filter((r) => r.transcribe_status === 'pending').length === 300,
        'all 300 audios to be stored as pending',
        30_000,
      )
      expect(most).toBe(1)
      expect(w.files()).toHaveLength(300)
      expect(await w.queue.countDownloads()).toBe(0)
      expect(w.rows().every((r) => r.has_descriptor === 0)).toBe(true)
      await c.connection.stop()
    }, 660_000) // only the ceiling: the stall check above fails a stuck queue after 30 s

    it('a restart in the middle of the queue resumes where it stopped: all are downloaded, none twice', async () => {
      const w = world()
      const first = w.connect()
      const socket = await first.open()
      let served = 0
      ;(socket.socket as { openAudio: unknown }).openAudio = async () => {
        served++
        // the fourth download hangs: the process is stopped while it is in the air
        if (served === 4) return new PassThrough()
        return Readable.from([Buffer.from(`note ${served}`)])
      }
      const messages = Array.from({ length: 10 }, (_, i) => audio(`a${i}`, { messageTimestamp: SECONDS - 3600 + i }))
      socket.ev.emit('messaging-history.set', history(...messages))
      await until(() => served === 4, 'the fourth download to start')
      await first.connection.stop()
      expect(
        w
          .rows()
          .filter((r) => r.transcribe_status === 'pending')
          .map((r) => r.id),
      ).toEqual(['a0', 'a1', 'a2'])
      expect(w.rows().filter((r) => r.transcribe_status === 'download_pending')).toHaveLength(7) // a3 and the rest wait
      expect(w.rows().find((r) => r.id === 'a3')).toMatchObject({ dl_attempts: 0, has_descriptor: 1 })
      expect(w.files()).toHaveLength(3) // no partial file

      // After the restart (a new connection over the same database) the rest is downloaded, starting at a3.
      const second = w.connect()
      const socket2 = await second.open()
      await until(
        () => w.rows().filter((r) => r.transcribe_status === 'pending').length === 10,
        'the rest to be downloaded',
      )
      expect(socket2.audioRequests).toHaveLength(7) // a3 .. a9: the three done before are not asked for again
      expect(w.files()).toHaveLength(10)
      await second.connection.stop()
    })

    it('an abort keeps the row queued (uncounted), with no partial file, and the next run completes it', async () => {
      const w = world()
      const first = w.connect()
      const socket = await first.open()
      const stuck = new PassThrough()
      stuck.write(Buffer.from('some bytes, then silence'))
      ;(socket.socket as { openAudio: unknown }).openAudio = async () => stuck
      socket.ev.emit('messages.upsert', { type: 'notify', messages: [audio('A1')] })
      await until(() => w.files().some((name) => name.endsWith('.part')), 'a partial file')
      await first.connection.stop()
      expect(stuck.destroyed).toBe(true)
      expect(w.files()).toEqual([])
      expect(w.rows()[0]).toMatchObject({ transcribe_status: 'download_pending', dl_attempts: 0, has_descriptor: 1 })

      const second = w.connect()
      await second.open()
      await until(() => w.statuses().A1 === 'pending', 'the audio to be downloaded after the restart')
      expect(w.files()).toEqual([mediaRefOf(ANA, 'A1')])
      await second.connection.stop()
    })

    it('a connection that drops aborts the download in progress; the audio stays queued', async () => {
      const w = world()
      const c = w.connect()
      const socket = await c.open()
      const stuck = new PassThrough()
      ;(socket.socket as { openAudio: unknown }).openAudio = async () => stuck
      socket.ev.emit('messages.upsert', { type: 'notify', messages: [audio('A1')] })
      await until(() => w.files().some((name) => name.endsWith('.part')), 'a partial file')
      socket.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 408 } } },
      })
      await until(() => stuck.destroyed, 'the stream to be closed')
      expect(w.rows()[0]).toMatchObject({ transcribe_status: 'download_pending', dl_attempts: 0 })
      await c.connection.stop()
    })

    it('audios queued before the connection was open are downloaded as soon as it opens', async () => {
      const w = world()
      const c = w.connect()
      // queued by an earlier run (what capture stored), with no connection yet
      await w.capture.receiveMessage({
        origin: 'live',
        isGroup: false,
        message: {
          id: 'old-run',
          conversationId: ANA,
          senderId: ANA,
          senderName: null,
          senderAddress: '+9911963367943',
          fromMe: false,
          timestamp: NOW - 1000,
          kind: 'audio',
          text: '[audio]',
          transcript: null,
          read: false,
        },
      })
      await w.capture.queueMedia({
        conversationId: ANA,
        isGroup: false,
        messageId: 'old-run',
        descriptor: {
          directPath: DIRECT_PATH,
          mediaKey: new Uint8Array(SECRET_KEY),
          mimetype: 'audio/ogg',
          fileLength: 5,
        },
      })
      expect(await w.queue.countDownloads()).toBe(1)
      c.connection.kickDownloads() // not connected: nothing happens, nothing is counted
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(w.rows()[0]).toMatchObject({ transcribe_status: 'download_pending', dl_attempts: 0 })
      await c.open()
      await until(() => w.statuses()['old-run'] === 'pending', 'the audio to be downloaded')
      await c.connection.stop()
    })

    it('a permanent failure is recorded with its code: media expired on the server (HTTP 410), too big, folder full', async () => {
      const w = world({ maxDirBytes: 30 })
      const c = w.connect()
      const socket = await c.open()
      socket.audioFailure = Object.assign(new Error('Failed to fetch stream'), { output: { statusCode: 410 } })
      socket.ev.emit('messages.upsert', {
        type: 'notify',
        messages: [audio('gone', { messageTimestamp: SECONDS - 300 })],
      })
      await until(() => w.statuses().gone === 'failed', 'the failure to be recorded')
      expect(w.rows()[0]).toMatchObject({ transcribe_error: 'expired', has_descriptor: 0, dl_attempts: 0 })

      socket.audioFailure = undefined
      socket.ev.emit('messages.upsert', {
        type: 'notify',
        messages: [
          withAudio(
            { directPath: DIRECT_PATH, mimetype: 'audio/ogg', mediaKey: SECRET_KEY, fileLength: 99_999_999_999 },
            'big',
          ),
        ],
      })
      await until(() => w.statuses().big === 'failed', 'the second failure')
      expect(w.rows().find((r) => r.id === 'big')?.transcribe_error).toBe('too-large')

      // the folder: 25 bytes are in, the limit is 30 and the next announces 20
      socket.audioBytes = Buffer.from('0123456789012345678901234')
      socket.ev.emit('messages.upsert', {
        type: 'notify',
        messages: [audio('fits', { messageTimestamp: SECONDS - 200 })],
      })
      await until(() => w.statuses().fits === 'pending', 'the audio that fits')
      socket.ev.emit('messages.upsert', {
        type: 'notify',
        messages: [audio('full', { messageTimestamp: SECONDS - 100 })],
      })
      await until(() => w.statuses().full === 'failed', 'the refusal')
      expect(w.rows().find((r) => r.id === 'full')?.transcribe_error).toBe('media-cap')
      await c.connection.stop()
    })

    it('after N transient failures (a network that keeps failing) the row becomes failed (download-failed), one per sweep', async () => {
      const w = world({ maxAttempts: 3 })
      const c = w.connect()
      const socket = await c.open()
      socket.audioFailure = new Error('connection reset') // no HTTP status: the network
      socket.ev.emit('messages.upsert', { type: 'notify', messages: [audio('A1')] })
      await until(() => w.rows()[0]?.dl_attempts === 1, 'the first failure to be counted')
      expect(w.rows()[0]).toMatchObject({ transcribe_status: 'download_pending', has_descriptor: 1 })
      c.connection.kickDownloads() // a sweep too soon: the backoff is not over, nothing is tried
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(socket.audioRequests).toHaveLength(1)
      w.clock.time += 31_000 // the backoff (30 s) is over
      c.connection.kickDownloads() // the sweep of the daemon
      await until(() => w.rows()[0]?.dl_attempts === 2, 'the second failure')
      w.clock.time += 61_000 // the second backoff (1 min) is over
      c.connection.kickDownloads()
      await until(() => w.statuses().A1 === 'failed', 'the third failure to end it')
      expect(w.rows()[0]).toMatchObject({ transcribe_error: 'download-failed', has_descriptor: 0 })
      expect(socket.audioRequests).toHaveLength(3)
      await c.connection.stop()
    })

    it('a transient failure followed by a good network completes the audio, and the attempts are forgotten', async () => {
      const w = world()
      const c = w.connect()
      const socket = await c.open()
      socket.audioFailure = new Error('connection reset')
      socket.ev.emit('messages.upsert', { type: 'notify', messages: [audio('A1')] })
      await until(() => w.rows()[0]?.dl_attempts === 1, 'the failure to be counted')
      socket.audioFailure = undefined
      w.clock.time += 31_000 // the backoff is over
      c.connection.kickDownloads()
      await until(() => w.statuses().A1 === 'pending', 'the audio to be downloaded')
      expect(w.rows()[0]).toMatchObject({ dl_attempts: 0, has_descriptor: 0 })
      await c.connection.stop()
    })
  })

  describe('stopping the connection (the unit is released)', () => {
    it('INVARIANT: once released no stream stays open, no file is left, and nothing reaches the closed database', async () => {
      const w = world()
      const c = w.connect()
      const socket = await c.open()
      const streams: PassThrough[] = []
      ;(socket.socket as { openAudio: unknown }).openAudio = async () => {
        const stream = new PassThrough()
        stream.write(Buffer.from('some bytes, then silence'))
        streams.push(stream)
        return stream
      }
      socket.ev.emit('messages.upsert', { type: 'notify', messages: [audio('A1'), audio('A2'), audio('A3')] })
      await until(() => streams.length === 1, 'the first download')
      const started = Date.now()
      await c.connection.stop()
      expect(Date.now() - started).toBeLessThan(3_000) // not the minute of the download timeout
      // The unit is released: its database is closed. A write from a late download would throw here.
      w.db.close()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(streams).toHaveLength(1) // the others never began
      expect(streams.every((s) => s.destroyed)).toBe(true)
      expect(w.files()).toEqual([])
      expect(w.warnings).toEqual([]) // no failed write, no unhandled event
      expect(w.outcomes.includes('error')).toBe(false)
    })

    it('a stream that opens after the connection was released is closed as soon as it shows up', async () => {
      const w = world()
      const c = w.connect()
      const socket = await c.open()
      let open: (stream: PassThrough) => void = () => {}
      const late = new Promise<PassThrough>((resolve) => {
        open = resolve
      })
      let asked = false
      ;(socket.socket as { openAudio: unknown }).openAudio = () => {
        asked = true
        return late
      }
      socket.ev.emit('messages.upsert', { type: 'notify', messages: [audio('A1')] })
      await until(() => asked, 'the request')
      await c.connection.stop()
      const stream = new PassThrough()
      open(stream)
      await until(() => stream.destroyed, 'the late stream to be closed')
      expect(w.files()).toEqual([])
      expect(w.rows()[0]).toMatchObject({ transcribe_status: 'download_pending', dl_attempts: 0 })
    })

    it('a connection can be started again after it was stopped: the worker works again', async () => {
      const w = world()
      const c = w.connect()
      await c.open()
      await c.connection.stop()
      const socket = await c.open()
      socket.ev.emit('messages.upsert', { type: 'notify', messages: [audio('A1')] })
      await until(() => w.statuses().A1 === 'pending', 'the audio to be downloaded')
      await c.connection.stop()
    })
  })
})
