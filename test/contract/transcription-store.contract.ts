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
        kind: 'audio',
        caption: null,
      })
    })

    it('queues an image like an audio, and says it is one, with the text of its message as context', async () => {
      const f = make()
      await f.repository.insertMessage(
        message({ id: 'p', conversationId: 'c1', kind: 'image', text: '[imagen] Mirá', timestamp: 500 }),
      )
      expect(
        await f.repository.queueDownload('c1', 'p', {
          directPath: '/v/p',
          mediaKey: new Uint8Array(32).fill(3),
          mimetype: 'image/jpeg',
          fileLength: 100,
        }),
      ).toBe(true)
      expect(await f.downloads.completeDownload('c1', 'p', 'p.jpg')).toBe(true)
      await audio(f, 'a', 1000)
      expect(await f.transcription.nextPending()).toEqual({
        conversationId: 'c1',
        messageId: 'p',
        mediaRef: 'p.jpg',
        timestamp: 500,
        kind: 'image',
        caption: '[imagen] Mirá',
      })
      expect(await f.transcription.complete('c1', 'p', 'Feria del libro')).toBe(true)
      expect((await f.transcription.nextPending())?.kind).toBe('audio')
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

    describe('claims: the queue of a pool of workers', () => {
      it('hands out each pending audio ONCE, newest first by default, and nothing when all are claimed', async () => {
        const f = make()
        await audio(f, 'old', 1000)
        await audio(f, 'new', 3000)
        await audio(f, 'mid', 2000)
        const order: string[] = []
        for (;;) {
          const next = await f.transcription.claimPending()
          if (next === null) break
          order.push(next.messageId)
        }
        expect(order).toEqual(['new', 'mid', 'old'])
        // Claimed audios are still pending (waiting for their transcript) but nobody else gets them.
        expect(await f.transcription.countPending()).toBe(3)
        expect(await f.transcription.claimPending()).toBeNull()
      })

      it('claims the OLDEST first when asked, and only inside the range', async () => {
        const f = make()
        await audio(f, 'a', 1000)
        await audio(f, 'b', 2000)
        await audio(f, 'c', 3000)
        expect((await f.transcription.claimPending({ from: 2000, until: 4000 }, 'oldest'))?.messageId).toBe('b')
        expect((await f.transcription.claimPending({ from: 2000, until: 4000 }, 'oldest'))?.messageId).toBe('c')
        expect(await f.transcription.claimPending({ from: 2000, until: 4000 }, 'oldest')).toBeNull()
        expect((await f.transcription.claimPending(undefined, 'oldest'))?.messageId).toBe('a')
      })

      it('many claims at once never give the same audio twice', async () => {
        const f = make()
        for (let i = 0; i < 12; i++) await audio(f, `a${i}`, 1000 + i)
        const got = await Promise.all(Array.from({ length: 20 }, () => f.transcription.claimPending()))
        const ids = got.flatMap((a) => (a === null ? [] : [a.messageId]))
        expect(ids).toHaveLength(12)
        expect(new Set(ids).size).toBe(12)
      })

      it('a released claim is claimable again, and a finished one never is', async () => {
        const f = make()
        await audio(f, 'a', 1000)
        await audio(f, 'b', 2000)
        const first = await f.transcription.claimPending()
        expect(first?.messageId).toBe('b')
        await f.transcription.releaseClaim('c1', 'b')
        expect((await f.transcription.claimPending())?.messageId).toBe('b')
        expect(await f.transcription.complete('c1', 'b', 'done')).toBe(true)
        expect((await f.transcription.claimPending())?.messageId).toBe('a')
        await f.transcription.fail('c1', 'a', 'broken')
        expect(await f.transcription.claimPending()).toBeNull()
        expect(await f.transcription.countPending()).toBe(0)
      })

      it('after a restart (releaseAllClaims) the audios that were in progress are pending again', async () => {
        const f = make()
        await audio(f, 'a', 1000)
        await audio(f, 'b', 2000)
        await f.transcription.claimPending()
        await f.transcription.claimPending()
        expect(await f.transcription.claimPending()).toBeNull()
        expect(await f.transcription.releaseAllClaims()).toBe(2)
        expect(await f.transcription.releaseAllClaims()).toBe(0)
        expect((await f.transcription.claimPending())?.messageId).toBe('b')
        expect((await f.transcription.claimPending())?.messageId).toBe('a')
      })

      it('counts the queues for the progress log: downloading, pending, running, done, failed, re-upload', async () => {
        const f = make()
        await queued(f, 'd1', 100)
        await queued(f, 'd2', 200)
        await audio(f, 'p1', 300)
        await audio(f, 'p2', 400)
        await audio(f, 'r1', 500)
        await audio(f, 'x1', 600)
        await audio(f, 'x2', 700)
        await f.transcription.complete('c1', 'x1', 'text')
        await f.transcription.fail('c1', 'x2', 'bad')
        await f.transcription.claimPending(undefined, 'newest') // r1 is the newest left
        expect(await f.transcription.audioQueueStats()).toEqual({
          downloading: 2,
          pending: 2,
          running: 1,
          done: 1,
          failed: 1,
          reuploadRequested: 0,
        })
      })
    })

    describe('claims and re-upload on the download queue', () => {
      const key = { remoteJid: '5491100000000@s.whatsapp.net', fromMe: false, participant: null }
      const withKey = async (f: CaptureFixture, id: string, timestamp: number): Promise<void> => {
        await f.repository.insertMessage(
          message({ id, conversationId: 'c1', kind: 'audio', text: '[audio]', timestamp }),
        )
        await f.repository.queueDownload('c1', id, {
          directPath: `/v/${id}`,
          mediaKey: new Uint8Array(32).fill(3),
          mimetype: 'audio/ogg',
          fileLength: 10,
          reuploadKey: key,
        })
      }
      const LEASE = 120_000

      it('a claim is exclusive and leased: nobody else gets it until the lease runs out or it is released', async () => {
        const f = make()
        await queued(f, 'a', 1000)
        await queued(f, 'b', 2000)
        expect((await f.downloads.claimDownload(NOW, LEASE))?.messageId).toBe('a')
        expect((await f.downloads.claimDownload(NOW, LEASE))?.messageId).toBe('b')
        expect(await f.downloads.claimDownload(NOW, LEASE)).toBeNull()
        await f.downloads.releaseDownload('c1', 'a')
        expect((await f.downloads.claimDownload(NOW, LEASE))?.messageId).toBe('a')
        // Once the leases run out both are due again, the oldest first.
        expect((await f.downloads.claimDownload(NOW + LEASE, LEASE))?.messageId).toBe('a')
        expect((await f.downloads.claimDownload(NOW + LEASE, LEASE))?.messageId).toBe('b')
      })

      it('keeps the key of the message with the descriptor, and clears it with the descriptor', async () => {
        const f = make()
        await withKey(f, 'a', 1000)
        const item = await f.downloads.claimDownload(NOW, LEASE)
        expect(item?.descriptor.reuploadKey).toEqual(key)
        expect(item?.reuploadAttempts).toBe(0)
        await f.downloads.completeDownload('c1', 'a', 'a.ogg')
        await queued(f, 'plain', 2000)
        expect((await f.downloads.claimDownload(NOW, LEASE))?.descriptor.reuploadKey).toBeUndefined()
      })

      it('an audio the server forgot waits for the phone; the answer makes it downloadable again with the new path', async () => {
        const f = make()
        await withKey(f, 'a', 1000)
        await f.downloads.claimDownload(NOW, LEASE)
        expect(await f.downloads.markNeedsReupload('c1', 'a')).toBe(true)
        // Not downloadable while it waits, but it is in the re-upload queue, and counted.
        expect(await f.downloads.claimDownload(NOW, LEASE)).toBeNull()
        expect((await f.transcription.audioQueueStats()).reuploadRequested).toBe(1)
        const request = await f.downloads.claimReupload(NOW, LEASE)
        expect(request?.messageId).toBe('a')
        expect(await f.downloads.claimReupload(NOW, LEASE)).toBeNull()
        await f.downloads.completeReupload('c1', 'a', '/v/new-place')
        expect(await f.downloads.claimReupload(NOW, LEASE)).toBeNull()
        const again = await f.downloads.claimDownload(NOW, LEASE)
        expect(again?.descriptor.directPath).toBe('/v/new-place')
        expect(again?.reuploadAttempts).toBe(1)
      })

      it('an audio without the key of its message cannot wait for the phone', async () => {
        const f = make()
        await queued(f, 'plain', 1000)
        await f.downloads.claimDownload(NOW, LEASE)
        expect(await f.downloads.markNeedsReupload('c1', 'plain')).toBe(false)
      })

      it('a request the phone does not answer is tried again later, a bounded number of times, then fails as expired', async () => {
        const f = make()
        await withKey(f, 'a', 1000)
        await f.downloads.markNeedsReupload('c1', 'a')
        await f.downloads.claimReupload(NOW, LEASE)
        expect(await f.downloads.retryReupload('c1', 'a', 3, (n) => NOW + n * 1000)).toBe('retry')
        expect(await f.downloads.claimReupload(NOW + 999, LEASE)).toBeNull() // backoff
        expect((await f.downloads.claimReupload(NOW + 1000, LEASE))?.reuploadAttempts).toBe(1)
        expect(await f.downloads.retryReupload('c1', 'a', 3, (n) => NOW + 1000 + n * 1000)).toBe('retry')
        expect(await f.downloads.retryReupload('c1', 'a', 3, (n) => NOW + n * 100_000)).toBe('failed')
        expect(f.rawAudio('c1', 'a')).toMatchObject({ status: 'failed', error: 'expired', hasDescriptor: false })
      })

      it('the sweep has no age limit when asked for none, and still fails what has no key', async () => {
        const f = make()
        await queued(f, 'old', 1)
        expect(await f.downloads.sweepDownloads(NOW, null)).toEqual({ invalid: 0, expired: 0 })
        expect(f.rawAudio('c1', 'old')?.status).toBe('download_pending')
      })
    })
  })
}
