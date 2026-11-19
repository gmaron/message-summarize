import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { err, ok } from '../../../src/domain/result.js'
import { parseConfig } from '../../../src/main/config.js'
import { Daemon } from '../../../src/main/daemon.js'
import { createRuntime, type Runtime } from '../../../src/main/runtime.js'
import { BA, disposeHarnesses, type Harness, makeHarness, NOW, until } from '../../support/cli-harness.js'
import { FakeTranscriber } from '../../support/transcription-fakes.js'

const ANA = '5491100000001@s.whatsapp.net'

let current: { runtime: Runtime; daemon: Daemon } | null = null
afterEach(async () => {
  if (current !== null) {
    await current.daemon.stop()
    try {
      current.runtime.close()
    } catch {
      // closed by the test
    }
    current = null
  }
  disposeHarnesses()
})

async function setup(transcriber: FakeTranscriber | null) {
  const h: Harness = await makeHarness()
  const parsed = parseConfig({ language: 'en', timezone: BA, provider: { primary: 'claude-cli' } }, BA)
  if (!parsed.ok) throw new Error('bad config')
  const outcomes: string[] = []
  const runtime = createRuntime({
    layout: h.account,
    config: parsed.value,
    env: {},
    clock: h.clock,
    summarizer: null,
    transcriber,
    onTranscription: (outcome) => outcomes.push(outcome),
  })
  runtime.identity.bind('5491100000009@s.whatsapp.net')
  const daemon = new Daemon({ runtime, connection: h.connection, logger: h.ctx.logger, sweepMs: 40 })
  current = { runtime, daemon }
  /** A voice note whose file was downloaded: stored and queued (through the repository: no wake-up). */
  const queued = async (id: string, timestamp = NOW - 60_000): Promise<void> => {
    await runtime.capture.participantInfo({ participant: { id: ANA, savedName: 'Ana', publicName: null } })
    await runtime.capture.receiveMessage({
      origin: 'history',
      isGroup: false,
      message: {
        id,
        conversationId: ANA,
        senderId: ANA,
        senderName: null,
        senderAddress: '+5491100000001',
        fromMe: false,
        timestamp,
        kind: 'audio',
        text: '[audio]',
        transcript: null,
        read: false,
      },
    })
    mkdirSync(h.account.mediaDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(h.account.mediaDir, `${id}.ogg`), 'bytes')
    await runtime.repository.setMedia(ANA, id, `${id}.ogg`)
  }
  const transcriptOf = (id: string): string | null =>
    (runtime.db.prepare('SELECT transcript FROM messages WHERE id = ?').get(id) as { transcript: string | null })
      .transcript
  const status = (id: string): string | null =>
    (runtime.db.prepare('SELECT transcribe_status AS s FROM messages WHERE id = ?').get(id) as { s: string | null }).s
  return { h, runtime, daemon, queued, transcriptOf, status, outcomes }
}

describe('the transcription queue in the daemon (RF-15, RNF-09)', () => {
  it('works through the audios that were waiting when it starts, oldest first, one at a time', async () => {
    const transcriber = new FakeTranscriber()
    transcriber.answer = async (r) => ok(`text of ${basename(r.audioPath)}`)
    const t = await setup(transcriber)
    await t.queued('late', NOW - 1_000)
    await t.queued('early', NOW - 9_000)
    await t.daemon.start()
    await until(() => t.outcomes.length === 2, 'both audios handled')
    expect(transcriber.calls.map((c) => basename(c.audioPath))).toEqual(['early.ogg', 'late.ogg'])
    expect(transcriber.maxInFlight).toBe(1)
    expect(t.transcriptOf('early')).toBe('text of early.ogg')
    expect(t.status('late')).toBe('done')
    expect(t.outcomes).toEqual(['transcribed', 'transcribed'])
  })

  it('wakes the download worker of the connection on every sweep (an audio that failed for a moment is tried again)', async () => {
    const t = await setup(new FakeTranscriber())
    let kicks = 0
    ;(t.h.connection as unknown as { kickDownloads: () => void }).kickDownloads = () => {
      kicks++
    }
    await t.daemon.start()
    await until(() => kicks >= 3, 'three sweeps')
  })

  it('sweeps the download queue even with transcription off: stuck rows fail and old keys are cleared', async () => {
    const t = await setup(null)
    const DAY = 24 * 60 * 60 * 1000
    const queueAudio = async (id: string, timestamp: number): Promise<void> => {
      await t.runtime.capture.participantInfo({ participant: { id: ANA, savedName: 'Ana', publicName: null } })
      await t.runtime.capture.receiveMessage({
        origin: 'history',
        isGroup: false,
        message: {
          id,
          conversationId: ANA,
          senderId: ANA,
          senderName: null,
          senderAddress: '+5491100000001',
          fromMe: false,
          timestamp,
          kind: 'audio',
          text: '[audio]',
          transcript: null,
          read: false,
        },
      })
      await t.runtime.repository.queueDownload(ANA, id, {
        directPath: `/v/${id}`,
        mediaKey: new Uint8Array(32).fill(2),
        mimetype: 'audio/ogg',
        fileLength: 10,
      })
    }
    await queueAudio('old', NOW - 31 * DAY)
    await queueAudio('broken', NOW - 1_000)
    await queueAudio('fresh', NOW - 2_000)
    t.runtime.db.prepare("UPDATE messages SET dl_media_key = NULL WHERE id = 'broken'").run()
    await t.daemon.start()
    await until(() => t.status('old') === 'failed' && t.status('broken') === 'failed', 'the sweep')
    const row = (id: string) =>
      t.runtime.db
        .prepare('SELECT transcribe_error AS e, dl_direct_path AS p, dl_media_key AS k FROM messages WHERE id = ?')
        .get(id)
    expect(row('old')).toMatchObject({ e: 'expired', p: null, k: null })
    expect(row('broken')).toMatchObject({ e: 'invalid-media', p: null, k: null })
    expect(t.status('fresh')).toBe('download_pending')
    expect(row('fresh')).toMatchObject({ p: '/v/fresh' })
  })

  it('tries again every sweep while something waits: whisper installed later is picked up without a restart', async () => {
    const transcriber = new FakeTranscriber()
    let installed = false
    transcriber.answer = async () =>
      installed ? ok('now it works') : err({ kind: 'unavailable', reason: 'whisper-missing' })
    const t = await setup(transcriber)
    await t.queued('a1')
    await t.daemon.start()
    await until(() => t.outcomes.includes('unavailable'), 'the first try')
    expect(t.transcriptOf('a1')).toBeNull()
    expect(t.status('a1')).toBe('pending')
    installed = true
    await until(() => t.transcriptOf('a1') === 'now it works', 'the transcript after the next sweep')
  })

  it('with transcription off the daemon runs nothing and leaves the audios alone', async () => {
    const t = await setup(null)
    await t.queued('a1')
    await t.daemon.start()
    await new Promise((resolve) => setTimeout(resolve, 150)) // several sweeps
    expect(t.runtime.transcription.enabled).toBe(false)
    expect(t.status('a1')).toBe('pending')
    expect(t.transcriptOf('a1')).toBeNull()
  })

  it('stopping the daemon kills the running transcription and leaves its audio pending, quickly', async () => {
    const transcriber = new FakeTranscriber()
    transcriber.answer = async () => {
      await transcriber.closedSignal // runs until killed
      return err({ kind: 'unavailable', reason: 'closed' })
    }
    const t = await setup(transcriber)
    await t.queued('a1')
    await t.daemon.start()
    await until(() => transcriber.inFlight === 1, 'the transcription to start')
    const started = Date.now()
    await t.daemon.stop()
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(transcriber.closeCalls).toBe(1)
    expect(t.status('a1')).toBe('pending')
    expect(t.transcriptOf('a1')).toBeNull()
    expect(t.outcomes).toEqual([])
  })
})
