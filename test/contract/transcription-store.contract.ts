import { afterEach, describe, expect, it } from 'vitest'
import type { CaptureFixture, PersistenceBackend } from '../support/persistence-backends.js'
import { message } from '../unit/domain/factories.js'

/** A fixed "now" for the download queue, and a backoff that makes a row due again at once. */
const NOW = 1_700_000_000_000
const SOON = (): number => NOW

/** Contract of the TranscriptionStore port (src/application/ports/transcription-store.ts), for every adapter. */
export function describeTranscriptionStoreContract(backend: PersistenceBackend): void {
  describe(`TranscriptionStore contract (${backend.name})`, () => {
    const open: CaptureFixture[] = []
    const make = (): CaptureFixture => {
      const fixture = backend.capture()
      open.push(fixture)
      return fixture
    }
    afterEach(() => {
      for (const fixture of open.splice(0)) fixture.close()
    })

    /** An audio that was downloaded: stored, with its file recorded. */
    const audio = async (f: CaptureFixture, id: string, timestamp: number, conversationId = 'c1'): Promise<void> => {
      await f.repository.insertMessage(message({ id, conversationId, kind: 'audio', text: '[audio]', timestamp }))
      await f.repository.setMedia(conversationId, id, `${id}.ogg`)
    }

    /** An audio whose download is queued, with a descriptor whose path tells which one it is. */
    const queued = async (f: CaptureFixture, id: string, timestamp: number, conversationId = 'c1'): Promise<void> => {
      await f.repository.insertMessage(message({ id, conversationId, kind: 'audio', text: '[audio]', timestamp }))
      await f.repository.queueDownload(conversationId, id, {
        directPath: `/v/${id}`,
        mediaKey: new Uint8Array(32).fill(3),
        mimetype: 'audio/ogg; codecs=opus',
        fileLength: 100,
      })
    }

    describe('the download queue (RF-15, RNF-08)', () => {
      it('hands out the OLDEST queued download first, with its descriptor, ties in the order they were queued', async () => {
        const f = make()
        await queued(f, 'late', 3000)
        await queued(f, 'early', 1000)
        await queued(f, 'tie-1', 2000)
        await queued(f, 'tie-2', 2000)
        const order: string[] = []
        for (;;) {
          const next = await f.downloads.nextDownload(NOW)
          if (next === null) break
          order.push(next.messageId)
          expect(next.descriptor.directPath).toBe(`/v/${next.messageId}`)
          expect(next.descriptor.mediaKey).toEqual(new Uint8Array(32).fill(3))
          expect(await f.downloads.completeDownload(next.conversationId, next.messageId, `${next.messageId}.ogg`)).toBe(
            true,
          )
        }
        expect(order).toEqual(['early', 'tie-1', 'tie-2', 'late'])
      })

      it('counts the queued downloads, and a message with nothing asked is not one', async () => {
        const f = make()
        await f.repository.insertMessage(message({ id: 'plain', kind: 'audio', text: '[audio]' }))
        await queued(f, 'a', 1000)
        await queued(f, 'b', 2000)
        expect(await f.downloads.countDownloads()).toBe(2)
      })

      it('completing stores the file, moves the audio to the transcription queue and clears the descriptor', async () => {
        const f = make()
        await queued(f, 'a', 1000)
        expect(await f.transcription.countPending()).toBe(0)
        expect(await f.downloads.completeDownload('c1', 'a', 'a.ogg')).toBe(true)
        expect(f.rawAudio('c1', 'a')).toMatchObject({
          status: 'pending',
          mediaRef: 'a.ogg',
          hasDescriptor: false,
          attempts: 0,
        })
        expect(await f.downloads.countDownloads()).toBe(0)
        expect(await f.transcription.nextPending()).toMatchObject({ messageId: 'a', mediaRef: 'a.ogg' })
      })

      it('completing twice, or a message that was never queued, changes nothing', async () => {
        const f = make()
        await queued(f, 'a', 1000)
        await f.repository.insertMessage(message({ id: 'plain', kind: 'audio', text: '[audio]' }))
        expect(await f.downloads.completeDownload('c1', 'a', 'a.ogg')).toBe(true)
        expect(await f.downloads.completeDownload('c1', 'a', 'other.ogg')).toBe(false)
        expect(await f.downloads.completeDownload('c1', 'plain', 'p.ogg')).toBe(false)
        expect(await f.downloads.completeDownload('c1', 'zzz', 'z.ogg')).toBe(false)
        expect(f.rawAudio('c1', 'a')?.mediaRef).toBe('a.ogg')
      })

      it('a permanent failure is recorded with its code, the descriptor is cleared and it is not queued again', async () => {
        const f = make()
        await queued(f, 'a', 1000)
        await queued(f, 'b', 2000)
        await f.downloads.failDownload('c1', 'a', 'expired')
        expect(f.rawAudio('c1', 'a')).toMatchObject({ status: 'failed', error: 'expired', hasDescriptor: false })
        expect((await f.downloads.nextDownload(NOW))?.messageId).toBe('b')
        expect(await f.downloads.countDownloads()).toBe(1)
        expect(await f.transcription.countPending()).toBe(0)
      })

      it('a transient failure keeps the audio queued and counts the attempt, until the limit makes it a permanent failure', async () => {
        const f = make()
        await queued(f, 'a', 1000)
        expect(await f.downloads.retryDownload('c1', 'a', 3, SOON)).toBe('retry')
        expect(f.rawAudio('c1', 'a')).toMatchObject({ status: 'download_pending', attempts: 1, hasDescriptor: true })
        expect(await f.downloads.retryDownload('c1', 'a', 3, SOON)).toBe('retry')
        expect(f.rawAudio('c1', 'a')?.attempts).toBe(2)
        expect(await f.downloads.retryDownload('c1', 'a', 3, SOON)).toBe('failed')
        expect(f.rawAudio('c1', 'a')).toMatchObject({
          status: 'failed',
          error: 'download-failed',
          hasDescriptor: false,
        })
        expect(await f.downloads.countDownloads()).toBe(0)
      })

      it('a retry of an audio that is not queued any more changes nothing', async () => {
        const f = make()
        await queued(f, 'a', 1000)
        await f.downloads.completeDownload('c1', 'a', 'a.ogg')
        expect(await f.downloads.retryDownload('c1', 'a', 1, SOON)).toBe('retry')
        expect(f.rawAudio('c1', 'a')?.status).toBe('pending')
      })

      it('a transient failure is not due again before its backoff, and the ones behind it go on', async () => {
        const f = make()
        await queued(f, 'a', 1000)
        await queued(f, 'b', 2000)
        const asked: number[] = []
        await f.downloads.retryDownload('c1', 'a', 5, (attempts) => {
          asked.push(attempts)
          return NOW + 60_000
        })
        expect(asked).toEqual([1])
        expect((await f.downloads.nextDownload(NOW))?.messageId).toBe('b')
        await f.downloads.completeDownload('c1', 'b', 'b.ogg')
        expect(await f.downloads.nextDownload(NOW)).toBeNull()
        expect(await f.downloads.nextDownload(NOW + 59_999)).toBeNull()
        expect((await f.downloads.nextDownload(NOW + 60_000))?.messageId).toBe('a')
        expect(await f.downloads.countDownloads()).toBe(1)
      })

      it('the backoff goes with the descriptor: it is gone when the download fails for good', async () => {
        const f = make()
        await queued(f, 'a', 1000)
        await f.downloads.retryDownload('c1', 'a', 5, () => NOW + 60_000)
        await f.downloads.failDownload('c1', 'a', 'expired')
        expect(f.rawAudio('c1', 'a')).toMatchObject({ status: 'failed', hasDescriptor: false })
      })
    })

    describe('the download sweep', () => {
      const DAY = 24 * 60 * 60 * 1000

      it('fails an audio with no path or no key as invalid-media, clears what is left and leaves the others', async () => {
        const f = make()
        await queued(f, 'broken', NOW - 1000)
        await queued(f, 'fine', NOW - 500)
        f.corruptDescriptor('c1', 'broken')
        expect(await f.downloads.sweepDownloads(NOW, 30 * DAY)).toEqual({ invalid: 1, expired: 0 })
        expect(f.rawAudio('c1', 'broken')).toMatchObject({
          status: 'failed',
          error: 'invalid-media',
          hasDescriptor: false,
        })
        expect(f.rawAudio('c1', 'fine')).toMatchObject({ status: 'download_pending', hasDescriptor: true })
      })

      it('fails an audio older than the limit as expired and clears its descriptor (the key)', async () => {
        const f = make()
        await queued(f, 'old', NOW - 31 * DAY)
        await queued(f, 'recent', NOW - 29 * DAY)
        expect(await f.downloads.sweepDownloads(NOW, 30 * DAY)).toEqual({ invalid: 0, expired: 1 })
        expect(f.rawAudio('c1', 'old')).toMatchObject({ status: 'failed', error: 'expired', hasDescriptor: false })
        expect(f.rawAudio('c1', 'recent')).toMatchObject({ status: 'download_pending', hasDescriptor: true })
        expect(await f.downloads.countDownloads()).toBe(1)
      })

      it('touches nothing that is not waiting to be downloaded, and does nothing on an empty queue', async () => {
        const f = make()
        expect(await f.downloads.sweepDownloads(NOW, 30 * DAY)).toEqual({ invalid: 0, expired: 0 })
        await audio(f, 'stored', NOW - 90 * DAY)
        expect(await f.downloads.sweepDownloads(NOW, 30 * DAY)).toEqual({ invalid: 0, expired: 0 })
        expect(f.rawAudio('c1', 'stored')?.status).toBe('pending')
      })
    })

    it('has nothing pending when nothing was downloaded', async () => {
      const f = make()
      await f.repository.insertMessage(message({ id: 'a', kind: 'audio', text: '[audio]' }))
      await f.repository.insertMessage(message({ id: 't', text: 'hello' }))
      expect(await f.transcription.nextPending()).toBeNull()
      expect(await f.transcription.countPending()).toBe(0)
    })

    it('hands out the OLDEST pending audio first, ties in the order they were stored', async () => {
      const f = make()
      await audio(f, 'late', 3000)
      await audio(f, 'early', 1000)
      await audio(f, 'tie-1', 2000)
      await audio(f, 'tie-2', 2000)
      const order: string[] = []
      for (;;) {
        const next = await f.transcription.nextPending()
        if (next === null) break
        order.push(next.messageId)
        expect(await f.transcription.complete(next.conversationId, next.messageId, 'text')).toBe(true)
      }
      expect(order).toEqual(['early', 'tie-1', 'tie-2', 'late'])
    })

    it('says where the file is, and when the message is from', async () => {
      const f = make()
      await audio(f, 'a', 1234, 'chat-9')
      expect(await f.transcription.nextPending()).toEqual({
        conversationId: 'chat-9',
        messageId: 'a',
        mediaRef: 'a.ogg',
        timestamp: 1234,
      })
    })

    it('limits to a time range: from inclusive, until exclusive', async () => {
      const f = make()
      await audio(f, 'a', 1000)
      await audio(f, 'b', 2000)
      await audio(f, 'c', 3000)
      expect(await f.transcription.countPending({ from: 2000, until: 3000 })).toBe(1)
      expect((await f.transcription.nextPending({ from: 2000, until: 3000 }))?.messageId).toBe('b')
      expect(await f.transcription.countPending({ from: 1500 })).toBe(2)
      expect(await f.transcription.countPending({ until: 1000 })).toBe(0)
      expect(await f.transcription.countPending()).toBe(3)
    })

    it('completing stores the transcript (even an empty one) and takes the audio out of the queue', async () => {
      const f = make()
      await audio(f, 'a', 1000)
      await audio(f, 'b', 2000)
      expect(await f.transcription.complete('c1', 'a', 'hello there')).toBe(true)
      expect(await f.transcription.complete('c1', 'b', '')).toBe(true)
      expect(await f.transcription.countPending()).toBe(0)
      const stored = await f.source.messagesInWindow('c1', { since: 0, until: 10_000 })
      expect(stored.map((m) => m.transcript)).toEqual(['hello there', ''])
    })

    it('completes an audio once: a second process that finishes it later changes nothing', async () => {
      const f = make()
      await audio(f, 'a', 1000)
      expect(await f.transcription.complete('c1', 'a', 'first')).toBe(true)
      expect(await f.transcription.complete('c1', 'a', 'second')).toBe(false)
      expect((await f.source.messagesInWindow('c1', { since: 0, until: 10_000 }))[0]?.transcript).toBe('first')
    })

    it('does not complete a message that is unknown or was never queued', async () => {
      const f = make()
      await f.repository.insertMessage(message({ id: 'a', kind: 'audio', text: '[audio]' }))
      expect(await f.transcription.complete('c1', 'a', 'x')).toBe(false)
      expect(await f.transcription.complete('c1', 'zzz', 'x')).toBe(false)
    })

    it('failing takes the audio out of the queue for good, with no transcript', async () => {
      const f = make()
      await audio(f, 'a', 1000)
      await audio(f, 'b', 2000)
      await f.transcription.fail('c1', 'a', 'whisper exited with code 1')
      expect((await f.transcription.nextPending())?.messageId).toBe('b')
      expect(await f.transcription.countPending()).toBe(1)
      expect(await f.transcription.complete('c1', 'a', 'late')).toBe(false)
      expect((await f.source.messagesInWindow('c1', { since: 0, until: 10_000 }))[0]?.transcript).toBeNull()
    })

    it('an audio that already has a transcript never enters the queue', async () => {
      const f = make()
      await f.repository.insertMessage(message({ id: 'a', kind: 'audio', transcript: 'already' }))
      await f.repository.setMedia('c1', 'a', 'a.ogg')
      expect(await f.transcription.countPending()).toBe(0)
    })
  })
}
