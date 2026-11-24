import { describe, expect, it } from 'vitest'
import {
  createDownloadAudios,
  type DownloadOutcome,
  downloadBackoffMs,
  MAX_REUPLOAD_ATTEMPTS,
  REUPLOAD_MIN_INTERVAL_MS,
  reuploadBackoffMs,
} from '../../../src/application/download-audios.js'
import type {
  AudioDownloader,
  DownloadFailure,
  PendingDownload,
} from '../../../src/application/ports/download-queue.js'
import { err, ok, type Result } from '../../../src/domain/result.js'
import { InMemoryCaptureRepository } from '../../support/capture-fakes.js'
import { message } from '../domain/factories.js'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const KEY = { remoteJid: '5491100000001@s.whatsapp.net', fromMe: false, participant: null }

async function queued(repo: InMemoryCaptureRepository, id: string, timestamp: number, withKey = false): Promise<void> {
  await repo.insertMessage(message({ id, kind: 'audio', text: '[audio]', timestamp }))
  await repo.queueDownload('c1', id, {
    directPath: `/v/${id}`,
    mediaKey: new Uint8Array(32).fill(1),
    mimetype: 'audio/ogg',
    fileLength: 10,
    ...(withKey ? { reuploadKey: KEY } : {}),
  })
}

/** A downloader the test controls, with an optional re-upload request. */
class FakeDownloader implements AudioDownloader {
  readonly started: string[] = []
  readonly paths: string[] = []
  readonly reuploads: string[] = []
  inFlight = 0
  maxInFlight = 0
  supportsReupload = true
  answer: (item: PendingDownload) => Promise<Result<string, DownloadFailure>> = async (item) =>
    ok(`${item.messageId}.ogg`)
  reupload: (item: PendingDownload) => Promise<Result<string, DownloadFailure>> = async (item) =>
    ok(`/v/${item.messageId}-again`)

  async download(item: PendingDownload): Promise<Result<string, DownloadFailure>> {
    this.started.push(item.messageId)
    this.paths.push(item.descriptor.directPath)
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      return await this.answer(item)
    } finally {
      this.inFlight--
    }
  }

  async requestReupload(item: PendingDownload): Promise<Result<string, DownloadFailure>> {
    this.reuploads.push(item.messageId)
    return this.reupload(item)
  }

  canRequestReupload(): boolean {
    return this.supportsReupload
  }

  abort(): void {}
}

function setup(
  options: {
    concurrency?: number
    maxReuploadAttempts?: number
    awaiting?: () => Promise<number>
    maxAwaiting?: number
    wait?: (ms: number) => Promise<void>
    /** Changes the downloader before the worker is made (the worker looks at what it can do when it starts). */
    configure?: (downloader: FakeDownloader) => void
  } = {},
) {
  const repo = new InMemoryCaptureRepository()
  const downloader = new FakeDownloader()
  options.configure?.(downloader)
  const outcomes: DownloadOutcome[] = []
  const clock = { time: 1_000_000, now: () => clock.time }
  /** The waits the worker asked for: the clock jumps over them, nothing is really waited for. */
  const waits: number[] = []
  const worker = createDownloadAudios({
    queue: repo,
    downloader,
    clock,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.maxReuploadAttempts === undefined ? {} : { maxReuploadAttempts: options.maxReuploadAttempts }),
    ...(options.awaiting === undefined ? {} : { awaiting: options.awaiting }),
    ...(options.maxAwaiting === undefined ? {} : { maxAwaiting: options.maxAwaiting }),
    onOutcome: (outcome) => outcomes.push(outcome),
    wait:
      options.wait ??
      (async (ms) => {
        waits.push(ms)
        // One shared timeline: waiting until a moment is waiting until that moment, however many wait together.
        const until = clock.time + ms
        await flush()
        clock.time = Math.max(clock.time, until)
      }),
  })
  return { repo, downloader, worker, outcomes, clock, waits }
}

const state = (repo: InMemoryCaptureRepository, id: string) => repo.media.get(JSON.stringify(['c1', id]))

describe('downloads in parallel (transcription.downloadConcurrency)', () => {
  it('runs up to N downloads at once, never more, and every audio is downloaded exactly once', async () => {
    const t = setup({ concurrency: 3 })
    for (let i = 0; i < 20; i++) await queued(t.repo, `a${String(i).padStart(2, '0')}`, 1000 + i)
    t.downloader.answer = async (item) => {
      await flush()
      await flush()
      return ok(`${item.messageId}.ogg`)
    }
    t.worker.kick()
    await t.worker.idle()
    expect(t.downloader.maxInFlight).toBe(3)
    expect([...t.downloader.started].sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `a${String(i).padStart(2, '0')}`),
    )
    expect(new Set(t.downloader.started).size).toBe(20)
    expect(await t.repo.countDownloads()).toBe(0)
    expect(await t.repo.countPending()).toBe(20)
  })

  it('one worker is the default: the downloads go one at a time, oldest first', async () => {
    const t = setup()
    for (let i = 0; i < 4; i++) await queued(t.repo, `a${i}`, 1000 + i)
    t.downloader.answer = async (item) => {
      await flush()
      return ok(`${item.messageId}.ogg`)
    }
    t.worker.kick()
    await t.worker.idle()
    expect(t.downloader.maxInFlight).toBe(1)
    expect(t.downloader.started).toEqual(['a0', 'a1', 'a2', 'a3'])
  })

  it('an audio that arrives while some workers are idle is picked up at once, in parallel with the busy ones', async () => {
    const t = setup({ concurrency: 3 })
    await queued(t.repo, 'slow', 1000)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    t.downloader.answer = async (item) => {
      if (item.messageId === 'slow') await held
      return ok(`${item.messageId}.ogg`)
    }
    t.worker.kick()
    await flush()
    await queued(t.repo, 'fast', 2000)
    t.worker.kick()
    await flush()
    expect(state(t.repo, 'fast')?.status).toBe('pending') // done while 'slow' is still held
    expect(state(t.repo, 'slow')?.status).toBe('download_pending')
    release()
    await t.worker.idle()
    expect(state(t.repo, 'slow')?.status).toBe('pending')
  })

  it('an audio that is claimed by a worker is not handed to another one while it is downloading', async () => {
    const t = setup({ concurrency: 4 })
    await queued(t.repo, 'only', 1000)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    t.downloader.answer = async (item) => {
      await held
      return ok(`${item.messageId}.ogg`)
    }
    t.worker.kick()
    t.worker.kick()
    await flush()
    expect(t.downloader.started).toEqual(['only'])
    release()
    await t.worker.idle()
    expect(t.downloader.started).toEqual(['only'])
  })
})

describe('an old media: the phone is asked to upload it again (RF-15)', () => {
  const expired = (): Result<string, DownloadFailure> => err({ kind: 'permanent', reason: 'expired' })

  it('404/410 -> re-upload requested -> the download is retried with the new place and succeeds', async () => {
    const t = setup()
    await queued(t.repo, 'old', 1000, true)
    t.downloader.answer = async (item) =>
      item.descriptor.directPath === '/v/old' ? expired() : ok(`${item.messageId}.ogg`)
    t.worker.kick()
    await t.worker.idle()
    expect(t.downloader.reuploads).toEqual(['old'])
    expect(t.downloader.paths).toEqual(['/v/old', '/v/old-again'])
    expect(t.outcomes).toEqual(['reupload-requested', 'reuploaded', 'downloaded'])
    expect(state(t.repo, 'old')).toMatchObject({ status: 'pending', ref: 'old.ogg', descriptor: null })
  })

  it('an audio waiting for the phone does not hold a download worker: the audios behind it go on', async () => {
    const t = setup()
    await queued(t.repo, 'old', 1000, true)
    await queued(t.repo, 'recent', 2000, true)
    let answer: (result: Result<string, DownloadFailure>) => void = () => {}
    t.downloader.reupload = () =>
      new Promise((resolve) => {
        answer = resolve
      })
    t.downloader.answer = async (item) =>
      item.descriptor.directPath === '/v/old' ? expired() : ok(`${item.messageId}.ogg`)
    t.worker.kick()
    await flush()
    expect(state(t.repo, 'recent')?.status).toBe('pending') // downloaded while the phone has not answered
    expect((await t.repo.audioQueueStats()).reuploadRequested).toBe(1)
    answer(ok('/v/old-again'))
    await t.worker.idle()
    expect(state(t.repo, 'old')?.status).toBe('pending')
  })

  it('the phone says it does not have the file either: the audio fails as expired and the key is cleared', async () => {
    const t = setup()
    await queued(t.repo, 'old', 1000, true)
    t.downloader.answer = async () => expired()
    t.downloader.reupload = async () => err({ kind: 'permanent', reason: 'expired' })
    t.worker.kick()
    await t.worker.idle()
    expect(state(t.repo, 'old')).toMatchObject({ status: 'failed', error: 'expired', descriptor: null })
    expect(t.downloader.started).toEqual(['old']) // never downloaded again
  })

  it('without the key of the message, or on a platform that cannot ask, it fails as expired at once', async () => {
    const t = setup()
    await queued(t.repo, 'nokey', 1000, false)
    await queued(t.repo, 'cannot', 2000, true)
    t.downloader.answer = async () => expired()
    t.downloader.supportsReupload = false
    t.worker.kick()
    await t.worker.idle()
    expect(state(t.repo, 'nokey')).toMatchObject({ status: 'failed', error: 'expired' })
    expect(state(t.repo, 'cannot')).toMatchObject({ status: 'failed', error: 'expired' })
    expect(t.downloader.reuploads).toEqual([])
  })

  it('a phone that does not answer is asked again later (backoff), a bounded number of times, then it fails as expired', async () => {
    const t = setup({ maxReuploadAttempts: 3 })
    await queued(t.repo, 'old', 1000, true)
    t.downloader.answer = async () => expired()
    t.downloader.reupload = async () => err({ kind: 'transient', reason: 'timeout' })
    for (let round = 0; round < 6; round++) {
      t.worker.kick()
      await t.worker.idle()
      t.clock.time += 20 * 60_000 // past the backoff
    }
    expect(t.downloader.reuploads).toEqual(['old', 'old', 'old'])
    expect(state(t.repo, 'old')).toMatchObject({ status: 'failed', error: 'expired', descriptor: null })
    expect(t.outcomes.filter((o) => o === 'reupload-retry')).toHaveLength(2)
  })

  it('a media that expires again after the phone uploaded it is not asked for forever: the attempts are bounded', async () => {
    const t = setup({ maxReuploadAttempts: 2 })
    await queued(t.repo, 'old', 1000, true)
    t.downloader.answer = async () => expired()
    t.worker.kick()
    await t.worker.idle()
    expect(t.downloader.reuploads).toHaveLength(2)
    expect(state(t.repo, 'old')).toMatchObject({ status: 'failed', error: 'expired' })
  })

  it('requests START at most one per interval (2 s), whatever the number of workers', async () => {
    const t = setup({ concurrency: 4 })
    for (let i = 0; i < 6; i++) await queued(t.repo, `old${i}`, 1000 + i, true)
    t.downloader.answer = async (item) =>
      item.descriptor.directPath.endsWith('-again') ? ok(`${item.messageId}.ogg`) : expired()
    const startedAt: number[] = []
    t.downloader.reupload = async (item) => {
      startedAt.push(t.clock.time)
      return ok(`/v/${item.messageId}-again`)
    }
    t.worker.kick()
    await t.worker.idle()
    expect(startedAt).toHaveLength(6)
    for (let i = 1; i < startedAt.length; i++) {
      expect((startedAt[i] ?? 0) - (startedAt[i - 1] ?? 0)).toBeGreaterThanOrEqual(REUPLOAD_MIN_INTERVAL_MS)
    }
    expect(await t.repo.countPending()).toBe(6)
  })

  it('a connection that goes away during a request leaves the audio waiting, with nothing counted', async () => {
    const t = setup()
    await queued(t.repo, 'old', 1000, true)
    t.downloader.answer = async () => expired()
    t.downloader.reupload = async () => err({ kind: 'unavailable', reason: 'not-connected' })
    t.worker.kick()
    await t.worker.idle()
    expect(t.outcomes).toContain('unavailable')
    expect(state(t.repo, 'old')).toMatchObject({ status: 'download_pending', needsReupload: true })
    expect(state(t.repo, 'old')?.reuploadAttempts ?? 0).toBe(0)
    // Back online: the same audio is asked for again.
    t.downloader.reupload = async (item) => ok(`/v/${item.messageId}-again`)
    t.downloader.answer = async (item) =>
      item.descriptor.directPath.endsWith('-again') ? ok(`${item.messageId}.ogg`) : expired()
    t.worker.kick()
    await t.worker.idle()
    expect(state(t.repo, 'old')?.status).toBe('pending')
  })

  it('a permanent failure that is not "expired" is final: the phone is not asked', async () => {
    const t = setup()
    await queued(t.repo, 'big', 1000, true)
    t.downloader.answer = async () => err({ kind: 'permanent', reason: 'too-big' })
    t.worker.kick()
    await t.worker.idle()
    expect(t.downloader.reuploads).toEqual([])
    expect(state(t.repo, 'big')).toMatchObject({ status: 'failed', error: 'too-big' })
  })

  it('a media without the key of its message fails as expired even where the platform can ask', async () => {
    const t = setup()
    await queued(t.repo, 'nokey', 1000, false)
    t.downloader.answer = async () => expired()
    t.worker.kick()
    await t.worker.idle()
    expect(t.downloader.reuploads).toEqual([])
    expect(state(t.repo, 'nokey')).toMatchObject({ status: 'failed', error: 'expired' })
  })

  it('a platform that cannot ask at all (no request method) fails an expired media at once; one that does not say if it can is asked', async () => {
    const none = setup({
      configure: (d) => {
        ;(d as { requestReupload?: unknown }).requestReupload = undefined
      },
    })
    await queued(none.repo, 'a', 1000, true)
    none.downloader.answer = async () => expired()
    none.worker.kick()
    await none.worker.idle()
    expect(state(none.repo, 'a')).toMatchObject({ status: 'failed', error: 'expired' })

    const silent = setup()
    await queued(silent.repo, 'b', 1000, true)
    silent.downloader.answer = async (item) =>
      item.descriptor.directPath.endsWith('-again') ? ok(`${item.messageId}.ogg`) : expired()
    ;(silent.downloader as { canRequestReupload?: unknown }).canRequestReupload = undefined
    silent.worker.kick()
    await silent.worker.idle()
    expect(silent.downloader.reuploads).toEqual(['b'])
    expect(state(silent.repo, 'b')?.status).toBe('pending')
  })

  it('reports an audio the phone no longer has, and one the phone never answered for, as failed', async () => {
    const gone = setup()
    await queued(gone.repo, 'a', 1000, true)
    gone.downloader.answer = async () => expired()
    gone.downloader.reupload = async () => err({ kind: 'permanent', reason: 'expired' })
    gone.worker.kick()
    await gone.worker.idle()
    expect(gone.outcomes.filter((o) => o === 'failed')).toHaveLength(1)

    const silent = setup({ maxReuploadAttempts: 1 })
    await queued(silent.repo, 'b', 1000, true)
    silent.downloader.answer = async () => expired()
    silent.downloader.reupload = async () => err({ kind: 'transient', reason: 'timeout' })
    silent.worker.kick()
    await silent.worker.idle()
    expect(silent.outcomes.filter((o) => o === 'failed')).toHaveLength(1)
    expect(silent.outcomes).not.toContain('reupload-retry')
  })

  it('does not ask again before the backoff of the phone (1 minute) is over', async () => {
    const t = setup()
    await queued(t.repo, 'old', 1000, true)
    t.downloader.answer = async () => expired()
    t.downloader.reupload = async () => err({ kind: 'transient', reason: 'timeout' })
    const kickOnce = async () => {
      t.worker.kick()
      await t.worker.idle()
    }
    await kickOnce()
    await kickOnce()
    expect(t.downloader.reuploads).toHaveLength(1)
    t.clock.time += reuploadBackoffMs(1) - 1
    await kickOnce()
    expect(t.downloader.reuploads).toHaveLength(1)
    t.clock.time += 1
    await kickOnce()
    expect(t.downloader.reuploads).toHaveLength(2)
  })

  it('the backoff grows: 1 minute, 4, 16; and 30 s, 1 min, 2 min, 4 min for a download', () => {
    expect([0, 1, 2, 3, 4].map(reuploadBackoffMs)).toEqual([60_000, 60_000, 240_000, 960_000, 3_840_000])
    expect([0, 1, 2, 3, 4].map(downloadBackoffMs)).toEqual([30_000, 30_000, 60_000, 120_000, 240_000])
  })

  it('a store that fails while a request is going gives the audio back, so it is asked again at once', async () => {
    const t = setup()
    await queued(t.repo, 'old', 1000, true)
    t.downloader.answer = async (item) =>
      item.descriptor.directPath.endsWith('-again') ? ok(`${item.messageId}.ogg`) : expired()
    const complete = t.repo.completeReupload.bind(t.repo)
    let broken = true
    t.repo.completeReupload = async (...args) => {
      if (broken) throw new Error('database is closed')
      return complete(...args)
    }
    t.worker.kick()
    await t.worker.idle()
    expect(t.outcomes).toContain('error')
    expect(t.downloader.reuploads).toEqual(['old'])
    broken = false
    t.worker.kick()
    await t.worker.idle()
    expect(t.downloader.reuploads).toEqual(['old', 'old'])
  })

  it('a queue that cannot be read for requests is an error, not an exception', async () => {
    const t = setup()
    await queued(t.repo, 'old', 1000, true)
    t.downloader.answer = async () => expired()
    t.repo.claimReupload = async () => {
      throw new Error('database is closed')
    }
    t.worker.kick()
    await t.worker.idle()
    expect(t.outcomes).toContain('error')
    expect(t.downloader.reuploads).toEqual([])
  })

  it('stopping while a request waits for its turn leaves the audio for later and does not send the request', async () => {
    let release: () => void = () => {}
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    const t = setup({ wait: () => turn })
    await queued(t.repo, 'first', 1000, true)
    await queued(t.repo, 'second', 2000, true)
    t.downloader.answer = async (item) =>
      item.descriptor.directPath.endsWith('-again') ? ok(`${item.messageId}.ogg`) : expired()
    t.worker.kick()
    await flush()
    await flush()
    expect(t.downloader.reuploads).toEqual(['first'])
    const stopping = t.worker.stop()
    release()
    await stopping
    expect(t.downloader.reuploads).toEqual(['first'])
    expect(state(t.repo, 'second')).toMatchObject({ status: 'download_pending', needsReupload: true })
    expect(state(t.repo, 'second')?.nextAttemptAt).toBeUndefined()
  })

  it.each([
    ['the phone does not have the file: final', err({ kind: 'permanent', reason: 'expired' }), 'failed'],
    ['the phone does not answer: tried again later', err({ kind: 'transient', reason: 'timeout' }), 'reupload-retry'],
  ] as [string, Result<string, DownloadFailure>, DownloadOutcome][])(
    'one kick is enough for more audios than request workers (%s)',
    async (_name, answer, outcome) => {
      const t = setup()
      for (let i = 0; i < 5; i++) {
        await queued(t.repo, `old${i}`, 1000 + i, true)
        await t.repo.markNeedsReupload('c1', `old${i}`)
      }
      t.downloader.reupload = async () => answer
      t.worker.kick()
      await t.worker.idle()
      expect(t.downloader.reuploads).toHaveLength(5)
      expect(t.outcomes.filter((o) => o === outcome)).toHaveLength(5)
      if (outcome === 'failed') {
        for (let i = 0; i < 5; i++)
          expect(state(t.repo, `old${i}`)).toMatchObject({ status: 'failed', error: 'expired' })
      }
    },
  )

  it('the number of attempts of the default is the one documented', () => {
    expect(MAX_REUPLOAD_ATTEMPTS).toBe(4)
    expect(REUPLOAD_MIN_INTERVAL_MS).toBe(2_000)
  })
})

describe('a full media folder and the backlog of untranscribed audios', () => {
  it('a full folder (media-cap, unavailable) is no failure: the descriptor stays, nothing is counted, and it resumes after a kick', async () => {
    const t = setup({ concurrency: 2 })
    for (let i = 0; i < 3; i++) await queued(t.repo, `a${i}`, 1000 + i)
    let full = true
    t.downloader.answer = async (item) =>
      full ? err({ kind: 'unavailable', reason: 'media-cap' }) : ok(`${item.messageId}.ogg`)
    t.worker.kick()
    await t.worker.idle()
    expect(t.outcomes.every((o) => o === 'unavailable')).toBe(true)
    expect(await t.repo.countDownloads()).toBe(3)
    for (const id of ['a0', 'a1', 'a2']) {
      expect(state(t.repo, id)).toMatchObject({ status: 'download_pending', attempts: 0 })
      expect(state(t.repo, id)?.descriptor).not.toBeNull()
    }
    // the folder frees up (a transcription deleted its file): the owner kicks the pool and everything is downloaded
    full = false
    t.worker.kick()
    await t.worker.idle()
    expect(await t.repo.countDownloads()).toBe(0)
    expect(await t.repo.countPending()).toBe(3)
  })

  it('claims nothing while the downloaded audios waiting for whisper reach the bound, and goes on when they drop', async () => {
    let waiting = 4
    const t = setup({ concurrency: 2, awaiting: async () => waiting, maxAwaiting: 4 })
    for (let i = 0; i < 3; i++) await queued(t.repo, `a${i}`, 1000 + i)
    t.worker.kick()
    await t.worker.idle()
    expect(t.downloader.started).toEqual([])
    expect(await t.repo.countDownloads()).toBe(3)
    waiting = 3
    t.worker.kick()
    await t.worker.idle()
    expect(t.downloader.started).toHaveLength(3)
    expect(await t.repo.countDownloads()).toBe(0)
  })
})
