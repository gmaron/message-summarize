import { afterEach, describe, expect, it } from 'vitest'
import { runMain } from '../../../src/main/app.js'
import { acquireDaemonLock } from '../../../src/main/daemon-lock.js'
import { connectionFactoryWith } from '../../../src/main/whatsapp.js'
import { BA, disposeHarnesses, ME, makeHarness, until } from '../../support/cli-harness.js'
import { FakeTranscriber } from '../../support/transcription-fakes.js'
import { fakeSocketFactory } from '../../support/whatsapp-fakes.js'

afterEach(() => {
  disposeHarnesses()
})

const ANA = '9911963367943@s.whatsapp.net'
const KEY = Buffer.alloc(32, 0xcd)

describe('msum link and audios (RF-15, RNF-09)', () => {
  it('only captures and queues: while a daemon runs another account, it starts no download and no whisper', async () => {
    const transcriber = new FakeTranscriber()
    const h = await makeHarness({
      accounts: ['busy', 'fresh'],
      config: {
        language: 'en',
        timezone: BA,
        provider: { primary: 'claude-cli' },
        transcription: { enabled: true, model: 'base' },
      },
    })
    const fake = fakeSocketFactory({ me: () => ({ id: ME }) })
    Object.assign(h.ctx, { connectionFactory: connectionFactoryWith(fake.factory), transcriber })
    // A daemon is running (it owns the other account, which stays untouched here).
    const daemonLock = await acquireDaemonLock(h.layout.lockFile, process.pid)
    Object.assign(h.ctx.linkTiming, { quietMs: 300, maxAfterConnectMs: 5_000, connectTimeoutMs: 5_000 })

    const linking = runMain(['link', '--account', 'fresh'], h.ctx)
    await until(() => fake.sockets.length > 0, 'the socket')
    const socket = fake.sockets[0]
    if (socket === undefined) throw new Error('no socket')
    socket.user = { id: ME }
    socket.ev.emit('connection.update', { connection: 'open' })
    socket.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: ANA, id: 'A1', fromMe: false },
          message: {
            audioMessage: {
              fileLength: 20,
              mimetype: 'audio/ogg; codecs=opus',
              directPath: '/v/t62.7117-24/1_2_n.enc?ccb=11-4&oe=65f0',
              mediaKey: KEY,
            },
          },
          messageTimestamp: Math.floor(h.clock.now() / 1000) - 60,
        },
      ],
    })
    expect(await linking).toBe(0)
    if (daemonLock.ok) await daemonLock.release()

    const runtime = h.runtime('fresh')
    try {
      const row = runtime.db
        .prepare(
          'SELECT transcribe_status AS s, media_ref AS ref, dl_media_key IS NOT NULL AS hasKey FROM messages WHERE id = ?',
        )
        .get('A1') as { s: string; ref: string | null; hasKey: number }
      // Captured and queued, with what the daemon's worker needs: nothing downloaded, nothing transcribed.
      expect(row).toEqual({ s: 'download_pending', ref: null, hasKey: 1 })
    } finally {
      runtime.close()
    }
    expect(fake.sockets[0]?.audioRequests).toEqual([])
    expect(transcriber.calls).toEqual([])
  })
})
