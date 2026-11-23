import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTranscriptionSlot } from '../../../src/application/transcription-slot.js'
import { err, ok } from '../../../src/domain/result.js'
import { runMain } from '../../../src/main/app.js'
import { parseConfig } from '../../../src/main/config.js'
import { acquireDaemonLock } from '../../../src/main/daemon-lock.js'
import { createRuntime, type Runtime } from '../../../src/main/runtime.js'
import { BA, disposeHarnesses, type Harness, makeHarness, NOW } from '../../support/cli-harness.js'
import { FakeTranscriber } from '../../support/transcription-fakes.js'

const ANA = '9911963367943@s.whatsapp.net'
const DAY = 86_400_000

const runtimes: Runtime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    try {
      runtime.close()
    } catch {
      // closed by the test
    }
  }
  disposeHarnesses()
})

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function openRuntime(
  h: Harness,
  id: string,
  options: {
    transcription?: Record<string, unknown>
    transcriber?: FakeTranscriber | null
    slot?: ReturnType<typeof createTranscriptionSlot>
  } = {},
): Runtime {
  const parsed = parseConfig(
    {
      language: 'en',
      timezone: BA,
      provider: { primary: 'claude-cli' },
      transcription: { enabled: true, ...options.transcription },
    },
    BA,
  )
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
  const runtime = createRuntime({
    layout: h.accountOf(id),
    config: parsed.value,
    env: {},
    clock: h.clock,
    summarizer: null,
    ...(options.transcriber === undefined ? {} : { transcriber: options.transcriber }),
    ...(options.slot === undefined ? {} : { transcriptionSlot: options.slot }),
  })
  runtimes.push(runtime)
  return runtime
}

/** A voice note whose file is downloaded and queued (through the repository, so nothing wakes the queue). */
async function queueAudio(h: Harness, runtime: Runtime, id: string, minutesAgo = 60): Promise<string> {
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
  const dir = runtime.layout.mediaDir
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${id}.ogg`)
  writeFileSync(file, 'audio bytes')
  await runtime.repository.setMedia(ANA, id, `${id}.ogg`)
  void h
  return file
}

const transcriptOf = (runtime: Runtime, id: string): string | null =>
  (runtime.db.prepare('SELECT transcript FROM messages WHERE id = ?').get(id) as { transcript: string | null })
    .transcript

describe('msum digest and the daemon: who transcribes (RNF-09, RF-15, RF-64)', () => {
  const setup = async () => {
    const transcriber = new FakeTranscriber()
    transcriber.answer = async () => ok('hola desde el audio')
    const h = await makeHarness({ config: { language: 'en', timezone: BA, provider: { primary: 'claude-cli' } } })
    Object.assign(h.ctx, { transcriber, transcriptionTiming: { waitMs: 500, pollMs: 20 } })
    const seeding = openRuntime(h, 'default', { transcriber: null })
    await queueAudio(h, seeding, 'a1')
    seeding.close()
    runtimes.splice(runtimes.indexOf(seeding), 1)
    return { h, transcriber }
  }
  const sent = (h: Harness) => h.summarizer.requests.map((r) => r.transcript).join('\n')
  const state = async (h: Harness) => {
    const runtime = h.runtime()
    try {
      return {
        pointer: await runtime.store.getPointer(),
        history: runtime.store.history().length,
        outbox: (await runtime.outbox.pending()).length,
        transcript: transcriptOf(runtime, 'a1'),
        status: (
          runtime.db.prepare('SELECT transcribe_status AS s FROM messages WHERE id = ?').get('a1') as { s: string }
        ).s,
      }
    } finally {
      runtime.close()
    }
  }

  it('with no daemon, the command transcribes the audios of its window itself', async () => {
    const { h, transcriber } = await setup()
    expect(await run(h, 'digest')).toBe(0)
    expect(transcriber.calls).toHaveLength(1)
    expect(sent(h)).toContain('🎤 (audio) hola desde el audio')
    expect(await state(h)).toMatchObject({ transcript: 'hola desde el audio', status: 'done' })
  })

  it('--dry-run transcribes too: a transcript is captured data, so RF-64 still holds (no pointer, no history, no outbox)', async () => {
    const { h, transcriber } = await setup()
    expect(await run(h, 'digest', '--dry-run')).toBe(0)
    expect(transcriber.calls).toHaveLength(1)
    expect(sent(h)).toContain('🎤 (audio) hola desde el audio')
    expect(await state(h)).toEqual({
      pointer: null,
      history: 0,
      outbox: 0,
      transcript: 'hola desde el audio',
      status: 'done',
    })
  })

  it('with a live daemon, the command does not transcribe: it waits, for a bounded time, for the daemon', async () => {
    const { h, transcriber } = await setup()
    const lock = await acquireDaemonLock(h.layout.lockFile, process.pid)
    expect(lock.ok).toBe(true)
    const started = Date.now()
    expect(await run(h, 'digest', '--dry-run')).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(400) // it waited the bounded time...
    expect(Date.now() - started).toBeLessThan(5_000) // ...and not more
    expect(transcriber.calls).toEqual([]) // it never ran the transcriber
    expect(sent(h)).toContain('🎤 (audio not transcribed)')
    expect(await state(h)).toMatchObject({ transcript: null, status: 'pending' })
    if (lock.ok) await lock.release()
  })

  it('with a live daemon, it uses what the daemon transcribes while it waits (and stops waiting as soon as it is there)', async () => {
    const { h, transcriber } = await setup()
    Object.assign(h.ctx, { transcriptionTiming: { waitMs: 20_000, pollMs: 20 } }) // a long limit: it must not be needed
    const lock = await acquireDaemonLock(h.layout.lockFile, process.pid)
    // the daemon (another process, here another connection to the same database) finishes the audio
    setTimeout(() => {
      const daemon = h.runtime()
      daemon.db
        .prepare("UPDATE messages SET transcript = 'lo dijo el daemon', transcribe_status = 'done' WHERE id = 'a1'")
        .run()
      daemon.close()
    }, 100)
    const started = Date.now()
    expect(await run(h, 'digest', '--dry-run')).toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(transcriber.calls).toEqual([])
    expect(sent(h)).toContain('🎤 (audio) lo dijo el daemon')
    if (lock.ok) await lock.release()
  })

  it('a daemon that starts while the command is transcribing takes over: no second audio is transcribed by the command', async () => {
    const { h, transcriber } = await setup()
    const seeding = openRuntime(h, 'default', { transcriber: null })
    await queueAudio(h, seeding, 'a2', 30)
    seeding.close()
    runtimes.splice(runtimes.indexOf(seeding), 1)
    let lock: Awaited<ReturnType<typeof acquireDaemonLock>> | null = null
    transcriber.answer = async () => {
      // the daemon starts (takes the lock of the installation) while the first audio is being transcribed
      lock = await acquireDaemonLock(h.layout.lockFile, process.pid)
      return ok('hola desde el audio')
    }
    const started = Date.now()
    expect(await run(h, 'digest', '--dry-run')).toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000) // it waited at most the bounded time (500 ms), not more
    expect(transcriber.calls).toHaveLength(1) // the second audio was left to the daemon
    const runtime = h.runtime()
    try {
      expect(transcriptOf(runtime, 'a1')).toBe('hola desde el audio')
      expect(transcriptOf(runtime, 'a2')).toBeNull()
    } finally {
      runtime.close()
    }
    const taken = lock as Awaited<ReturnType<typeof acquireDaemonLock>> | null
    if (taken?.ok) await taken.release()
  })

  it('a daemon lock that is stale (its process is gone) does not count: the command transcribes itself', async () => {
    const { h, transcriber } = await setup()
    // a lock file of a pid that does not exist
    writeFileSync(h.layout.lockFile, `${JSON.stringify({ pid: 2_147_483_000, host: '' })}\n`)
    expect(await run(h, 'digest', '--dry-run')).toBe(0)
    expect(transcriber.calls).toHaveLength(1)
  })
})

describe('ONE whisper at a time in the whole process, whatever the number of accounts (RNF-09)', () => {
  it('the runtimes of two accounts share the slot of the process by default', async () => {
    const h = await makeHarness({ accounts: ['one', 'two'] })
    let running = 0
    let most = 0
    const slow = async () => {
      running++
      most = Math.max(most, running)
      await flush()
      await flush()
      running--
      return ok('text')
    }
    const first = new FakeTranscriber()
    const second = new FakeTranscriber()
    first.answer = slow
    second.answer = slow
    const a = openRuntime(h, 'one', { transcriber: first })
    const b = openRuntime(h, 'two', { transcriber: second })
    for (const [runtime, id] of [
      [a, 'x1'],
      [a, 'x2'],
      [b, 'y1'],
      [b, 'y2'],
    ] as const) {
      await queueAudio(h, runtime, id)
    }
    a.transcription.kick()
    b.transcription.kick()
    await Promise.all([a.transcription.idle(), b.transcription.idle()])
    expect(first.calls).toHaveLength(2)
    expect(second.calls).toHaveLength(2)
    expect(most).toBe(1)
  })
})

describe('the audio file goes once its transcription is over (RF-15)', () => {
  it('after the transcript is stored, and after a failure for good; not while it can be tried again', async () => {
    const h = await makeHarness()
    const transcriber = new FakeTranscriber()
    const runtime = openRuntime(h, 'default', { transcriber })
    // The newest is transcribed first, so the one that cannot be done now is the oldest: the others are done before it.
    const good = await queueAudio(h, runtime, 'good', 30)
    const bad = await queueAudio(h, runtime, 'bad', 40)
    const later = await queueAudio(h, runtime, 'later', 50)
    transcriber.answer = async (r) =>
      r.audioPath.includes('bad')
        ? err({ kind: 'failed', reason: 'unsupported-format' })
        : r.audioPath.includes('later')
          ? err({ kind: 'unavailable', reason: 'whisper-missing' })
          : ok('transcript')
    runtime.transcription.kick()
    await runtime.transcription.idle()
    expect(existsSync(good)).toBe(false) // transcribed: the text is what is kept
    expect(existsSync(bad)).toBe(false) // failed for good
    expect(existsSync(later)).toBe(true) // unavailable: it will be tried again
    expect(transcriptOf(runtime, 'good')).toBe('transcript')
  })
})

describe('the audios of the history of the last N days (RF-15)', () => {
  const hint = async (historyAudioDays: number | undefined, daysOld: number, origin: 'live' | 'history') => {
    const h = await makeHarness()
    const runtime = openRuntime(h, 'default', {
      transcriber: new FakeTranscriber(),
      transcription: historyAudioDays === undefined ? {} : { historyAudioDays },
    })
    const outcome = await runtime.capture.receiveMessage({
      origin,
      isGroup: false,
      message: {
        id: `m-${daysOld}`,
        conversationId: ANA,
        senderId: ANA,
        senderName: null,
        senderAddress: '+9911963367943',
        fromMe: false,
        timestamp: NOW - daysOld * DAY,
        kind: 'audio',
        text: '[audio]',
        transcript: null,
        read: false,
      },
    })
    return outcome.downloadAudio
  }

  it('is 14 days by default: the history audio of 13 days is wanted and of 15 is not', async () => {
    expect(await hint(undefined, 13, 'history')).toBe(true)
    expect(await hint(undefined, 15, 'history')).toBe(false)
  })

  it('follows transcription.historyAudioDays', async () => {
    expect(await hint(3, 2, 'history')).toBe(true)
    expect(await hint(3, 4, 'history')).toBe(false)
    expect(await hint(60, 59, 'history')).toBe(true)
  })

  it('transcription.historyAudioDays 0 wants the whole history', async () => {
    expect(await hint(0, 3000, 'history')).toBe(true)
  })

  it('a live audio is always wanted, however old its timestamp says it is', async () => {
    expect(await hint(3, 400, 'live')).toBe(true)
  })
})

describe('transcription.concurrency over the real queue (SQLite)', () => {
  it('runs up to `concurrency` whisper processes at once and every audio is done once, newest first', async () => {
    const transcriber = new FakeTranscriber()
    transcriber.answer = async () => {
      await flush()
      await flush()
      return ok('hola')
    }
    const h = await makeHarness({ config: { language: 'en', timezone: BA, provider: { primary: 'claude-cli' } } })
    const runtime = openRuntime(h, 'default', {
      transcriber,
      transcription: { concurrency: 4 },
      slot: createTranscriptionSlot(),
    })
    const files: string[] = []
    for (let i = 0; i < 12; i++) files.push(await queueAudio(h, runtime, `a${String(i).padStart(2, '0')}`, 100 - i))
    runtime.transcription.kick()
    await runtime.transcription.idle()
    expect(transcriber.maxInFlight).toBe(4)
    expect(new Set(transcriber.calls.map((c) => c.audioPath)).size).toBe(12)
    // minutesAgo goes down as i goes up: a11 is the newest, and the first one taken.
    expect(transcriber.calls[0]?.audioPath.endsWith('a11.ogg')).toBe(true)
    expect(files.every((file) => !existsSync(file))).toBe(true) // the text is what is kept
    expect(runtime.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE transcribe_status = 'done'").get()).toEqual({
      n: 12,
    })
  })

  it('a restart resumes: what was in progress when the process died is transcribed by the next one', async () => {
    const h = await makeHarness({ config: { language: 'en', timezone: BA, provider: { primary: 'claude-cli' } } })
    const first = openRuntime(h, 'default', { transcriber: null })
    await queueAudio(h, first, 'a', 10)
    await queueAudio(h, first, 'b', 20)
    // The first process claimed both and died with them in progress.
    first.db.prepare('UPDATE messages SET transcribe_claimed_at = 1').run()
    first.close()
    const transcriber = new FakeTranscriber()
    transcriber.answer = async () => ok('resumed')
    const second = openRuntime(h, 'default', { transcriber, slot: createTranscriptionSlot() })
    second.transcription.kick()
    await second.transcription.idle()
    expect(transcriber.calls).toHaveLength(0) // in progress for somebody: not handed out
    expect(await second.transcription.recover()).toBe(2)
    second.transcription.kick()
    await second.transcription.idle()
    expect(transcriptOf(second, 'a')).toBe('resumed')
    expect(transcriptOf(second, 'b')).toBe('resumed')
  })

  it('raises the limit of the process slot to the concurrency of the account', async () => {
    const slot = createTranscriptionSlot()
    const h = await makeHarness({ config: { language: 'en', timezone: BA, provider: { primary: 'claude-cli' } } })
    openRuntime(h, 'default', { transcriber: null, transcription: { concurrency: 5 }, slot })
    expect(slot.limit).toBe(5)
    openRuntime(h, 'default', { transcriber: null, transcription: { concurrency: 2 }, slot })
    expect(slot.limit).toBe(5)
  })
})
