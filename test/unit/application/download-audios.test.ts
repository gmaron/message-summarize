import { describe, expect, it } from 'vitest'
import { createDownloadAudios, type DownloadOutcome } from '../../../src/application/download-audios.js'
import type {
  AudioDownloader,
  DownloadFailure,
  PendingDownload,
} from '../../../src/application/ports/download-queue.js'
import { err, ok, type Result } from '../../../src/domain/result.js'
import { InMemoryCaptureRepository } from '../../support/capture-fakes.js'
import { message } from '../domain/factories.js'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** An audio whose download is queued (what the capture does). */
async function queued(repo: InMemoryCaptureRepository, id: string, timestamp: number): Promise<void> {
  await repo.insertMessage(message({ id, kind: 'audio', text: '[audio]', timestamp }))
  await repo.queueDownload('c1', id, {
    directPath: `/v/${id}`,
    mediaKey: new Uint8Array(32).fill(1),
    mimetype: 'audio/ogg',
    fileLength: 10,
  })
}

/** A downloader the test controls. By default every download works and gives `<id>.ogg`. */
class FakeDownloader implements AudioDownloader {
  readonly started: string[] = []
  inFlight = 0
  maxInFlight = 0
  aborted = 0
  answer: (item: PendingDownload) => Promise<Result<string, DownloadFailure>> = async (item) =>
    ok(`${item.messageId}.ogg`)

  async download(item: PendingDownload): Promise<Result<string, DownloadFailure>> {
    this.started.push(item.messageId)
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      return await this.answer(item)
    } finally {
      this.inFlight--
    }
  }

  abort(): void {
    this.aborted++
  }
}

function setup(options: { maxAttempts?: number; repo?: InMemoryCaptureRepository } = {}) {
  const repo = options.repo ?? new InMemoryCaptureRepository()
  const downloader = new FakeDownloader()
  const outcomes: DownloadOutcome[] = []
  let downloaded = 0
  const clock = { time: 1_000_000, now: () => clock.time }
  const worker = createDownloadAudios({
    queue: repo,
    downloader,
    clock,
    wait: async () => {},
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    onDownloaded: () => {
      downloaded++
    },
    onOutcome: (outcome) => outcomes.push(outcome),
  })
  return { repo, downloader, worker, outcomes, clock, downloaded: () => downloaded }
}

/** Runs the worker once and waits for it. */
async function run(t: ReturnType<typeof setup>): Promise<void> {
  t.worker.kick()
  await t.worker.idle()
}

const state = (repo: InMemoryCaptureRepository, id: string) => repo.media.get(JSON.stringify(['c1', id]))

describe('the download worker over the durable queue (RF-15, RNF-08)', () => {
  it('downloads every queued audio, OLDEST first, and each one joins the transcription queue', async () => {
    const t = setup()
    await queued(t.repo, 'late', 3000)
    await queued(t.repo, 'early', 1000)
    await queued(t.repo, 'middle', 2000)
    t.worker.kick()
    await t.worker.idle()
    expect(t.downloader.started).toEqual(['early', 'middle', 'late'])
    expect(state(t.repo, 'early')).toMatchObject({ status: 'pending', ref: 'early.ogg', descriptor: null })
    expect(await t.repo.countDownloads()).toBe(0)
    expect(await t.repo.countPending()).toBe(3)
    expect(t.outcomes).toEqual(['downloaded', 'downloaded', 'downloaded'])
    expect(t.downloaded()).toBe(3)
  })

  it('300 history audios are ALL downloaded eventually, one at a time (a first link can bring hundreds)', async () => {
    const t = setup()
    for (let i = 0; i < 300; i++) await queued(t.repo, `h${String(i).padStart(3, '0')}`, 1000 + i)
    t.downloader.answer = async (item) => {
      await flush() // each download takes a turn of the event loop: any overlap would show
      return ok(`${item.messageId}.ogg`)
    }
    t.worker.kick()
    await t.worker.idle()
    expect(t.downloader.started).toHaveLength(300)
    expect(t.downloader.started[0]).toBe('h000')
    expect(t.downloader.started[299]).toBe('h299')
    expect(t.downloader.maxInFlight).toBe(1)
    expect(await t.repo.countDownloads()).toBe(0)
    expect(await t.repo.countPending()).toBe(300)
    expect(t.downloaded()).toBe(300)
  })

  it('a restart in the middle of the queue resumes where it stopped: nothing is lost and nothing is done twice', async () => {
    const repo = new InMemoryCaptureRepository()
    for (let i = 0; i < 10; i++) await queued(repo, `a${i}`, 1000 + i)

    // The first process downloads four and is stopped (a restart).
    const first = setup({ repo })
    let done = 0
    let stopping: Promise<void> = Promise.resolve()
    first.downloader.answer = async (item) => {
      if (done === 4) {
        stopping = first.worker.stop() // stopped while the fifth is in the air
        return err({ kind: 'unavailable', reason: 'aborted' })
      }
      done++
      return ok(`${item.messageId}.ogg`)
    }
    first.worker.kick()
    await first.worker.idle()
    await stopping
    expect(first.downloader.started).toEqual(['a0', 'a1', 'a2', 'a3', 'a4'])
    expect(await repo.countDownloads()).toBe(6) // a4 is still queued, with its attempts untouched
    expect(state(repo, 'a4')).toMatchObject({ status: 'download_pending', attempts: 0 })

    // The second process (the same database) finishes the rest, starting with the one that was in the air.
    const second = setup({ repo })
    second.worker.kick()
    await second.worker.idle()
    expect(second.downloader.started).toEqual(['a4', 'a5', 'a6', 'a7', 'a8', 'a9'])
    expect(await repo.countDownloads()).toBe(0)
    expect(await repo.countPending()).toBe(10)
  })

  it('an abort keeps the audio queued, uncounted, and the next run completes it', async () => {
    const t = setup()
    await queued(t.repo, 'a', 1000)
    let abort = true
    t.downloader.answer = async (item) =>
      abort ? err({ kind: 'unavailable', reason: 'aborted' }) : ok(`${item.messageId}.ogg`)
    t.worker.kick()
    await t.worker.idle()
    expect(state(t.repo, 'a')).toMatchObject({ status: 'download_pending', attempts: 0 })
    expect(t.outcomes).toEqual(['unavailable'])
    abort = false
    t.worker.kick()
    await t.worker.idle()
    expect(state(t.repo, 'a')).toMatchObject({ status: 'pending', ref: 'a.ogg' })
  })

  it('with no connection the run ends at once, nothing is counted, and the audios wait', async () => {
    const t = setup()
    await queued(t.repo, 'a', 1000)
    await queued(t.repo, 'b', 2000)
    t.downloader.answer = async () => err({ kind: 'unavailable', reason: 'not-connected' })
    t.worker.kick()
    await t.worker.idle()
    expect(t.downloader.started).toEqual(['a']) // it did not spin through the queue
    expect(await t.repo.countDownloads()).toBe(2)
    expect(state(t.repo, 'a')?.attempts).toBe(0)
  })

  it('a permanent failure is recorded with its code, never retried, and the next audio goes on', async () => {
    const t = setup()
    await queued(t.repo, 'old', 1000)
    await queued(t.repo, 'ok', 2000)
    t.downloader.answer = async (item) =>
      item.messageId === 'old' ? err({ kind: 'permanent', reason: 'expired' }) : ok(`${item.messageId}.ogg`)
    t.worker.kick()
    await t.worker.idle()
    expect(state(t.repo, 'old')).toMatchObject({ status: 'failed', error: 'expired', descriptor: null })
    expect(state(t.repo, 'ok')?.status).toBe('pending')
    expect(t.downloader.started).toEqual(['old', 'ok'])
    expect(t.outcomes).toEqual(['failed', 'downloaded'])
  })

  it('a transient failure keeps the audio queued with one more attempt, and the audio behind it goes on', async () => {
    const t = setup()
    await queued(t.repo, 'a', 1000)
    await queued(t.repo, 'b', 2000)
    t.downloader.answer = async (item) =>
      item.messageId === 'a' ? err({ kind: 'transient', reason: 'timeout' }) : ok(`${item.messageId}.ogg`)
    await run(t)
    expect(t.downloader.started).toEqual(['a', 'b'])
    expect(state(t.repo, 'a')).toMatchObject({ status: 'download_pending', attempts: 1 })
    expect(state(t.repo, 'b')?.status).toBe('pending')
    expect(t.outcomes).toEqual(['retry', 'downloaded'])
  })

  it('a burst of kicks during a network blip does not use up the attempts', async () => {
    const t = setup()
    await queued(t.repo, 'a', 1000)
    t.downloader.answer = async () => err({ kind: 'transient', reason: 'timeout' })
    for (let i = 0; i < 20; i++) await run(t)
    expect(t.downloader.started).toEqual(['a'])
    expect(state(t.repo, 'a')).toMatchObject({ status: 'download_pending', attempts: 1 })
  })

  it('attempts are spaced 30 s, 1 min, 2 min and 4 min apart, and the fifth failure is final', async () => {
    const t = setup()
    await queued(t.repo, 'a', 1000)
    t.downloader.answer = async () => err({ kind: 'transient', reason: 'timeout' })
    const attemptTimes: number[] = []
    const start = t.clock.time
    for (const wait of [0, 30_000, 60_000, 120_000, 240_000]) {
      t.clock.time = (attemptTimes.at(-1) ?? start) + wait
      // one millisecond early: not due yet
      if (wait > 0) {
        t.clock.time -= 1
        await run(t)
        expect(t.downloader.started).toHaveLength(attemptTimes.length)
        t.clock.time += 1
      }
      await run(t)
      attemptTimes.push(t.clock.time)
    }
    expect(t.downloader.started).toHaveLength(5)
    expect(attemptTimes.map((time) => time - start)).toEqual([0, 30_000, 90_000, 210_000, 450_000])
    expect(state(t.repo, 'a')).toMatchObject({ status: 'failed', error: 'download-failed', descriptor: null })
    expect(t.outcomes).toEqual(['retry', 'retry', 'retry', 'retry', 'failed'])
  })

  it('a row that is not due cannot be retried by a kick', async () => {
    const t = setup()
    await queued(t.repo, 'a', 1000)
    t.downloader.answer = async () => err({ kind: 'transient', reason: 'timeout' })
    await run(t)
    t.clock.time += 29_999
    await run(t)
    expect(t.downloader.started).toEqual(['a'])
    t.clock.time += 1
    await run(t)
    expect(t.downloader.started).toEqual(['a', 'a'])
  })

  it('after N transient failures the audio becomes failed (download-failed) and the queue moves on', async () => {
    const t = setup({ maxAttempts: 3 })
    await queued(t.repo, 'a', 1000)
    await queued(t.repo, 'b', 2000)
    t.downloader.answer = async (item) =>
      item.messageId === 'a' ? err({ kind: 'transient', reason: 'timeout' }) : ok(`${item.messageId}.ogg`)
    for (let i = 0; i < 3; i++) {
      await run(t)
      t.clock.time += 10 * 60_000
    }
    expect(state(t.repo, 'a')).toMatchObject({ status: 'failed', error: 'download-failed', descriptor: null })
    expect(t.outcomes.filter((outcome) => outcome !== 'downloaded')).toEqual(['retry', 'retry', 'failed'])
    expect(state(t.repo, 'b')?.status).toBe('pending')
  })

  it('five transient failures is the default limit', async () => {
    const t = setup()
    await queued(t.repo, 'a', 1000)
    t.downloader.answer = async () => err({ kind: 'transient', reason: 'download-failed' })
    for (let i = 0; i < 5; i++) {
      expect(state(t.repo, 'a')?.status).toBe('download_pending')
      await run(t)
      t.clock.time += 10 * 60_000
    }
    expect(state(t.repo, 'a')?.status).toBe('failed')
  })

  it('the descriptor (the decryption key) is cleared when the file is stored', async () => {
    const t = setup()
    await queued(t.repo, 'a', 1000)
    expect(state(t.repo, 'a')?.descriptor).not.toBeNull()
    t.worker.kick()
    await t.worker.idle()
    expect(state(t.repo, 'a')?.descriptor).toBeNull()
  })

  it('a kick during a run makes it look once more: an audio queued at the end is not left behind', async () => {
    const t = setup()
    await queued(t.repo, 'a', 1000)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    t.downloader.answer = async (item) => {
      if (item.messageId === 'a') await held
      return ok(`${item.messageId}.ogg`)
    }
    t.worker.kick()
    await flush()
    await queued(t.repo, 'b', 2000)
    t.worker.kick()
    release()
    await t.worker.idle()
    expect(await t.repo.countDownloads()).toBe(0)
  })

  it('a kick that arrives while the run is finding nothing is not lost', async () => {
    const t = setup()
    await queued(t.repo, 'a', 1000)
    const lookUp = t.repo.nextDownload.bind(t.repo)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let looks = 0
    t.repo.nextDownload = async (now: number) => {
      const found = await lookUp(now)
      looks++
      if (looks === 2) await held // the second look finds nothing, and the answer is held on its way back
      return found
    }
    t.worker.kick()
    await flush()
    await queued(t.repo, 'b', 2000)
    t.worker.kick()
    release()
    await t.worker.idle()
    expect(t.downloader.started).toEqual(['a', 'b'])
  })

  it('works without anyone listening to its outcomes', async () => {
    const repo = new InMemoryCaptureRepository()
    const downloader = new FakeDownloader()
    const worker = createDownloadAudios({
      queue: repo,
      downloader,
      clock: { now: () => 1_000_000 },
      wait: async () => {},
    })
    await queued(repo, 'a', 1000)
    worker.kick()
    await worker.idle()
    expect(await repo.countDownloads()).toBe(0)
    expect(downloader.started).toEqual(['a'])
  })

  it('does nothing when the queue is empty', async () => {
    const t = setup()
    t.worker.kick()
    await t.worker.idle()
    expect(t.downloader.started).toEqual([])
    expect(t.outcomes).toEqual([])
  })

  it('a store that fails does not break the run: it ends and says so', async () => {
    const t = setup()
    await queued(t.repo, 'a', 1000)
    t.repo.claimDownload = async () => {
      throw new Error('database is closed')
    }
    t.worker.kick()
    await t.worker.idle()
    expect(t.outcomes).toEqual(['error'])
  })

  describe('stopping', () => {
    it('aborts the download in progress, leaves its audio queued and resolves when the worker is idle', async () => {
      const t = setup()
      await queued(t.repo, 'a', 1000)
      await queued(t.repo, 'b', 2000)
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      t.downloader.answer = async () => {
        await held
        return err({ kind: 'unavailable', reason: 'aborted' })
      }
      t.worker.kick()
      await flush()
      const stopping = t.worker.stop()
      await flush()
      expect(t.downloader.aborted).toBe(1)
      release()
      await stopping
      expect(t.downloader.started).toEqual(['a']) // b never began
      expect(await t.repo.countDownloads()).toBe(2)
      expect(state(t.repo, 'a')?.attempts).toBe(0)
      expect(t.outcomes).toEqual(['unavailable'])
    })

    it('a file that was stored while stopping is still recorded: it is never left with no record', async () => {
      const t = setup()
      await queued(t.repo, 'a', 1000)
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      t.downloader.answer = async (item) => {
        await held
        return ok(`${item.messageId}.ogg`)
      }
      t.worker.kick()
      await flush()
      const stopping = t.worker.stop()
      release()
      await stopping
      expect(state(t.repo, 'a')).toMatchObject({ status: 'pending', ref: 'a.ogg' })
    })

    it('a failure that arrives while stopping is not recorded (it says nothing about the audio)', async () => {
      const t = setup()
      await queued(t.repo, 'a', 1000)
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      t.downloader.answer = async () => {
        await held
        return err({ kind: 'permanent', reason: 'too-large' })
      }
      t.worker.kick()
      await flush()
      const stopping = t.worker.stop()
      release()
      await stopping
      expect(state(t.repo, 'a')?.status).toBe('download_pending')
    })

    it('an audio that finishes while stopping is recorded, and the next one is not started', async () => {
      const t = setup()
      await queued(t.repo, 'a', 1000)
      await queued(t.repo, 'b', 2000)
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      t.downloader.answer = async (item) => {
        await held
        return ok(`${item.messageId}.ogg`)
      }
      t.worker.kick()
      await flush()
      const stopping = t.worker.stop()
      release()
      await stopping
      expect(t.downloader.started).toEqual(['a'])
      expect(state(t.repo, 'a')?.status).toBe('pending')
      expect(await t.repo.countDownloads()).toBe(1)
    })

    it('does nothing after stop', async () => {
      const t = setup()
      await queued(t.repo, 'a', 1000)
      await t.worker.stop()
      t.worker.kick()
      await t.worker.idle()
      expect(t.downloader.started).toEqual([])
    })
  })
})
