import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../../../../src/domain/result.js'
import { acquireLinkLock } from '../../../../src/main/link/lock.js'
import { createRuntime, type Runtime } from '../../../../src/main/runtime.js'
import { type PreviewEvent, type PreviewHost, PreviewService } from '../../../../src/main/web/preview.js'
import {
  disposeHarnesses,
  FakeSummarizer,
  type Harness,
  makeHarness,
  SUMMARY,
  seedMessages,
  until,
} from '../../../support/cli-harness.js'

afterEach(() => disposeHarnesses())

const idle: PreviewHost = { runtimeOf: () => undefined, isClaimed: () => false, isStopping: false }

async function setup(
  options: { ttlMs?: number; host?: PreviewHost; gate?: Promise<void>; stamp?: () => string | null } = {},
) {
  const summarizer = new FakeSummarizer(async () => {
    await options.gate
    return ok(SUMMARY)
  })
  const h: Harness = await makeHarness({ summarizer, liveClock: true })
  const seeded = h.runtime()
  await seedMessages(seeded, [{ id: 'm1', text: 'hello Ana', timestamp: Date.now() - 3_600_000 }])
  seeded.close()
  const opened: Runtime[] = []
  const seen: Parameters<typeof createRuntime>[0][] = []
  const closed: Runtime[] = []
  const events: PreviewEvent[] = []
  const service = new PreviewService({
    ctx: h.ctx,
    host: options.host ?? idle,
    onEvent: (event) => events.push(event),
    accountStamp: options.stamp ?? (() => 'created-1'),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    openRuntime: (runtimeOptions) => {
      seen.push(runtimeOptions)
      const runtime = createRuntime(runtimeOptions)
      opened.push(runtime)
      const close = runtime.close
      return {
        ...runtime,
        close: () => {
          closed.push(runtime)
          close()
        },
      }
    },
  })
  return { h, service, events, opened, closed, summarizer, seen }
}

describe('PreviewService', () => {
  it('never lets the temporary runtime of an account with no unit transcribe: no whisper without a unit that owns it (RNF-09)', async () => {
    const { service, events, seen, opened } = await setup()
    expect(await service.start('default')).toEqual({ ok: true })
    await until(() => events.length === 1, 'the preview')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.transcriber).toBeNull()
    expect(opened[0]?.transcription.enabled).toBe(false)
  })

  it('opens a temporary runtime for an account with no unit and closes it when the preview ends', async () => {
    const { service, events, opened, closed } = await setup()
    expect(await service.start('default')).toEqual({ ok: true })
    await until(() => events.length === 1, 'the preview')
    expect(opened).toHaveLength(1)
    expect(closed).toHaveLength(1)
    expect(service.get('default')).toMatchObject({ state: 'done', summarized: 1 })
  })

  it('closes the temporary runtime at shutdown without waiting, and keeps and announces nothing', async () => {
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const { service, events, closed, summarizer, h } = await setup({ gate })
    expect(await service.start('default')).toEqual({ ok: true })
    await until(() => summarizer.requests.length === 1, 'the summarizer to be asked')
    service.stop()
    expect(closed).toHaveLength(1)
    expect(service.get('default')).toEqual({ state: 'none' })
    expect(await service.start('default')).toEqual({ ok: false, reason: 'unavailable' })
    open()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(events).toEqual([])
    expect(service.get('default')).toEqual({ state: 'none' })
    expect(h.logs.join('\n')).not.toContain('preview.finished')
    // the runtime was closed once (not again when the preview ended)
    expect(closed).toHaveLength(1)
  })

  it('is refused (and opens nothing) while a link holds the account, in this process or in another', async () => {
    const { service, h, opened } = await setup({ host: { ...idle, isClaimed: () => true } })
    expect(await service.start('default')).toEqual({ ok: false, reason: 'busy' })
    const free = await setup()
    const lock = await acquireLinkLock(free.h.account, process.ppid)
    if (!lock.ok) throw new Error('lock refused')
    expect(await free.service.start('default')).toEqual({ ok: false, reason: 'beingLinked' })
    await lock.release()
    expect(opened).toHaveLength(0)
    expect(free.opened).toHaveLength(0)
    expect(service.get('default')).toEqual({ state: 'none' })
    expect(h.logs.join('\n')).not.toContain('preview')
  })

  it('discards a finished preview after the time to live', async () => {
    const { service, events } = await setup({ ttlMs: 40 })
    await service.start('default')
    await until(() => events.length === 1, 'the preview')
    expect(service.get('default').state).toBe('done')
    await until(() => service.get('default').state === 'none', 'the expiry')
  })

  it('uses the runtime of the unit when there is one, and does not close it', async () => {
    const unit = await setup()
    const own = unit.h.runtime()
    let closes = 0
    const close = own.close
    const borrowed: Runtime = {
      ...own,
      close: () => {
        closes++
        close()
      },
    }
    const { service, events, opened } = await setup({ host: { ...idle, runtimeOf: () => borrowed } })
    // the seeded messages of THIS harness are in its own database, not in the borrowed one: only that nothing is opened matters
    await service.start('default')
    await until(() => events.length === 1, 'the preview')
    expect(opened).toHaveLength(0)
    expect(closes).toBe(0)
    own.close()
  })

  it('does not outlive its account: gone, or created again with the same id, or linked again', async () => {
    let stamp: string | null = 'created-1'
    const { service, events } = await setup({ stamp: () => stamp })
    await service.start('default')
    await until(() => events.length === 1, 'the preview')
    expect(service.get('default').state).toBe('done')
    stamp = null // deleted
    expect(service.get('default')).toEqual({ state: 'none' })
    stamp = 'created-2' // created again: the old summary is not served
    expect(service.get('default')).toEqual({ state: 'none' })

    await service.start('default')
    await until(() => events.length === 2, 'the second preview')
    expect(service.get('default').state).toBe('done')
    stamp = 'created-3'
    service.prune()
    expect(service.get('default')).toEqual({ state: 'none' })

    stamp = 'created-3'
    await service.start('default')
    await until(() => events.length === 3, 'the third preview')
    service.forget('default') // a new link began
    expect(service.get('default')).toEqual({ state: 'none' })
  })

  it('a preview whose account is deleted while it runs keeps and announces nothing', async () => {
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    let stamp: string | null = 'created-1'
    const { service, events, summarizer } = await setup({ gate, stamp: () => stamp })
    await service.start('default')
    await until(() => summarizer.requests.length === 1, 'the summarizer to be asked')
    stamp = null
    open()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(events).toEqual([])
    stamp = 'created-1'
    expect(service.get('default')).toEqual({ state: 'none' })
  })

  it('a preview whose unit stops mid-run (borrowed runtime closed) ends as failed and leaks no content', async () => {
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const unit = await setup()
    const own = unit.h.runtime()
    let asked = 0
    // what the use case does on a runtime the host closed under it: it throws when it goes on
    const borrowed: Runtime = {
      ...own,
      generateDigest: async () => {
        asked++
        await gate
        throw new Error(`database closed ${SUMMARY.resumen}`)
      },
    }
    const { service, events, h } = await setup({ host: { ...idle, runtimeOf: () => borrowed } })
    await service.start('default')
    await until(() => asked === 1, 'the digest to start')
    own.close() // the unit stopped: the host closed its runtime
    open()
    await until(() => events.length === 1, 'the end of the preview')
    expect(events[0]).toEqual({ account: 'default', state: 'failed', error: 'failed' })
    expect(service.get('default')).toMatchObject({ state: 'failed', error: 'failed' })
    expect(service.get('default')).not.toHaveProperty('parts')
    expect(h.logs.join('\n')).not.toContain(SUMMARY.resumen)
  })

  it('is refused when a link lock appears between the first look and opening the database', async () => {
    const free = await setup()
    const lock = await acquireLinkLock(free.h.account, process.ppid)
    if (!lock.ok) throw new Error('lock refused')
    expect(await free.service.start('default')).toEqual({ ok: false, reason: 'beingLinked' })
    await lock.release()
  })
})
