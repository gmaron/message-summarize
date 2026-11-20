import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../../../src/main/config.js'
import { runDigest } from '../../../src/main/run-digest.js'
import { createRuntime, type Runtime } from '../../../src/main/runtime.js'
import {
  BA,
  disposeHarnesses,
  FakeSummarizer,
  type Harness,
  makeHarness,
  NOW,
  until,
} from '../../support/cli-harness.js'
import { type FakeWhisper, installFakeWhisper, isAlive } from '../../support/fake-whisper.js'

// The fake programs are POSIX shell scripts: Windows is not part of the v1 native matrix (RNF-05).
describe.skipIf(process.platform === 'win32')(
  'the digest and the transcription, with the real adapter over fake programs',
  () => {
    const fakes: FakeWhisper[] = []
    const runtimes: Runtime[] = []
    afterEach(() => {
      for (const runtime of runtimes.splice(0)) {
        try {
          runtime.close()
        } catch {
          // a test closed it already
        }
      }
      for (const fake of fakes.splice(0)) fake.dispose()
      disposeHarnesses()
    })

    const ANA = '9911963367943@s.whatsapp.net'

    interface Options {
      /** Settings of `transcription`; undefined: not in the configuration at all (off). */
      transcription?: (fake: FakeWhisper) => Record<string, unknown>
      waitMs?: number
    }

    async function setup(options: Options = {}) {
      const fake = installFakeWhisper()
      fakes.push(fake)
      const summarizer = new FakeSummarizer()
      const h: Harness = await makeHarness({ summarizer })
      const configJson = {
        language: 'en',
        timezone: BA,
        provider: { primary: 'claude-cli' },
        ...(options.transcription === undefined ? {} : { transcription: options.transcription(fake) }),
      }
      const parsed = parseConfig(configJson, BA)
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
      const runtime = createRuntime({
        layout: h.account,
        config: parsed.value,
        env: { PATH: process.env.PATH ?? '' },
        clock: h.clock,
        summarizer,
        ...(options.waitMs === undefined ? {} : { transcriptionWaitMs: options.waitMs }),
      })
      runtimes.push(runtime)

      /** A voice note that arrived an hour ago, from Ana, with its file downloaded (queued, but the queue is not kicked). */
      const voiceNote = async (id: string, saying: string, minutesAgo = 60): Promise<void> => {
        await runtime.capture.participantInfo({ participant: { id: ANA, savedName: 'Ana Test', publicName: null } })
        await runtime.capture.conversationMetadata({
          conversation: { id: ANA, isGroup: false, name: null, participantId: ANA, address: '+9911963367943' },
        })
        await runtime.capture.receiveMessage({
          origin: 'history',
          isGroup: false,
          message: {
            id,
            conversationId: ANA,
            senderId: ANA,
            senderName: null,
            senderAddress: '+9911963367943',
            fromMe: false,
            timestamp: NOW - minutesAgo * 60_000,
            kind: 'audio',
            text: '[audio]',
            transcript: null,
            read: false,
          },
        })
        mkdirSync(h.account.mediaDir, { recursive: true, mode: 0o700 })
        writeFileSync(join(h.account.mediaDir, `${id}.ogg`), saying)
        // The repository, not the capture use case: the capture would also wake the background queue.
        await runtime.repository.setMedia(ANA, id, `${id}.ogg`)
      }
      const text = async (id: string, body: string): Promise<void> => {
        await runtime.capture.receiveMessage({
          origin: 'history',
          isGroup: false,
          message: {
            id,
            conversationId: ANA,
            senderId: ANA,
            senderName: null,
            senderAddress: '+9911963367943',
            fromMe: false,
            timestamp: NOW - 30 * 60_000,
            kind: 'text',
            text: body,
            transcript: null,
            read: false,
          },
        })
      }
      const digest = () => runDigest(runtime, { preview: true })
      const sent = () => summarizer.requests.map((r) => r.transcript)
      return { h, fake, runtime, summarizer, voiceNote, text, digest, sent }
    }

    const enabled = (fake: FakeWhisper) => ({
      enabled: true,
      whisperCommand: fake.whisper,
      ffmpegCommand: fake.ffmpeg,
      model: fake.model,
      language: 'es',
      timeoutMs: 20_000,
    })

    it('transcribes the pending audio of the window right before the digest and shows it in place of "[audio]", in the legacy format', async () => {
      const t = await setup({ transcription: enabled })
      await t.voiceNote('a1', '  Che, el sábado cambiamos\nla comida a las dos.  ')
      await t.text('t1', 'Avisame si podés')
      expect((await t.digest()).ok).toBe(true)
      const [transcript] = t.sent()
      // "🎤 (audio) <transcript>", whitespace collapsed, exactly as the previous tool rendered it.
      expect(transcript).toContain('Ana Test: 🎤 (audio) Che, el sábado cambiamos la comida a las dos.')
      expect(transcript).toContain('Avisame si podés')
      expect(transcript).not.toContain('[audio]')
      expect(transcript).not.toContain('not transcribed')
      expect(t.fake.whisperCalls()).toHaveLength(1)
      expect(t.fake.whisperCalls()[0]).toContain('-l es')
    })

    it('a digest that was not asked to wait still works with the audios already transcribed in the background', async () => {
      const t = await setup({ transcription: enabled })
      await t.voiceNote('a1', 'ya estaba listo')
      t.runtime.transcription.kick()
      await t.runtime.transcription.idle()
      expect(t.fake.whisperCalls()).toHaveLength(1)
      expect((await t.digest()).ok).toBe(true)
      expect(t.sent()[0]).toContain('🎤 (audio) ya estaba listo')
      expect(t.fake.whisperCalls()).toHaveLength(1) // not transcribed twice
    })

    it('transcribes only the audios of the window: older ones are left for the background queue', async () => {
      const t = await setup({ transcription: enabled })
      await t.voiceNote('old', 'de hace dos dias', 60 * 48)
      await t.voiceNote('new', 'de recien', 10)
      expect((await t.digest()).ok).toBe(true)
      expect(t.sent()[0]).toContain('🎤 (audio) de recien')
      expect(t.fake.whisperCalls()).toHaveLength(1)
      expect(await t.runtime.repository.setMedia(ANA, 'old', 'old.ogg')).toBe(true) // still known, still pending
    })

    describe('everything else works when it cannot transcribe (RF-21)', () => {
      const untranscribed = '🎤 (audio not transcribed)'

      it('transcription off (not in the configuration): the audio stays untranscribed and no program is run', async () => {
        const t = await setup()
        await t.voiceNote('a1', 'never read')
        await t.text('t1', 'hola, ¿venís?')
        expect((await t.digest()).ok).toBe(true)
        expect(t.sent()[0]).toContain(untranscribed)
        expect(t.sent()[0]).toContain('hola, ¿venís?')
        expect(t.runtime.transcription.enabled).toBe(false)
        expect(t.fake.whisperCalls()).toEqual([])
        expect(t.fake.ffmpegCalls()).toEqual([])
      })

      it('transcription explicitly off: the same', async () => {
        const t = await setup({ transcription: (fake) => ({ ...enabled(fake), enabled: false }) })
        await t.voiceNote('a1', 'never read')
        expect((await t.digest()).ok).toBe(true)
        expect(t.sent()[0]).toContain(untranscribed)
        expect(t.fake.whisperCalls()).toEqual([])
      })

      it('whisper is not installed: the digest is made, the audio stays pending for when it is', async () => {
        const t = await setup({
          transcription: (fake) => ({
            ...enabled(fake),
            whisperCommand: fake.allow(join(fake.dir, 'no-such-whisper')),
          }),
        })
        await t.voiceNote('a1', 'x')
        await t.text('t1', 'otra cosa')
        const started = Date.now()
        expect((await t.digest()).ok).toBe(true)
        expect(Date.now() - started).toBeLessThan(10_000)
        expect(t.sent()[0]).toContain(untranscribed)
        expect(t.sent()[0]).toContain('otra cosa')
        expect(await t.runtime.transcription.prepareWindow({ from: 0, until: NOW }, 1_000)).toMatchObject({
          remaining: 1,
        })
      })

      it('ffmpeg is not installed: the same', async () => {
        const t = await setup({
          transcription: (fake) => ({ ...enabled(fake), ffmpegCommand: fake.allow(join(fake.dir, 'no-such-ffmpeg')) }),
        })
        await t.voiceNote('a1', 'x')
        expect((await t.digest()).ok).toBe(true)
        expect(t.sent()[0]).toContain(untranscribed)
        expect(t.fake.whisperCalls()).toEqual([])
      })

      it('the model is missing, or none is configured: the same', async () => {
        for (const model of [(fake: FakeWhisper) => join(fake.dir, 'ggml-missing.bin'), undefined]) {
          const t = await setup({
            transcription: (fake) => {
              const settings: Record<string, unknown> = { ...enabled(fake) }
              if (model === undefined) settings.model = undefined
              else settings.model = model(fake)
              return settings
            },
          })
          await t.voiceNote('a1', 'x')
          expect((await t.digest()).ok).toBe(true)
          expect(t.sent()[0]).toContain(untranscribed)
          expect(t.fake.whisperCalls()).toEqual([])
        }
      })

      it('an audio whisper cannot read is recorded as failed, shows as not transcribed, and the rest of the digest is made', async () => {
        const t = await setup({ transcription: enabled })
        t.fake.setWhisperMode('fail')
        await t.voiceNote('a1', 'x')
        await t.text('t1', 'texto normal')
        expect((await t.digest()).ok).toBe(true)
        expect(t.sent()[0]).toContain(untranscribed)
        expect(t.sent()[0]).toContain('texto normal')
        const row = t.runtime.db
          .prepare('SELECT transcribe_status, transcribe_error FROM messages WHERE id = ?')
          .get('a1') as { transcribe_status: string; transcribe_error: string }
        expect(row.transcribe_status).toBe('failed')
        expect(row.transcribe_error).toContain('whisper exited with code 3')
        // And it is not tried again by the next digest.
        t.fake.setWhisperMode('ok')
        await t.digest()
        expect(t.fake.whisperCalls()).toHaveLength(1)
      })
    })

    describe('a bounded wait before the digest (RF-15)', () => {
      it('a whisper that takes too long does not hold the digest: it goes on, the audio stays pending, the process is killed', async () => {
        const t = await setup({ transcription: enabled, waitMs: 400 })
        t.fake.setWhisperMode('hang')
        await t.voiceNote('a1', 'x')
        await t.text('t1', 'texto normal')
        const started = Date.now()
        expect((await t.digest()).ok).toBe(true)
        expect(Date.now() - started).toBeLessThan(10_000)
        expect(t.sent()[0]).toContain('🎤 (audio not transcribed)')
        expect(t.sent()[0]).toContain('texto normal')
        await until(() => existsPids(t.fake), 'whisper to have started')
        // Closing the runtime (the end of `msum digest`) kills what is still running: no orphan whisper.
        t.runtime.close()
        const { whisper, child } = t.fake.hangingPids()
        await until(() => !isAlive(whisper) && !isAlive(child), 'whisper to be killed')
      })
    })

    describe('permissions', () => {
      it('the whisper child gets no secrets from the environment of the daemon', async () => {
        const t = await setup({ transcription: enabled })
        t.fake.logEnv()
        await t.voiceNote('a1', 'x')
        await t.digest()
        const seen = t.fake.whisperEnv().join('\n')
        expect(seen).toContain('PATH=')
        expect(seen).not.toMatch(/KEY|TOKEN|SECRET/i)
      })
    })
  },
)

function existsPids(fake: FakeWhisper): boolean {
  try {
    return fake.hangingPids().child > 0
  } catch {
    return false
  }
}
