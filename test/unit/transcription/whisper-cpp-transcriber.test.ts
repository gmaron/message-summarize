import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ffmpegArgs,
  inputFormatOf,
  MAX_AUDIO_SECONDS,
  MAX_WAV_BYTES,
  WhisperCppTranscriber,
} from '../../../src/infrastructure/transcription/index.js'
import { until } from '../../support/cli-harness.js'
import { type FakeWhisper, installFakeWhisper, isAlive } from '../../support/fake-whisper.js'

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The programs are POSIX shell scripts: Windows is not part of the v1 native matrix (RNF-05).
describe.skipIf(process.platform === 'win32')('WhisperCppTranscriber', () => {
  const installs: FakeWhisper[] = []
  const install = (): FakeWhisper => {
    const fake = installFakeWhisper()
    installs.push(fake)
    return fake
  }
  afterEach(() => {
    for (const fake of installs.splice(0)) fake.dispose()
  })

  const make = (
    fake: FakeWhisper,
    overrides: Partial<ConstructorParameters<typeof WhisperCppTranscriber>[0]> = {},
  ): WhisperCppTranscriber =>
    new WhisperCppTranscriber({
      whisperCommand: fake.whisper,
      ffmpegCommand: fake.ffmpeg,
      modelPath: fake.model,
      tmpRoot: fake.tmpRoot,
      timeoutMs: 20_000,
      killGraceMs: 200,
      ...overrides,
    })

  describe('what it runs (RF-20, RF-23)', () => {
    it('converts to 16 kHz mono WAV with ffmpeg, then runs whisper on the WAV with the model and the language', async () => {
      const fake = install()
      const audio = fake.audio('voice.ogg', 'hello')
      expect(await make(fake).transcribe({ audioPath: audio, language: 'es' })).toEqual({ ok: true, value: 'hello' })

      const [ffmpegCall] = fake.ffmpegCalls()
      // The exact command line (the wav is in the temporary directory of the call).
      expect(ffmpegCall).toMatch(
        new RegExp(
          `^-nostdin -y -loglevel error -protocol_whitelist file -f ogg -t 1800 -i ${escapeRegExp(audio)} ` +
            `-ar 16000 -ac 1 -c:a pcm_s16le -fs ${MAX_WAV_BYTES} \\S+audio\\.wav$`,
        ),
      )

      const [whisperCall] = fake.whisperCalls()
      expect(whisperCall).toContain(`-m ${fake.model}`)
      expect(whisperCall).toContain('-l es')
      expect(whisperCall).toMatch(/-f \S+audio\.wav/)
      expect(whisperCall).toContain('-nt -np -otxt -of ')
    })

    it('FORCES the input format from the file (never guessed from the bytes): one exact command line per format', async () => {
      const fake = install()
      const demuxers: [string, string][] = [
        ['ogg', 'ogg'],
        ['mp3', 'mp3'],
        ['m4a', 'mov'],
        ['aac', 'aac'],
        ['amr', 'amr'],
        ['OGG', 'ogg'],
      ]
      for (const [extension, demuxer] of demuxers) {
        const audio = fake.audio(`note.${extension}`, `in ${extension}`)
        const before = fake.ffmpegCalls().length
        expect(await make(fake).transcribe({ audioPath: audio, language: 'es' })).toEqual({
          ok: true,
          value: `in ${extension}`,
        })
        expect(fake.ffmpegCalls()[before]).toMatch(
          new RegExp(
            `^-nostdin -y -loglevel error -protocol_whitelist file -f ${demuxer} -t 1800 -i ${escapeRegExp(audio)} ` +
              `-ar 16000 -ac 1 -c:a pcm_s16le -fs ${MAX_WAV_BYTES} \\S+audio\\.wav$`,
          ),
        )
      }
    })

    it('builds the command line as documented: input options before -i, output limit before the file', () => {
      expect(ffmpegArgs('ogg', '/in/a.ogg', '/out/a.wav')).toEqual([
        '-nostdin',
        '-y',
        '-loglevel',
        'error',
        '-protocol_whitelist',
        'file',
        '-f',
        'ogg',
        '-t',
        '1800',
        '-i',
        '/in/a.ogg',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        '-fs',
        String(MAX_WAV_BYTES),
        '/out/a.wav',
      ])
    })

    it('limits the input to 30 minutes and the output to 30 minutes of 16 kHz mono s16 plus a margin', () => {
      expect(MAX_AUDIO_SECONDS).toBe(1800)
      const exact = 1800 * 16_000 * 2 // 57,600,000 bytes of samples
      expect(MAX_WAV_BYTES).toBeGreaterThan(exact + 44)
      expect(MAX_WAV_BYTES).toBeLessThan(exact * 1.1)
    })

    it('refuses a format that is not one of WhatsApp audio, without starting ffmpeg: failed unsupported-format', async () => {
      const fake = install()
      for (const name of ['clip.mkv', 'clip.mp4', 'clip.wav', 'clip.txt', 'clip', 'clip.ogg.exe', 'clip.']) {
        const result = await make(fake).transcribe({ audioPath: fake.audio(name, 'x'), language: 'en' })
        expect(result, name).toEqual({ ok: false, error: { kind: 'failed', reason: 'unsupported-format' } })
      }
      expect(fake.ffmpegCalls()).toEqual([])
      expect(fake.whisperCalls()).toEqual([])
    })

    it('finds the format of a file by its extension, and only for the audio formats of WhatsApp', () => {
      expect(inputFormatOf('/m/abc.ogg')).toBe('ogg')
      expect(inputFormatOf('/m/abc.m4a')).toBe('mov')
      expect(inputFormatOf('/m/abc.mkv')).toBeUndefined()
      expect(inputFormatOf('/m/abc')).toBeUndefined()
      expect(inputFormatOf('/m/abc.constructor')).toBeUndefined()
    })

    it('passes "auto" to detect the language of each audio', async () => {
      const fake = install()
      await make(fake).transcribe({ audioPath: fake.audio('a.ogg', 'x'), language: 'auto' })
      expect(fake.whisperCalls()[0]).toContain('-l auto')
    })

    it('reads the transcript from the file whisper wrote, not from its output', async () => {
      const fake = install()
      const result = await make(fake).transcribe({ audioPath: fake.audio('a.ogg', 'from the file'), language: 'en' })
      expect(result).toEqual({ ok: true, value: 'from the file' })
    })

    it('never opens a shell: a path full of shell syntax is just a file name', async () => {
      const fake = install()
      const audio = fake.audio('a b; touch pwned; $(touch pwned) `touch pwned`.ogg', 'still fine')
      expect(await make(fake).transcribe({ audioPath: audio, language: 'en' })).toEqual({
        ok: true,
        value: 'still fine',
      })
      // The program received the name whole, as one argument, and nothing ran what looked like a command.
      expect(fake.ffmpegCalls()[0]).toContain(`-i ${audio} `)
      for (const where of [fake.dir, fake.tmpRoot, process.cwd()]) expect(existsSync(join(where, 'pwned'))).toBe(false)
    })

    it('does not let a language that is not a code reach the command line', async () => {
      const fake = install()
      for (const language of ['-x', 'es; touch x', 'ES', 'a', 'english', '']) {
        const result = await make(fake).transcribe({ audioPath: fake.audio('a.ogg', 'x'), language })
        expect(result, language).toEqual({ ok: false, error: { kind: 'failed', reason: 'invalid-language' } })
      }
      expect(fake.whisperCalls()).toEqual([])
      expect(fake.ffmpegCalls()).toEqual([])
    })
  })

  describe('where it runs (RNF-04)', () => {
    it('works in a temporary directory of its own, and leaves nothing behind', async () => {
      const fake = install()
      await make(fake).transcribe({ audioPath: fake.audio('a.ogg', 'x'), language: 'en' })
      const [cwd] = fake.whisperCwds()
      expect(cwd).toContain('message-summarize-whisper-')
      expect(cwd?.startsWith(fake.tmpRoot) || cwd?.includes(fake.tmpRoot.replace(/^\/private/, ''))).toBe(true)
      expect(readdirSync(fake.tmpRoot)).toEqual([])
    })

    it('cleans the temporary directory when the program fails too', async () => {
      const fake = install()
      fake.setWhisperMode('fail')
      await make(fake).transcribe({ audioPath: fake.audio('a.ogg', 'x'), language: 'en' })
      expect(readdirSync(fake.tmpRoot)).toEqual([])
    })

    it('gives the program only a few environment variables: no secrets', async () => {
      const fake = install()
      const env = { PATH: process.env.PATH ?? '', HOME: '/home/x', ANTHROPIC_API_KEY: 'sk-secret', MY_TOKEN: 't0k3n' }
      fake.logEnv()
      await make(fake, { env }).transcribe({ audioPath: fake.audio('a.ogg', 'x'), language: 'en' })
      const seen = fake.whisperEnv().join('\n')
      expect(seen).toContain('HOME=/home/x')
      expect(seen).not.toContain('sk-secret')
      expect(seen).not.toContain('t0k3n')
      expect(seen).not.toContain('ANTHROPIC_API_KEY')
    })
  })

  describe('when something is missing (RF-21)', () => {
    it('is unavailable, not failed, when there is no model configured', async () => {
      const fake = install()
      const result = await make(fake, { modelPath: null }).transcribe({
        audioPath: fake.audio('a.ogg', 'x'),
        language: 'en',
      })
      expect(result).toEqual({ ok: false, error: { kind: 'unavailable', reason: 'no-model' } })
      expect(fake.ffmpegCalls()).toEqual([])
    })

    it('is unavailable when the model file does not exist', async () => {
      const fake = install()
      const result = await make(fake, { modelPath: join(fake.dir, 'nope.bin') }).transcribe({
        audioPath: fake.audio('a.ogg', 'x'),
        language: 'en',
      })
      expect(result).toEqual({ ok: false, error: { kind: 'unavailable', reason: 'model-missing' } })
    })

    it('is unavailable when ffmpeg is not installed', async () => {
      const fake = install()
      const result = await make(fake, { ffmpegCommand: fake.allow(join(fake.dir, 'no-such-ffmpeg')) }).transcribe({
        audioPath: fake.audio('a.ogg', 'x'),
        language: 'en',
      })
      expect(result).toEqual({ ok: false, error: { kind: 'unavailable', reason: 'ffmpeg-missing' } })
      expect(fake.whisperCalls()).toEqual([])
    })

    it('is unavailable when whisper is not installed', async () => {
      const fake = install()
      const result = await make(fake, { whisperCommand: fake.allow(join(fake.dir, 'no-such-whisper')) }).transcribe({
        audioPath: fake.audio('a.ogg', 'x'),
        language: 'en',
      })
      expect(result).toEqual({ ok: false, error: { kind: 'unavailable', reason: 'whisper-missing' } })
    })

    it('is unavailable when the program is not executable', async () => {
      const fake = install()
      const notExecutable = fake.allow(join(fake.dir, 'plain-file'))
      writeFileSync(notExecutable, 'echo hi')
      const result = await make(fake, { whisperCommand: notExecutable }).transcribe({
        audioPath: fake.audio('a.ogg', 'x'),
        language: 'en',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('unavailable')
    })
  })

  describe('when the audio cannot be transcribed', () => {
    it('says it failed when ffmpeg cannot read the audio, with the end of what it said', async () => {
      const fake = install()
      fake.setFfmpegFails(true)
      const result = await make(fake).transcribe({ audioPath: fake.audio('bad.ogg', 'x'), language: 'en' })
      expect(result.ok).toBe(false)
      if (!result.ok && result.error.kind === 'failed') {
        expect(result.error.reason).toContain('ffmpeg exited with code 1')
        expect(result.error.reason).toContain('Invalid data found')
      } else throw new Error('expected a failure')
      expect(fake.whisperCalls()).toEqual([])
    })

    it('says it failed when whisper exits with an error', async () => {
      const fake = install()
      fake.setWhisperMode('fail')
      const result = await make(fake).transcribe({ audioPath: fake.audio('a.ogg', 'x'), language: 'en' })
      expect(result.ok).toBe(false)
      if (!result.ok && result.error.kind === 'failed') {
        expect(result.error.reason).toContain('whisper exited with code 3')
      } else throw new Error('expected a failure')
    })

    it('says it failed when whisper exits well but wrote no transcript', async () => {
      const fake = install()
      fake.setWhisperMode('no-output')
      const result = await make(fake).transcribe({ audioPath: fake.audio('a.ogg', 'x'), language: 'en' })
      expect(result).toEqual({ ok: false, error: { kind: 'failed', reason: 'whisper wrote no transcript' } })
    })
  })

  describe('the time limit (RF-20)', () => {
    it('kills the whole process group of a whisper that takes too long, and says timeout', async () => {
      const fake = install()
      fake.setWhisperMode('hang')
      const started = Date.now()
      // Generous: the limit also covers ffmpeg, and on a loaded machine the limit must not fire before whisper starts.
      const result = await make(fake, { timeoutMs: 3_000 }).transcribe({
        audioPath: fake.audio('a.ogg', 'x'),
        language: 'en',
      })
      expect(result).toEqual({ ok: false, error: { kind: 'timeout' } })
      expect(Date.now() - started).toBeLessThan(10_000)
      const { whisper, child } = fake.hangingPids()
      // Both the program and what it started are gone: the group was killed, not just the first process.
      await until(() => !isAlive(whisper) && !isAlive(child), 'the whisper process group to be killed')
      expect(readdirSync(fake.tmpRoot)).toEqual([])
    })

    it('close() kills what is running; that audio is unavailable (it is tried again later), not failed', async () => {
      const fake = install()
      fake.setWhisperMode('hang')
      const transcriber = make(fake)
      const running = transcriber.transcribe({ audioPath: fake.audio('a.ogg', 'x'), language: 'en' })
      await until(() => existsPid(fake), 'whisper to start')
      await transcriber.close()
      expect(await running).toEqual({ ok: false, error: { kind: 'unavailable', reason: 'closed' } })
      const { whisper, child } = fake.hangingPids()
      await until(() => !isAlive(whisper) && !isAlive(child), 'the whisper process group to be killed')
      expect(readdirSync(fake.tmpRoot)).toEqual([])
    })
  })
})

function existsPid(fake: FakeWhisper): boolean {
  try {
    return Number.isFinite(fake.hangingPids().child) && fake.hangingPids().child > 0
  } catch {
    return false
  }
}
