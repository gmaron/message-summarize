import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../../../src/domain/result.js'
import { openInstallation } from '../../../src/main/accounts.js'
import { DaemonHost } from '../../../src/main/daemon-host.js'
import { connectionFactoryWith } from '../../../src/main/whatsapp.js'
import { BA, disposeHarnesses, ME, makeHarness, until } from '../../support/cli-harness.js'
import { FakeTranscriber } from '../../support/transcription-fakes.js'
import { fakeSocketFactory } from '../../support/whatsapp-fakes.js'

afterEach(() => {
  disposeHarnesses()
})

const ANA = '5491100000001@s.whatsapp.net'
const KEY = Buffer.alloc(32, 0xab)
const DIRECT_PATH = '/v/t62.7117-24/777_888_n.enc?ccb=11-4&oh=SECRETTOKEN&oe=65f0'

describe('an audio through the daemon: download, transcription, and what the logs say (RNF-04)', () => {
  it('goes from the message to the transcript, deletes the file, and never writes the key or the path anywhere', async () => {
    const transcriber = new FakeTranscriber()
    transcriber.answer = async () => ok('hola, llego tarde')
    const h = await makeHarness({
      config: {
        language: 'en',
        timezone: BA,
        provider: { primary: 'claude-cli' },
        transcription: { enabled: true, model: 'base' },
      },
    })
    const fake = fakeSocketFactory({ me: () => ({ id: ME }) })
    Object.assign(h.ctx, { connectionFactory: connectionFactoryWith(fake.factory), transcriber })

    // A linked account.
    const seeding = h.runtime()
    seeding.identity.bind(ME)
    seeding.close()
    writeFileSync(join(h.account.authDir, 'creds.json'), JSON.stringify({ me: { id: ME } }))

    const installation = await openInstallation({ layout: h.layout, clock: h.clock })
    if (!installation.ok) throw new Error('refused')
    const host = new DaemonHost({
      ctx: h.ctx,
      installation: installation.installation,
      onlyAccount: null,
      language: 'en',
      timing: { scheduleReloadMs: 20, sweepMs: 50, shutdownGraceMs: 2_000 },
    })
    try {
      await host.start()
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
                directPath: DIRECT_PATH,
                mediaKey: KEY,
              },
            },
            messageTimestamp: Math.floor(h.clock.now() / 1000) - 60,
          },
        ],
      })
      const reader = h.runtime()
      try {
        await until(
          () =>
            (
              reader.db.prepare("SELECT transcript FROM messages WHERE id = 'A1'").get() as
                | { transcript: string | null }
                | undefined
            )?.transcript === 'hola, llego tarde',
          'the transcript',
        )
        const row = reader.db
          .prepare(
            "SELECT transcribe_status AS s, dl_media_key AS k, dl_direct_path AS p FROM messages WHERE id = 'A1'",
          )
          .get() as { s: string; k: unknown; p: unknown }
        // done, and the key and the path are gone from the database
        expect(row).toEqual({ s: 'done', k: null, p: null })
      } finally {
        reader.close()
      }
      // the audio file is gone: what is kept is the text
      await until(
        () => (existsSync(h.account.mediaDir) ? readdirSync(h.account.mediaDir) : []).length === 0,
        'the audio file to be deleted',
      )
      // the worker used the descriptor, with the key, and only that
      expect(socket.audioRequests).toHaveLength(1)
    } finally {
      await host.stop()
      installation.installation.close()
    }

    const everything = [...h.logs, ...h.out, ...h.err].join('\n')
    expect(everything).toContain('media.download') // it did log the download, by a fixed word
    expect(everything).toContain('transcription.audio')
    // The decryption key, in every form it could be written, and the path of the file on the server.
    expect(everything).not.toContain(KEY.toString('hex'))
    expect(everything).not.toContain(KEY.toString('base64'))
    expect(everything).not.toContain('qqurq6ur') // base64 of 0xab bytes, in case of a partial copy
    expect(everything).not.toContain(JSON.stringify([...KEY]))
    expect(everything).not.toContain('SECRETTOKEN')
    expect(everything).not.toContain('777_888_n.enc')
    expect(everything).not.toContain('hola, llego tarde') // nor the transcript
  })
})
