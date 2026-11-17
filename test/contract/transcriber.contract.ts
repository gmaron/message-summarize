import { afterEach, describe, expect, it } from 'vitest'
import type { Transcriber } from '../../src/application/ports/transcriber.js'

/** What a backend gives the contract: a transcriber, and a way to make audio files it can read. */
export interface TranscriberFixture {
  readonly transcriber: Transcriber
  /** The path of an audio file that says `transcript` (before tidying). */
  audio(name: string, transcript: string): string
  /** The path of a file that does not exist. */
  readonly missingAudio: string
  dispose(): void
}

export interface TranscriberBackend {
  readonly name: string
  make(): TranscriberFixture
}

/** Contract of the Transcriber port (src/application/ports/transcriber.ts), for every adapter. */
export function describeTranscriberContract(backend: TranscriberBackend): void {
  describe(`Transcriber contract (${backend.name})`, () => {
    const open: TranscriberFixture[] = []
    const make = (): TranscriberFixture => {
      const fixture = backend.make()
      open.push(fixture)
      return fixture
    }
    afterEach(() => {
      for (const fixture of open.splice(0)) fixture.dispose()
    })

    it('turns an audio into its text', async () => {
      const f = make()
      const result = await f.transcriber.transcribe({
        audioPath: f.audio('a.ogg', 'Che, el sábado cambiamos la comida.'),
        language: 'es',
      })
      expect(result).toEqual({ ok: true, value: 'Che, el sábado cambiamos la comida.' })
    })

    it('tidies the text: whitespace collapsed to single spaces, no spaces at the ends', async () => {
      const f = make()
      const result = await f.transcriber.transcribe({
        audioPath: f.audio('b.ogg', '  Hola,\n   mundo \n\n  otra   línea  \n'),
        language: 'auto',
      })
      expect(result).toEqual({ ok: true, value: 'Hola, mundo otra línea' })
    })

    it('gives an empty transcript, not an error, for an audio with nothing to say', async () => {
      const f = make()
      expect(await f.transcriber.transcribe({ audioPath: f.audio('c.ogg', ''), language: 'auto' })).toEqual({
        ok: true,
        value: '',
      })
    })

    it('accepts "auto" and a language code', async () => {
      const f = make()
      const audioPath = f.audio('d.ogg', 'same words')
      for (const language of ['auto', 'es', 'en']) {
        expect(await f.transcriber.transcribe({ audioPath, language })).toEqual({ ok: true, value: 'same words' })
      }
    })

    it('says the audio failed (not that the transcriber is unavailable) when the file does not exist', async () => {
      const f = make()
      const result = await f.transcriber.transcribe({ audioPath: f.missingAudio, language: 'auto' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('failed')
    })

    it('keeps the answers of audios transcribed at the same time apart', async () => {
      const f = make()
      const results = await Promise.all(
        ['one', 'two', 'three'].map((word) =>
          f.transcriber.transcribe({ audioPath: f.audio(`${word}.ogg`, `the word ${word}`), language: 'en' }),
        ),
      )
      expect(results.map((r) => (r.ok ? r.value : null))).toEqual(['the word one', 'the word two', 'the word three'])
    })

    it('refuses work after it was closed, as unavailable, and closing again is harmless', async () => {
      const f = make()
      await f.transcriber.close?.()
      await f.transcriber.close?.()
      const result = await f.transcriber.transcribe({ audioPath: f.audio('e.ogg', 'text'), language: 'auto' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('unavailable')
    })
  })
}
