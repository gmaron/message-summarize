import { describe, expect, it } from 'vitest'
import { createTranscribeAudios, type TranscriptionOutcome } from '../../../src/application/transcribe-audios.js'
import { createTranscriptionSlot } from '../../../src/application/transcription-slot.js'
import { createWorkerPool } from '../../../src/application/worker-pool.js'
import { err, ok } from '../../../src/domain/result.js'
import { InMemoryCaptureRepository } from '../../support/capture-fakes.js'
import { FakeTranscriber, manualDeadlines } from '../../support/transcription-fakes.js'
import { message } from '../domain/factories.js'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function audio(repo: InMemoryCaptureRepository, id: string, timestamp: number): Promise<void> {
  await repo.insertMessage(message({ id, conversationId: 'c1', kind: 'audio', text: '[audio]', timestamp }))
  await repo.setMedia('c1', id, `${id}.ogg`)
}

function setup(concurrency: number, repo = new InMemoryCaptureRepository()) {
  const transcriber = new FakeTranscriber()
  const outcomes: TranscriptionOutcome[] = []
  const transcription = createTranscribeAudios({
    store: repo,
    transcriber,
    language: 'es',
    mediaPath: (ref) => `/media/${ref}`,
    startDeadline: manualDeadlines().start,
    concurrency,
    onOutcome: (o) => outcomes.push(o),
  })
  return { repo, transcriber, transcription, outcomes }
}

describe('a pool of transcribers (transcription.concurrency)', () => {
  it('runs up to N at once, never more, and every audio is done exactly once', async () => {
    const t = setup(4)
    for (let i = 0; i < 25; i++) await audio(t.repo, `a${String(i).padStart(2, '0')}`, 1000 + i)
    t.transcriber.answer = async (r) => {
      await flush()
      await flush()
      return ok(`text of ${r.audioPath}`)
    }
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.transcriber.maxInFlight).toBe(4)
    expect(t.transcriber.calls).toHaveLength(25)
    expect(new Set(t.transcriber.calls.map((c) => c.audioPath)).size).toBe(25) // claim is exclusive: no audio twice
    expect(await t.repo.countPending()).toBe(0)
    expect(t.outcomes.filter((o) => o === 'transcribed')).toHaveLength(25)
  })

  it('takes the newest audios first', async () => {
    const t = setup(1)
    await audio(t.repo, 'old', 1000)
    await audio(t.repo, 'new', 3000)
    await audio(t.repo, 'mid', 2000)
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.transcriber.calls.map((c) => c.audioPath)).toEqual(['/media/new.ogg', '/media/mid.ogg', '/media/old.ogg'])
  })

  it('with the default (1) it is one at a time, as before', async () => {
    const repo = new InMemoryCaptureRepository()
    const transcriber = new FakeTranscriber()
    const transcription = createTranscribeAudios({
      store: repo,
      transcriber,
      language: 'es',
      mediaPath: (ref) => ref,
      startDeadline: manualDeadlines().start,
    })
    for (let i = 0; i < 5; i++) await audio(repo, `a${i}`, 1000 + i)
    transcriber.answer = async () => {
      await flush()
      return ok('t')
    }
    transcription.kick()
    await transcription.idle()
    expect(transcriber.maxInFlight).toBe(1)
  })

  it('never goes past N even when kicked again and again, and a digest window shares the same limit', async () => {
    const t = setup(3)
    for (let i = 0; i < 12; i++) await audio(t.repo, `a${i}`, 1000 + i)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    t.transcriber.answer = async () => {
      await held
      return ok('t')
    }
    for (let i = 0; i < 10; i++) t.transcription.kick()
    const preparing = t.transcription.prepareWindow({ from: 0, until: 100_000 }, 60_000)
    await flush()
    expect(t.transcriber.inFlight).toBe(3)
    release()
    await preparing
    await t.transcription.idle()
    expect(t.transcriber.maxInFlight).toBe(3)
    expect(t.transcriber.calls).toHaveLength(12)
    expect(await t.repo.countPending()).toBe(0)
  })

  it('an audio that arrives while some workers are idle is started at once, in parallel', async () => {
    const t = setup(3)
    await audio(t.repo, 'first', 1000)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    t.transcriber.answer = async (r) => {
      if (r.audioPath.includes('first')) await held
      return ok('t')
    }
    t.transcription.kick()
    await flush()
    await audio(t.repo, 'live', 2000)
    t.transcription.kick()
    await flush()
    expect(await t.repo.countPending()).toBe(1) // 'live' is done, 'first' is still being transcribed
    release()
    await t.transcription.idle()
    expect(await t.repo.countPending()).toBe(0)
  })

  it('an audio is in progress while it is transcribed: it is claimed, and given back if the transcriber is unavailable', async () => {
    const t = setup(2)
    await audio(t.repo, 'a', 1000)
    await audio(t.repo, 'b', 2000)
    t.transcriber.answer = async () => err({ kind: 'unavailable', reason: 'whisper-missing' })
    t.transcription.kick()
    await t.transcription.idle()
    expect((await t.repo.audioQueueStats()).running).toBe(0)
    expect(await t.repo.claimPending()).not.toBeNull() // pending again: claimable
    expect(t.outcomes).toContain('unavailable')
  })

  it('a restart resumes: audios that were in progress when the process died are pending again and get done', async () => {
    const repo = new InMemoryCaptureRepository()
    await audio(repo, 'a', 1000)
    await audio(repo, 'b', 2000)
    // The previous process claimed both and died.
    await repo.claimPending()
    await repo.claimPending()
    const t = setup(2, repo)
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.transcriber.calls).toHaveLength(0) // nobody takes what is in progress
    expect(await t.transcription.recover()).toBe(2)
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.transcriber.calls).toHaveLength(2)
    expect(await repo.countPending()).toBe(0)
  })

  it('stopping gives back what was in progress', async () => {
    const t = setup(3)
    for (let i = 0; i < 3; i++) await audio(t.repo, `a${i}`, 1000 + i)
    t.transcriber.answer = async () => {
      await t.transcriber.closedSignal
      return err({ kind: 'unavailable', reason: 'closed' })
    }
    t.transcription.kick()
    await flush()
    expect(t.transcriber.inFlight).toBe(3)
    await t.transcription.stop()
    expect((await t.repo.audioQueueStats()).running).toBe(0)
    expect(await t.repo.countPending()).toBe(3)
  })
})

describe('the transcription slot with a limit', () => {
  it('runs at most `limit` pieces of work at once and starts them in order', async () => {
    const slot = createTranscriptionSlot(2)
    let running = 0
    let max = 0
    const started: number[] = []
    const work = (n: number) => async (): Promise<number> => {
      started.push(n)
      running++
      max = Math.max(max, running)
      await flush()
      running--
      return n
    }
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => slot.run(work(n))))
    expect(results).toEqual([1, 2, 3, 4, 5, 6])
    expect(started).toEqual([1, 2, 3, 4, 5, 6])
    expect(max).toBe(2)
  })

  it('the default limit is 1, a failed piece of work does not block the next, and the limit can be raised', async () => {
    const slot = createTranscriptionSlot()
    expect(slot.limit).toBe(1)
    await expect(slot.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await slot.run(async () => 'next')).toBe('next')
    slot.setLimit(3)
    expect(slot.limit).toBe(3)
    let running = 0
    let max = 0
    await Promise.all(
      Array.from({ length: 6 }, () =>
        slot.run(async () => {
          running++
          max = Math.max(max, running)
          await flush()
          running--
        }),
      ),
    )
    expect(max).toBe(3)
  })

  it('two accounts that share a slot of 3 never run more than 3 transcriptions together', async () => {
    const slot = createTranscriptionSlot(3)
    const transcriber = new FakeTranscriber()
    transcriber.answer = async () => {
      await flush()
      return ok('t')
    }
    const accounts = await Promise.all(
      [0, 1].map(async () => {
        const repo = new InMemoryCaptureRepository()
        for (let i = 0; i < 8; i++) await audio(repo, `a${i}`, 1000 + i)
        const transcription = createTranscribeAudios({
          store: repo,
          transcriber,
          language: 'es',
          mediaPath: (ref) => ref,
          startDeadline: manualDeadlines().start,
          concurrency: 3,
          slot,
        })
        return { repo, transcription }
      }),
    )
    for (const a of accounts) a.transcription.kick()
    for (const a of accounts) await a.transcription.idle()
    expect(transcriber.maxInFlight).toBe(3)
    expect(transcriber.calls).toHaveLength(16)
  })
})

describe('the worker pool', () => {
  it('never runs more workers than its size, and a kick during a run makes it look again', async () => {
    let queue = 5
    let running = 0
    let max = 0
    let stopped = false
    const pool = createWorkerPool({
      size: 2,
      isStopped: () => stopped,
      step: async () => {
        if (queue === 0) return 'stop'
        queue--
        running++
        max = Math.max(max, running)
        await flush()
        running--
        return 'done'
      },
    })
    pool.kick()
    pool.kick()
    pool.kick()
    await flush()
    queue += 3 // work that arrives late
    pool.kick()
    await pool.idle()
    expect(queue).toBe(0)
    expect(max).toBe(2)
    expect(pool.busy).toBe(false)
    stopped = true
    queue = 3
    pool.kick()
    await pool.idle()
    expect(queue).toBe(3) // stopped: nothing started
  })
})
