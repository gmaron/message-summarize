import { describe, expect, it } from 'vitest'
import type { TranscribeFailure } from '../../../src/application/ports/transcriber.js'
import { createTranscribeAudios, type TranscriptionOutcome } from '../../../src/application/transcribe-audios.js'
import { createTranscriptionSlot, type TranscriptionSlot } from '../../../src/application/transcription-slot.js'
import { err, ok, type Result } from '../../../src/domain/result.js'
import { InMemoryCaptureRepository } from '../../support/capture-fakes.js'
import { FakeTranscriber, manualDeadlines } from '../../support/transcription-fakes.js'
import { message } from '../domain/factories.js'

/** A gate a test opens by hand, to hold a transcription in the air. */
function gate(): { wait: Promise<void>; open(): void } {
  let open: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** An audio that was downloaded: stored and queued. */
async function audio(repo: InMemoryCaptureRepository, id: string, timestamp: number, conversationId = 'c1') {
  await repo.insertMessage(message({ id, conversationId, kind: 'audio', text: '[audio]', timestamp }))
  await repo.setMedia(conversationId, id, `${id}.ogg`)
}

const transcriptOf = async (repo: InMemoryCaptureRepository, id: string): Promise<string | null | undefined> =>
  (await repo.source.messagesInWindow('c1', { since: 0, until: 1e12 })).find((m) => m.id === id)?.transcript

/** `off`: the use case is built with no transcriber (transcription off); the fake is still returned, to show it was not used. */
function setup(
  options: {
    off?: boolean
    slot?: TranscriptionSlot
    repo?: InMemoryCaptureRepository
    mustObserve?: () => Promise<boolean>
    /** Default 1000. `null`: not given to the use case. */
    observePollMs?: number | null
  } = {},
) {
  const transcriber = new FakeTranscriber()
  const repo = options.repo ?? new InMemoryCaptureRepository()
  const deadlines = manualDeadlines()
  const outcomes: TranscriptionOutcome[] = []
  const deleted: string[] = []
  const transcription = createTranscribeAudios({
    store: repo,
    transcriber: options.off === true ? null : transcriber,
    language: 'es',
    mediaPath: (ref) => `/media/${ref}`,
    startDeadline: deadlines.start,
    onOutcome: (outcome) => outcomes.push(outcome),
    deleteMedia: async (ref) => {
      deleted.push(ref)
    },
    ...(options.observePollMs === null ? {} : { observePollMs: options.observePollMs ?? 1_000 }),
    ...(options.mustObserve === undefined ? {} : { mustObserve: options.mustObserve }),
    ...(options.slot === undefined ? {} : { slot: options.slot }),
  })
  return { repo, transcriber, transcription, deadlines, outcomes, deleted }
}

describe('the background queue (RF-15)', () => {
  it('transcribes every pending audio, NEWEST first, and stops when none is left', async () => {
    const t = setup()
    await audio(t.repo, 'late', 3000)
    await audio(t.repo, 'early', 1000)
    await audio(t.repo, 'middle', 2000)
    t.transcriber.answer = async (r) => ok(`text of ${r.audioPath}`)
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.transcriber.calls.map((c) => c.audioPath)).toEqual([
      '/media/late.ogg',
      '/media/middle.ogg',
      '/media/early.ogg',
    ])
    expect(await transcriptOf(t.repo, 'early')).toBe('text of /media/early.ogg')
    expect(await transcriptOf(t.repo, 'late')).toBe('text of /media/late.ogg')
    expect(await t.repo.countPending()).toBe(0)
    expect(t.outcomes).toEqual(['transcribed', 'transcribed', 'transcribed'])
  })

  it('passes the configured language and the path of the file', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    t.transcriber.files['/media/a.ogg'] = 'hello'
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.transcriber.calls).toEqual([{ audioPath: '/media/a.ogg', language: 'es' }])
  })

  it('does ONE audio at a time (RNF-09), however many kicks and digests ask', async () => {
    const t = setup()
    for (let i = 1; i <= 4; i++) await audio(t.repo, `a${i}`, i * 1000)
    const hold = gate()
    t.transcriber.answer = async (r) => {
      await hold.wait
      return ok(`t ${r.audioPath}`)
    }
    t.transcription.kick()
    t.transcription.kick()
    const preparing = t.transcription.prepareWindow({ from: 0, until: 10_000 }, 60_000)
    t.transcription.kick()
    await flush()
    expect(t.transcriber.inFlight).toBe(1)
    hold.open()
    await preparing
    await t.transcription.idle()
    expect(t.transcriber.maxInFlight).toBe(1)
    expect(t.transcriber.calls).toHaveLength(4)
    expect(await t.repo.countPending()).toBe(0)
  })

  it('a kick while it is running makes it look again: an audio that arrives at the end is not left behind', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    const hold = gate()
    t.transcriber.answer = async (r) => {
      await hold.wait
      return ok(r.audioPath)
    }
    t.transcription.kick()
    await flush()
    await audio(t.repo, 'b', 2000)
    t.transcription.kick()
    hold.open()
    await t.transcription.idle()
    expect(await t.repo.countPending()).toBe(0)
    expect(await transcriptOf(t.repo, 'b')).toBe('/media/b.ogg')
  })

  it('a kick that arrives while the queue is finding nothing is not lost', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    t.transcriber.answer = async (r) => ok(r.audioPath)
    const lookUp = t.repo.nextPending.bind(t.repo)
    const hold = gate()
    let looks = 0
    t.repo.nextPending = async (range) => {
      const found = await lookUp(range)
      looks++
      if (looks === 2) await hold.wait // the second look finds nothing, and the answer is held on its way back
      return found
    }
    t.transcription.kick()
    await flush()
    await audio(t.repo, 'b', 2000)
    t.transcription.kick()
    hold.open()
    await t.transcription.idle()
    expect(await transcriptOf(t.repo, 'b')).toBe('/media/b.ogg')
  })

  it('does nothing when no audio waits', async () => {
    const t = setup()
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.transcriber.calls).toEqual([])
    expect(t.outcomes).toEqual([])
  })

  it('records a failure for good and goes on with the next audio', async () => {
    const t = setup()
    await audio(t.repo, 'bad', 2000)
    await audio(t.repo, 'good', 1000)
    t.transcriber.answer = async (r): Promise<Result<string, TranscribeFailure>> =>
      r.audioPath.includes('bad') ? err({ kind: 'failed', reason: 'ffmpeg exited with code 1' }) : ok('fine')
    t.transcription.kick()
    await t.transcription.idle()
    expect(await transcriptOf(t.repo, 'bad')).toBeNull()
    expect(await transcriptOf(t.repo, 'good')).toBe('fine')
    expect(t.repo.media.get(JSON.stringify(['c1', 'bad']))).toMatchObject({
      status: 'failed',
      error: 'ffmpeg exited with code 1',
    })
    expect(await t.repo.countPending()).toBe(0)
    expect(t.outcomes).toEqual(['failed', 'transcribed'])
  })

  it('a timeout is a failure of that audio, recorded as such', async () => {
    const t = setup()
    await audio(t.repo, 'slow', 1000)
    t.transcriber.answer = async () => err({ kind: 'timeout' })
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.repo.media.get(JSON.stringify(['c1', 'slow']))).toMatchObject({ status: 'failed', error: 'timeout' })
    expect(t.outcomes).toEqual(['timeout'])
  })
})

describe('when the transcriber is not available (RF-21)', () => {
  it('stops at once and keeps every audio pending, to try again on the next kick', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    await audio(t.repo, 'b', 2000)
    let ready = false
    t.transcriber.answer = async (r) =>
      ready ? ok(`ok ${r.audioPath}`) : err({ kind: 'unavailable', reason: 'whisper-missing' })
    t.transcription.kick()
    await t.transcription.idle()
    // Only the first was tried: no spinning through the queue.
    expect(t.transcriber.calls).toHaveLength(1)
    expect(await t.repo.countPending()).toBe(2)
    expect(await transcriptOf(t.repo, 'a')).toBeNull()
    expect(t.outcomes).toEqual(['unavailable'])

    ready = true // whisper was installed meanwhile
    t.transcription.kick()
    await t.transcription.idle()
    expect(await t.repo.countPending()).toBe(0)
    expect(await transcriptOf(t.repo, 'a')).toBe('ok /media/a.ogg')
  })

  it('with no transcriber (transcription off) nothing is queued, waited for or run', async () => {
    const t = setup({ off: true })
    await audio(t.repo, 'a', 1000)
    expect(t.transcription.enabled).toBe(false)
    t.transcription.kick()
    await t.transcription.idle()
    expect(await t.transcription.prepareWindow({ from: 0, until: 10_000 }, 60_000)).toEqual({
      handled: 0,
      remaining: 0,
    })
    expect(t.deadlines.started).toEqual([]) // it did not even start waiting
    expect(await transcriptOf(t.repo, 'a')).toBeNull()
    expect(await t.repo.countPending()).toBe(1)
  })

  it('a store that fails does not break the loop or leak an error', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    t.repo.claimPending = async () => {
      throw new Error('database is closed')
    }
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.outcomes).toEqual(['error'])
  })
})

describe('right before a digest: the audios of its window, with a bounded wait (RF-15)', () => {
  it('transcribes the pending audios of the window first, and only those', async () => {
    const t = setup()
    await audio(t.repo, 'before', 500)
    await audio(t.repo, 'in-1', 1000)
    await audio(t.repo, 'in-2', 2000)
    await audio(t.repo, 'after', 9000)
    t.transcriber.answer = async (r) => ok(r.audioPath)
    const report = await t.transcription.prepareWindow({ from: 1000, until: 3000 }, 60_000)
    expect(report).toEqual({ handled: 2, remaining: 0 })
    expect(t.transcriber.calls.map((c) => c.audioPath)).toEqual(['/media/in-1.ogg', '/media/in-2.ogg'])
    expect(await transcriptOf(t.repo, 'in-1')).toBe('/media/in-1.ogg')
    // The others wait for the background queue.
    expect(await transcriptOf(t.repo, 'before')).toBeNull()
    expect(await t.repo.countPending()).toBe(2)
    expect(t.deadlines.started).toEqual([60_000])
    expect(t.deadlines.cancelled()).toBe(1)
  })

  it('has nothing to wait for when no audio of the window is pending', async () => {
    const t = setup()
    await audio(t.repo, 'later', 9000)
    expect(await t.transcription.prepareWindow({ from: 0, until: 3000 }, 60_000)).toEqual({ handled: 0, remaining: 0 })
    expect(t.transcriber.calls).toEqual([])
  })

  it('gives up waiting at the deadline: what is left stays pending, and the digest goes on', async () => {
    const t = setup()
    await audio(t.repo, 'slow', 1000)
    await audio(t.repo, 'next', 2000)
    const hold = gate()
    t.transcriber.answer = async (r) => {
      await hold.wait
      return ok(r.audioPath)
    }
    const preparing = t.transcription.prepareWindow({ from: 0, until: 10_000 }, 5_000)
    await flush()
    t.deadlines.expire()
    // It returns even though the audio in the air has not finished.
    expect(await preparing).toEqual({ handled: 0, remaining: 2 })
    // The audio in the air finishes later and is kept; the next one is NOT started by the expired wait.
    hold.open()
    await flush()
    await flush()
    expect(await transcriptOf(t.repo, 'slow')).toBe('/media/slow.ogg')
    expect(t.transcriber.calls.map((c) => c.audioPath)).toEqual(['/media/slow.ogg'])
    expect(await transcriptOf(t.repo, 'next')).toBeNull()
    expect(await t.repo.countPending()).toBe(1)
    expect(t.transcriber.maxInFlight).toBe(1)
  })

  it('a queue that cannot be counted at the end is an error and counts as nothing left', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    t.transcriber.answer = async (r) => ok(r.audioPath)
    const count = t.repo.countPending.bind(t.repo)
    t.repo.countPending = async (range) => {
      if (t.outcomes.includes('transcribed')) throw new Error('database is closed')
      return count(range)
    }
    expect(await t.transcription.prepareWindow({ from: 0, until: 10_000 }, 60_000)).toEqual({
      handled: 1,
      remaining: 0,
    })
    expect(t.outcomes).toEqual(['transcribed', 'error'])
  })

  it('stops waiting when the transcriber is unavailable, without the full wait', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    t.transcriber.answer = async () => err({ kind: 'unavailable', reason: 'model-missing' })
    expect(await t.transcription.prepareWindow({ from: 0, until: 10_000 }, 60_000)).toEqual({
      handled: 0,
      remaining: 1,
    })
  })

  it('the same audio is never transcribed twice when the background queue and a digest meet', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    await audio(t.repo, 'b', 2000)
    t.transcriber.answer = async (r) => ok(r.audioPath)
    t.transcription.kick()
    await t.transcription.prepareWindow({ from: 0, until: 10_000 }, 60_000)
    await t.transcription.idle()
    expect(t.transcriber.calls.map((c) => c.audioPath).sort()).toEqual(['/media/a.ogg', '/media/b.ogg'])
  })
})

describe('stopping', () => {
  it('closes the transcriber, and an audio that was in the air stays pending (it was not its failure)', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    const hold = gate()
    t.transcriber.answer = async () => {
      await hold.wait
      return err({ kind: 'unavailable', reason: 'closed' })
    }
    t.transcription.kick()
    await flush()
    const stopping = t.transcription.stop()
    await flush()
    expect(t.transcriber.closeCalls).toBe(1)
    hold.open()
    await stopping
    expect(await t.repo.countPending()).toBe(1)
    expect(t.repo.media.get(JSON.stringify(['c1', 'a']))?.status).toBe('pending')
    expect(t.outcomes).toEqual([])
  })

  it('does not settle while an audio is still in the air', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    const hold = gate()
    t.transcriber.answer = async () => {
      await hold.wait
      return ok('late')
    }
    t.transcription.kick()
    await flush()
    let settled = false
    const stopping = t.transcription.stop().then(() => {
      settled = true
    })
    await flush()
    await flush()
    expect(settled).toBe(false)
    hold.open()
    await stopping
    expect(settled).toBe(true)
  })

  it('settles with a transcriber that has no close, and with transcription off', async () => {
    const bare = createTranscribeAudios({
      store: new InMemoryCaptureRepository(),
      transcriber: { transcribe: async () => ok('x') },
      language: 'es',
      mediaPath: (ref) => ref,
      startDeadline: manualDeadlines().start,
    })
    await expect(bare.stop()).resolves.toBeUndefined()
    await expect(setup({ off: true }).transcription.stop()).resolves.toBeUndefined()
  })

  it('a result that arrives after stop is discarded, even a good one', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    const hold = gate()
    t.transcriber.answer = async () => {
      await hold.wait
      return ok('too late')
    }
    t.transcription.kick()
    await flush()
    const stopping = t.transcription.stop()
    hold.open()
    await stopping
    expect(await transcriptOf(t.repo, 'a')).toBeNull()
  })

  it('does nothing after stop', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    await t.transcription.stop()
    t.transcription.kick()
    await t.transcription.idle()
    expect(await t.transcription.prepareWindow({ from: 0, until: 10_000 }, 1_000)).toEqual({ handled: 0, remaining: 0 })
    expect(t.transcriber.calls).toEqual([])
  })
})

describe('what is kept is the text: the audio file goes once its transcription is over (RF-15)', () => {
  it('deletes the file after the transcript is stored', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    t.transcriber.answer = async () => ok('text')
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.deleted).toEqual(['a.ogg'])
  })

  it('deletes the file of an audio that failed for good, and of one that timed out', async () => {
    const t = setup()
    await audio(t.repo, 'bad', 2000)
    await audio(t.repo, 'slow', 1000)
    t.transcriber.answer = async (r) =>
      r.audioPath.includes('bad') ? err({ kind: 'failed', reason: 'unsupported-format' }) : err({ kind: 'timeout' })
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.deleted).toEqual(['bad.ogg', 'slow.ogg'])
  })

  it('keeps the file while the audio can still be tried again: unavailable, or stopped half way', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    t.transcriber.answer = async () => err({ kind: 'unavailable', reason: 'whisper-missing' })
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.deleted).toEqual([])
    const stopped = setup()
    await audio(stopped.repo, 'b', 1000)
    const hold = gate()
    stopped.transcriber.answer = async () => {
      await hold.wait
      return ok('too late')
    }
    stopped.transcription.kick()
    await flush()
    const stopping = stopped.transcription.stop()
    hold.open()
    await stopping
    expect(stopped.deleted).toEqual([])
  })

  it('only the process that stored the transcript deletes the file: one that lost the race leaves it', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    t.transcriber.answer = async () => {
      // another process finishes this audio while ours is still working on it
      await t.repo.complete('c1', 'a', 'theirs')
      return ok('ours')
    }
    t.transcription.kick()
    await t.transcription.idle()
    expect(await transcriptOf(t.repo, 'a')).toBe('theirs')
    expect(t.deleted).toEqual([])
  })

  it('a file that cannot be deleted is not a failure of the transcription', async () => {
    const repo = new InMemoryCaptureRepository()
    const transcriber = new FakeTranscriber()
    transcriber.answer = async () => ok('text')
    const outcomes: TranscriptionOutcome[] = []
    const transcription = createTranscribeAudios({
      store: repo,
      transcriber,
      language: 'es',
      mediaPath: (ref) => ref,
      startDeadline: manualDeadlines().start,
      deleteMedia: async () => {
        throw new Error('EACCES')
      },
      onOutcome: (outcome) => outcomes.push(outcome),
    })
    await audio(repo, 'a', 1000)
    transcription.kick()
    await transcription.idle()
    expect(await transcriptOf(repo, 'a')).toBe('text')
    expect(outcomes).toEqual(['transcribed'])
  })
})

describe('ONE transcription slot for the whole process (RNF-09)', () => {
  it('two accounts that share a slot never run two transcriptions at once', async () => {
    const slot = createTranscriptionSlot()
    const a = setup({ slot })
    const b = setup({ slot })
    for (const t of [a, b]) {
      await audio(t.repo, 'x1', 1000)
      await audio(t.repo, 'x2', 2000)
    }
    let running = 0
    let most = 0
    const answer = async (r: { audioPath: string }) => {
      running++
      most = Math.max(most, running)
      await flush()
      running--
      return ok(r.audioPath)
    }
    a.transcriber.answer = answer
    b.transcriber.answer = answer
    a.transcription.kick()
    b.transcription.kick()
    await Promise.all([a.transcription.idle(), b.transcription.idle()])
    expect(most).toBe(1)
    expect(a.transcriber.calls).toHaveLength(2)
    expect(b.transcriber.calls).toHaveLength(2)
  })

  it('without a shared slot each one has its own: they may overlap (this is what the process-wide slot prevents)', async () => {
    const a = setup()
    const b = setup()
    await audio(a.repo, 'x', 1000)
    await audio(b.repo, 'x', 1000)
    let running = 0
    let most = 0
    const answer = async () => {
      running++
      most = Math.max(most, running)
      await flush()
      running--
      return ok('t')
    }
    a.transcriber.answer = answer
    b.transcriber.answer = answer
    a.transcription.kick()
    b.transcription.kick()
    await Promise.all([a.transcription.idle(), b.transcription.idle()])
    expect(most).toBe(2)
  })

  it('an audio whose turn in the slot comes after the deadline is not started', async () => {
    const slot = createTranscriptionSlot()
    const t = setup({ slot })
    await audio(t.repo, 'a', 1000)
    const hold = gate()
    const other = slot.run(() => hold.wait) // another account is transcribing
    const preparing = t.transcription.prepareWindow({ from: 0, until: 10_000 }, 5_000)
    await flush()
    t.deadlines.expire()
    expect(await preparing).toEqual({ handled: 0, remaining: 1 })
    hold.open()
    await other
    await flush()
    await flush()
    expect(t.transcriber.calls).toEqual([])
    expect(await t.repo.countPending()).toBe(1)
  })

  it('stopping one account waits for its own work, not for the other account that shares the slot', async () => {
    const slot = createTranscriptionSlot()
    const a = setup({ slot })
    const b = setup({ slot })
    await audio(a.repo, 'x', 1000)
    await audio(b.repo, 'x', 1000)
    const hold = gate()
    a.transcriber.answer = async () => {
      await hold.wait
      return ok('a')
    }
    b.transcriber.answer = async () => ok('b')
    a.transcription.kick()
    await flush()
    b.transcription.kick() // queued behind a's audio in the shared slot
    await flush()
    // b stops while a's audio is in the air: it must not wait for it
    await b.transcription.stop()
    hold.open()
    await a.transcription.idle()
    expect(await transcriptOf(a.repo, 'x')).toBe('a')
    expect(b.transcriber.calls).toEqual([])
  })
})

describe('a daemon that appears while a digest transcribes by itself (RNF-09)', () => {
  const RANGE = { from: 0, until: 10_000 }

  it('is looked for before EVERY audio: from then on this process only waits for the daemon', async () => {
    let daemon = false
    const asked: number[] = []
    const t = setup({
      mustObserve: async () => {
        asked.push(t.transcriber.calls.length)
        return daemon
      },
    })
    await audio(t.repo, 'a', 1000)
    await audio(t.repo, 'b', 2000)
    await audio(t.repo, 'c', 3000)
    t.transcriber.answer = async (r) => {
      daemon = true // the daemon starts while the first audio is being transcribed
      return ok(`text of ${r.audioPath}`)
    }
    const waiting = t.transcription.prepareWindow(RANGE, 60_000)
    await flush()
    await flush()
    // it did the first audio, then saw the daemon and did not start the second
    expect(t.transcriber.calls).toHaveLength(1)
    expect(asked).toEqual([0, 1])
    // the daemon does the rest meanwhile
    await t.repo.complete('c1', 'b', 'two')
    t.deadlines.expire(1_000)
    await flush()
    await t.repo.complete('c1', 'c', 'three')
    t.deadlines.expire(1_000)
    expect(await waiting).toEqual({ handled: 1, remaining: 0 })
    expect(t.transcriber.calls).toHaveLength(1)
  })

  it('waits only for the time that is left (one limit for the whole call), and what is not done stays pending', async () => {
    let daemon = false
    const t = setup({ mustObserve: async () => daemon })
    await audio(t.repo, 'a', 1000)
    await audio(t.repo, 'b', 2000)
    t.transcriber.answer = async () => {
      daemon = true
      return ok('text')
    }
    const waiting = t.transcription.prepareWindow(RANGE, 60_000)
    await flush()
    await flush()
    t.deadlines.expire() // the poll tick and the overall limit
    expect(await waiting).toEqual({ handled: 1, remaining: 1 })
    expect(t.transcriber.calls).toHaveLength(1)
    expect(t.deadlines.started.filter((ms) => ms === 60_000)).toHaveLength(1)
  })

  it('without a daemon it goes on by itself, asking each time', async () => {
    let asked = 0
    const t = setup({
      mustObserve: async () => {
        asked++
        return false
      },
    })
    await audio(t.repo, 'a', 1000)
    await audio(t.repo, 'b', 2000)
    expect(await t.transcription.prepareWindow(RANGE, 60_000)).toMatchObject({ handled: 2, remaining: 0 })
    expect(asked).toBeGreaterThanOrEqual(2)
    expect(t.transcriber.calls).toHaveLength(2)
  })

  it('a check that fails counts as no daemon: the digest is not held up', async () => {
    const t = setup({
      mustObserve: async () => {
        throw new Error('lock unreadable')
      },
    })
    await audio(t.repo, 'a', 1000)
    expect(await t.transcription.prepareWindow(RANGE, 60_000)).toMatchObject({ handled: 1, remaining: 0 })
  })
})

describe('a process that is not the daemon only observes (prepareWindow observeOnly)', () => {
  it('never runs the transcriber: it waits until the pending audios of the window are gone, looking now and then', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    await audio(t.repo, 'b', 2000)
    const waiting = t.transcription.prepareWindow({ from: 0, until: 10_000 }, 60_000, { observeOnly: true })
    await flush()
    // the daemon (another process) transcribes them meanwhile
    await t.repo.complete('c1', 'a', 'one')
    t.deadlines.expire(1_000) // a poll tick ends (not the overall limit): it looks again
    await flush()
    await t.repo.complete('c1', 'b', 'two')
    t.deadlines.expire(1_000)
    expect(await waiting).toEqual({ handled: 0, remaining: 0 })
    expect(t.transcriber.calls).toEqual([])
    expect(t.deleted).toEqual([])
    expect(t.deadlines.cancelled()).toBe(3) // the two poll ticks and the overall limit: no timer is left behind
  })

  it('gives up at the bounded time: what the daemon has not done stays pending', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    const waiting = t.transcription.prepareWindow({ from: 0, until: 10_000 }, 5_000, { observeOnly: true })
    await flush()
    t.deadlines.expire() // every wait ends at once: the poll tick and the overall limit
    expect(await waiting).toEqual({ handled: 0, remaining: 1 })
    expect(t.deadlines.started[0]).toBe(5_000)
    expect(t.transcriber.calls).toEqual([])
    expect(t.deadlines.cancelled()).toBe(2)
  })

  it('does not wait at all when nothing of the window is pending', async () => {
    const t = setup()
    await audio(t.repo, 'later', 99_000)
    expect(await t.transcription.prepareWindow({ from: 0, until: 10_000 }, 60_000, { observeOnly: true })).toEqual({
      handled: 0,
      remaining: 0,
    })
    expect(t.deadlines.started).toEqual([60_000]) // only the overall limit, never a poll tick
    expect(t.deadlines.cancelled()).toBe(1)
  })

  it('looks at the queue every second unless told otherwise, and every `observePollMs` when told', async () => {
    const byDefault = setup({ observePollMs: null })
    await audio(byDefault.repo, 'a', 1000)
    const first = byDefault.transcription.prepareWindow({ from: 0, until: 10_000 }, 60_000, { observeOnly: true })
    await flush()
    byDefault.deadlines.expire()
    await first
    expect(byDefault.deadlines.started).toEqual([60_000, 1_000])

    const custom = setup({ observePollMs: 250 })
    await audio(custom.repo, 'a', 1000)
    const second = custom.transcription.prepareWindow({ from: 0, until: 10_000 }, 60_000, { observeOnly: true })
    await flush()
    custom.deadlines.expire()
    await second
    expect(custom.deadlines.started).toEqual([60_000, 250])
  })

  it('a queue that cannot be read is an error, not an exception: it stops waiting and reports what it can', async () => {
    const t = setup()
    await audio(t.repo, 'a', 1000)
    t.repo.countPending = async () => {
      throw new Error('database is closed')
    }
    expect(await t.transcription.prepareWindow({ from: 0, until: 10_000 }, 60_000, { observeOnly: true })).toEqual({
      handled: 0,
      remaining: 0,
    })
    // once while waiting and once for the final count
    expect(t.outcomes).toEqual(['error', 'error'])
  })

  it('with transcription off it does not wait either', async () => {
    const t = setup({ off: true })
    await audio(t.repo, 'a', 1000)
    expect(await t.transcription.prepareWindow({ from: 0, until: 10_000 }, 60_000, { observeOnly: true })).toEqual({
      handled: 0,
      remaining: 0,
    })
    expect(t.deadlines.started).toEqual([])
  })
})
