import { afterEach, describe, expect, it, vi } from 'vitest'
import { failureCode } from '../../../src/application/generate-digest.js'
import type { SummarizeResult } from '../../../src/application/ports/summarizer.js'
import { composeSummarizer } from '../../../src/infrastructure/llm/index.js'
import { inTransaction } from '../../../src/infrastructure/persistence/sqlite/transaction.js'
import { runMain } from '../../../src/main/app.js'
import { Daemon } from '../../../src/main/daemon.js'
import { runDigest } from '../../../src/main/run-digest.js'
import type { Runtime } from '../../../src/main/runtime.js'
import {
  disposeHarnesses,
  FakeSummarizer,
  type Harness,
  ME,
  makeHarness,
  NOW,
  SUMMARY,
  seedMessages,
} from '../../support/cli-harness.js'

afterEach(() => {
  vi.useRealTimers()
  disposeHarnesses()
})

const ANA = '9911963367943@s.whatsapp.net'
const BETO = '9912465397241@s.whatsapp.net'
const SECRET = '9912752183123@s.whatsapp.net'
const TEXT = 'PRIVATE-CHAT-TEXT: the plan for friday'

const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const answer = (provider: string): SummarizeResult => ({ ok: true, value: SUMMARY, provider })

async function seed(h: Harness, chats: readonly [id: string, name: string][] = [[ANA, 'Ana Test']]): Promise<void> {
  const runtime = h.runtime()
  try {
    await seedMessages(
      runtime,
      chats.map(([id, name]) => ({ id: `m-${id}`, text: TEXT, conversationId: id, conversationName: name })),
    )
  } finally {
    runtime.close()
  }
}

function runsOf(h: Harness) {
  const runtime = h.runtime()
  try {
    return runtime.runs.list(50, 0).items
  } finally {
    runtime.close()
  }
}

describe('the history records every digest run (RF-74)', () => {
  it('records a committed `msum digest` with the provider counts, the failed conversations and its digest', async () => {
    const h = await makeHarness()
    await seed(h, [
      [ANA, 'Ana Test'],
      [BETO, 'Beto Test'],
      [SECRET, 'Carla Test'],
    ])
    let calls = 0
    Object.assign(h.ctx, {
      summarizer: new FakeSummarizer(() => {
        calls++
        if (calls === 3) return { ok: false, error: 'claude timed out after 180s' }
        return answer(calls === 1 ? 'claude-cli' : 'ollama')
      }),
    })
    expect(await run(h, 'digest')).toBe(0)
    const [only, ...rest] = runsOf(h)
    expect(rest).toEqual([])
    expect(only).toMatchObject({
      trigger: 'cli',
      startedAt: NOW,
      finishedAt: NOW,
      outcome: 'committed',
      error: null,
      summarized: 2,
      failed: 1,
      providers: { 'claude-cli': 1, ollama: 1 },
      since: expect.any(Number),
      until: NOW,
    })
    expect(only?.failedConversations).toHaveLength(1)
    expect(only?.failedConversations[0]).toMatchObject({ reason: 'timeout' })
    expect(only?.digestId).not.toBeNull()
    const runtime = h.runtime()
    try {
      expect(runtime.store.history()).toHaveLength(1)
      expect(runtime.runs.digest(only?.digestId as number)?.text).toContain('Ana Test')
    } finally {
      runtime.close()
    }
  })

  it('takes the duration from the injected clock', async () => {
    const h = await makeHarness()
    await seed(h)
    const clock = h.ctx.clock as unknown as { time: number }
    Object.assign(h.ctx, {
      summarizer: new FakeSummarizer(() => {
        clock.time += 7_000
        return answer('claude-cli')
      }),
    })
    await run(h, 'digest')
    const [recorded] = runsOf(h)
    expect(recorded?.startedAt).toBe(NOW)
    expect(recorded?.finishedAt).toBe(NOW + 7_000)
  })

  it('records an empty window as `empty`, with no digest', async () => {
    const h = await makeHarness()
    expect(await run(h, 'digest')).toBe(0)
    expect(runsOf(h)).toEqual([
      expect.objectContaining({ trigger: 'cli', outcome: 'empty', summarized: 0, failed: 0, digestId: null }),
    ])
  })

  it('does not record a preview', async () => {
    const h = await makeHarness()
    await seed(h)
    expect(await run(h, 'digest', '--dry-run')).toBe(0)
    expect(runsOf(h)).toEqual([])
  })

  it('records noProvider as a failed run with its code', async () => {
    const h = await makeHarness({ summarizer: null })
    expect(await run(h, 'digest')).toBe(2)
    expect(runsOf(h)).toEqual([
      expect.objectContaining({ outcome: 'failed', error: 'noProvider', finishedAt: NOW, digestId: null }),
    ])
  })

  it('records an unreadable promptFile as failed', async () => {
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: 'claude-cli' }, promptFile: 'nope.txt' },
    })
    expect(await run(h, 'digest')).toBe(2)
    expect(runsOf(h)[0]).toMatchObject({ outcome: 'failed', error: 'promptFile' })
  })

  it('records an invalid window as failed', async () => {
    const h = await makeHarness()
    expect(await run(h, 'digest', '--from', '2026-11-17 12:00', '--to', '2026-11-17 11:00')).toBe(2)
    expect(runsOf(h)[0]).toMatchObject({ outcome: 'failed', error: 'invalidWindow' })
  })

  it('records a digest another run finished first as failed concurrentRun, leaving no digest', async () => {
    const h = await makeHarness()
    await seed(h)
    Object.assign(h.ctx, {
      summarizer: new FakeSummarizer(async () => {
        const other = h.runtime()
        await other.store.commit({ previousPointer: null, pointer: 5, digest: null, parts: [] })
        other.close()
        return answer('claude-cli')
      }),
    })
    expect(await run(h, 'digest')).toBe(1)
    const [recorded] = runsOf(h)
    expect(recorded).toMatchObject({ outcome: 'failed', error: 'concurrentRun', digestId: null, summarized: 0 })
    const runtime = h.runtime()
    try {
      expect(runtime.store.history()).toEqual([])
    } finally {
      runtime.close()
    }
  })

  it('records an exception as failed with the code `failed`, and lets it go on', async () => {
    const h = await makeHarness()
    const runtime = h.runtime()
    try {
      const broken = {
        ...runtime,
        generateDigest: async () => {
          throw new Error('boom')
        },
      } as Runtime
      await expect(runDigest(broken, { preview: false, trigger: 'manual' })).rejects.toThrow('boom')
      expect(runtime.runs.list(10, 0).items).toEqual([
        expect.objectContaining({ trigger: 'manual', outcome: 'failed', error: 'failed' }),
      ])
    } finally {
      runtime.close()
    }
  })

  it('counts providers through the real wrappers: the backup, and local only never reaching the external ones', async () => {
    const h = await makeHarness()
    await seed(h, [
      [ANA, 'Ana Test'],
      [BETO, 'Beto Test'],
      [SECRET, 'Secret Carla'],
    ])
    const primary = new FakeSummarizer((): SummarizeResult => ({ ok: false, error: 'down' }))
    const primaryOnly = new FakeSummarizer(() => answer('claude-cli'))
    let primaryCalls = 0
    const external = {
      summarize: async (request: Parameters<FakeSummarizer['summarize']>[0]) => {
        primaryCalls++
        // Ana is summarized by the primary, Beto fails there.
        return request.conversation.name === 'Beto Test' ? primary.summarize(request) : primaryOnly.summarize(request)
      },
    }
    const backup = new FakeSummarizer(() => answer('ollama'))
    const local = new FakeSummarizer(() => answer('ollama'))
    Object.assign(h.ctx, {
      summarizer: composeSummarizer({ primary: external, backup, local, localOnlyPatterns: ['secret'] }),
    })
    expect(await run(h, 'digest')).toBe(0)
    expect(runsOf(h)[0]).toMatchObject({ summarized: 3, failed: 0, providers: { 'claude-cli': 1, ollama: 2 } })
    // the local-only chat only ever went to the local provider
    expect(primaryCalls).toBe(2)
    expect(local.requests.map((r) => r.conversation.name)).toEqual(['Secret Carla'])
    expect(backup.requests.map((r) => r.conversation.name)).toEqual(['Beto Test'])
  })

  it('counts a summarizer that names no provider as unknown', async () => {
    const h = await makeHarness()
    await seed(h)
    await run(h, 'digest')
    expect(runsOf(h)[0]?.providers).toEqual({ unknown: 1 })
  })

  it('keeps the reason as a code, never the text of the provider', async () => {
    const h = await makeHarness()
    await seed(h)
    Object.assign(h.ctx, {
      summarizer: new FakeSummarizer(() => ({ ok: false, error: `claude: ${TEXT}` })),
    })
    await run(h, 'digest')
    const [recorded] = runsOf(h)
    expect(recorded?.failedConversations).toEqual([{ id: ANA, name: 'Ana Test', reason: 'failed' }])
    const runtime = h.runtime()
    try {
      const raw = runtime.db.prepare('SELECT * FROM digest_runs').all()
      expect(JSON.stringify(raw)).not.toContain('PRIVATE-CHAT-TEXT')
    } finally {
      runtime.close()
    }
  })
})

describe('the daemon records its runs (RF-74)', () => {
  async function start(): Promise<{ h: Harness; runtime: Runtime; daemon: Daemon }> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(Date.parse('2026-11-17T15:00:00Z'))
    const h = await makeHarness({ summarizer: new FakeSummarizer(() => answer('claude-cli')), liveClock: true })
    const runtime = h.runtime()
    runtime.identity.bind(ME)
    const daemon = new Daemon({ runtime, connection: h.connection, logger: h.ctx.logger })
    await daemon.start()
    return { h, runtime, daemon }
  }

  it('records the scheduled, missed and manual triggers, an empty one and a failed one', async () => {
    const { h, runtime, daemon } = await start()
    try {
      await seedMessages(runtime, [{ id: 'm1', text: TEXT, timestamp: Date.now() - 3_600_000 }])
      expect(await daemon.runScheduledDigest('schedule')).toBe('ran')
      // nothing new: an empty window
      vi.setSystemTime(Date.now() + 60_000)
      expect(await daemon.runScheduledDigest('missed')).toBe('ran')
      const event = await daemon.runDigestNow('manual').catch(() => null)
      // not settled (never connected): the manual run waits for the catch-up and records nothing yet
      expect(event).toEqual({ state: 'deferred' })
      const rows = runtime.runs.list(10, 0).items
      expect(rows.map((r) => [r.trigger, r.outcome])).toEqual([
        ['missed', 'empty'],
        ['schedule', 'committed'],
      ])
      expect(rows[1]).toMatchObject({ summarized: 1, providers: { 'claude-cli': 1 } })
      expect(h.logs.join('\n')).not.toContain('PRIVATE-CHAT-TEXT')
    } finally {
      await daemon.stop()
      runtime.close()
    }
  })

  it('records a manual run once the connection settled', async () => {
    const { h, runtime, daemon } = await start()
    try {
      await seedMessages(runtime, [{ id: 'm1', text: TEXT, timestamp: Date.now() - 3_600_000 }])
      h.connection.emit({ state: 'connected' })
      await vi.advanceTimersByTimeAsync(61_000)
      expect(await daemon.runDigestNow('manual')).toMatchObject({ state: 'done' })
      expect(runtime.runs.list(10, 0).items[0]).toMatchObject({ trigger: 'manual', outcome: 'committed' })
    } finally {
      await daemon.stop()
      runtime.close()
    }
  })

  it('on start, closes the runs a crash left open as failed `interrupted`, and leaves the finished ones', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(Date.parse('2026-11-17T15:00:00Z'))
    const h = await makeHarness({ liveClock: true })
    const runtime = h.runtime()
    runtime.identity.bind(ME)
    const now = Date.now()
    const dead = runtime.runs.start('schedule', now - 120_000)
    const finished = runtime.runs.start('manual', now - 100_000)
    runtime.runs.fail(finished, now - 99_000, 'noProvider')
    // `msum digest` may be running in another process right now: a recent open row of it is not touched
    const cliNow = runtime.runs.start('cli', now - 5_000)
    const cliOld = runtime.runs.start('cli', now - 2 * 3_600_000)
    const daemon = new Daemon({ runtime, connection: h.connection, logger: h.ctx.logger })
    try {
      await daemon.start()
      const byId = new Map(runtime.runs.list(10, 0).items.map((r) => [r.id, r]))
      expect(byId.get(dead)).toMatchObject({ outcome: 'failed', error: 'interrupted', finishedAt: now })
      expect(byId.get(finished)).toMatchObject({ outcome: 'failed', error: 'noProvider' })
      expect(byId.get(cliNow)).toMatchObject({ outcome: null, finishedAt: null })
      expect(byId.get(cliOld)).toMatchObject({ outcome: 'failed', error: 'interrupted' })
      expect(h.logs.some((line) => line.includes('digest.interrupted'))).toBe(true)
    } finally {
      await daemon.stop()
      runtime.close()
    }
  })

  it('a promptFile failure under a schedule is recorded with its trigger', async () => {
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: 'claude-cli' }, promptFile: 'gone.txt' },
    })
    const runtime = h.runtime()
    try {
      const result = await runDigest(runtime, { preview: false, trigger: 'schedule' })
      expect(result.ok).toBe(false)
      expect(runtime.runs.list(10, 0).items[0]).toMatchObject({ trigger: 'schedule', error: 'promptFile' })
    } finally {
      runtime.close()
    }
  })
})

describe('failureCode', () => {
  it('reduces a free-text reason to a code that is safe to keep', () => {
    expect(failureCode('localOnlyUnavailable')).toBe('localOnlyUnavailable')
    expect(failureCode('claude timed out after 180s')).toBe('timeout')
    expect(failureCode('ollama timed out after 0.1s; fallback: down')).toBe('timeout')
    expect(failureCode('invalid summary: prioridad must be alta, media or baja')).toBe('invalidSummary')
    expect(failureCode('claude: Not logged in')).toBe('failed')
    expect(failureCode('  localOnlyUnavailable  ; fallback: x')).toBe('localOnlyUnavailable')
  })

  it('decides a chained reason by the FIRST failure, and matches markers, not words inside a provider text', () => {
    expect(failureCode('invalid summary: prioridad must be alta; fallback: ollama timed out after 5s')).toBe(
      'invalidSummary',
    )
    expect(failureCode('claude timed out after 180s; fallback: invalid summary: x')).toBe('timeout')
    expect(failureCode('claude: boom; fallback: ollama timed out after 5s')).toBe('failed')
    expect(failureCode('claude: the model timed out after a while')).toBe('failed')
    expect(failureCode('claude: this is not an invalid summary: really')).toBe('failed')
    expect(failureCode('claude: localOnlyUnavailable')).toBe('failed')
  })
})

describe('runs cut off or recorded elsewhere', () => {
  const HOUR = 3_600_000

  it('a late commit corrects a run that was called interrupted meanwhile, and keeps the digest in the history', async () => {
    const h = await makeHarness()
    await seed(h)
    const clock = h.ctx.clock as unknown as { time: number }
    Object.assign(h.ctx, {
      summarizer: new FakeSummarizer(() => {
        // another process (a daemon look) sees this run open for over an hour and closes it
        clock.time += 2 * HOUR
        const other = h.runtime()
        try {
          expect(other.runs.markStale(clock.time, HOUR)).toBe(1)
        } finally {
          other.close()
        }
        return answer('claude-cli')
      }),
    })
    expect(await run(h, 'digest')).toBe(0)
    const [only, ...rest] = runsOf(h)
    expect(rest).toEqual([])
    expect(only).toMatchObject({ outcome: 'committed', error: null, summarized: 1 })
    expect(only?.digestId).not.toBeNull()
  })

  it('refuses to close a run that is not open: the commit rolls back whole', async () => {
    const h = await makeHarness()
    const runtime = h.runtime()
    try {
      const id = runtime.runs.start('cli', NOW)
      runtime.runs.fail(id, NOW, 'noProvider')
      const completion = {
        runId: id,
        finishedAt: NOW,
        since: 1,
        until: 2,
        summarized: 1,
        failed: 0,
        providers: {},
        failedConversations: [],
      }
      await expect(
        runtime.store.commit({
          previousPointer: null,
          pointer: 9,
          digest: { since: 1, until: 2, createdAt: NOW, text: 't', summarized: 1, failed: 0 },
          parts: ['p'],
          run: completion,
        }),
      ).rejects.toThrow('cannot be closed')
      expect(await runtime.store.getPointer()).toBeNull()
      expect(runtime.store.history()).toEqual([])
      expect(runtime.store.outbox()).toEqual([])
    } finally {
      runtime.close()
    }
  })

  it('a rollback after the run was closed inside the commit leaves the run open', async () => {
    const h = await makeHarness()
    const runtime = h.runtime()
    try {
      const id = runtime.runs.start('manual', NOW)
      const outer = () =>
        inTransaction(runtime.db, () => {
          void runtime.store.commit({
            previousPointer: null,
            pointer: 9,
            digest: { since: 1, until: 2, createdAt: NOW, text: 't', summarized: 1, failed: 0 },
            parts: ['p'],
            run: {
              runId: id,
              finishedAt: NOW,
              since: 1,
              until: 2,
              summarized: 1,
              failed: 0,
              providers: {},
              failedConversations: [],
            },
          })
          throw new Error('later step failed')
        })
      expect(outer).toThrow('later step failed')
      expect(runtime.runs.get(id)).toMatchObject({ outcome: null, finishedAt: null, digestId: null })
      expect(runtime.store.history()).toEqual([])
    } finally {
      runtime.close()
    }
  })

  it('a run of `msum digest` closes the stale runs of any process first, and leaves recent ones', async () => {
    const h = await makeHarness()
    const runtime = h.runtime()
    const old = runtime.runs.start('schedule', NOW - 2 * HOUR)
    const recent = runtime.runs.start('manual', NOW - 60_000)
    runtime.close()
    expect(await run(h, 'digest')).toBe(0)
    const rows = new Map(runsOf(h).map((r) => [r.id, r]))
    expect(rows.get(old)).toMatchObject({ outcome: 'failed', error: 'interrupted' })
    expect(rows.get(recent)).toMatchObject({ outcome: null })
  })

  it('deleting a digest leaves its run, without the digest', async () => {
    const h = await makeHarness()
    await seed(h)
    await run(h, 'digest')
    const runtime = h.runtime()
    try {
      runtime.db.exec('DELETE FROM outbox')
      runtime.db.exec('DELETE FROM digests')
      expect(runtime.runs.list(5, 0).items[0]).toMatchObject({ outcome: 'committed', digestId: null })
    } finally {
      runtime.close()
    }
  })
})
