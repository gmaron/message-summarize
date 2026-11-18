import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { type Installation, openInstallation } from '../../src/main/accounts.js'
import { type BlockedReason, writeBlocked } from '../../src/main/blocked.js'
import { DaemonHost, type DaemonHostTiming } from '../../src/main/daemon-host.js'
import type { LogStore } from '../../src/main/log-store.js'
import { startWeb, type WebHandle } from '../../src/main/web.js'
import { type Harness, type HarnessOptions, ME, makeHarness, until } from './cli-harness.js'

export const BASE = { language: 'en', timezone: 'UTC', provider: { primary: 'claude-cli' } }
export const TIMING: DaemonHostTiming = {
  scheduleReloadMs: 20,
  sweepMs: 40,
  missedRunDelayMs: 100,
  shutdownGraceMs: 1_000,
  linkHeartbeatMs: 20,
}
export const QR1 = 'QR-SECRET-ONE-2@abc,def,ghi'
export const QR2 = 'QR-SECRET-TWO-2@jkl,mno,pqr'

export interface SseEvent {
  readonly event: string
  readonly data: Record<string, unknown>
}

export interface World {
  readonly h: Harness
  readonly host: DaemonHost
  readonly installation: Installation
  readonly web: WebHandle
  readonly port: number
  readonly sse: SseEvent[]
  api(
    method: string,
    path: string,
    body?: unknown,
    token?: string | null,
  ): Promise<{ status: number; body: Record<string, unknown> }>
  eventsOf(name: string): SseEvent[]
  /** The summarizer of the harness (the one that answers when the world has no other). */
  summarizer(): { readonly requests: readonly unknown[] }
  /** Makes the account look linked (what a finished `link` leaves). */
  linked(id: string, jid?: string): void
  /** What the connection factory does: how long it takes, whether it throws, how many times it was called. */
  readonly factory: { delayMs: number; fails: boolean; calls: number }
}

const worlds: World[] = []

/** Stops every world made by `world()`. Call it in afterEach (and `disposeHarnesses`). */
export async function disposeWorlds(): Promise<void> {
  for (const w of worlds.splice(0)) {
    await w.web.stop()
    await w.host.stop()
    w.installation.close()
  }
}

export async function world(
  options: {
    accounts?: string[]
    linked?: string[]
    blocked?: Record<string, BlockedReason>
    start?: boolean
    timing?: DaemonHostTiming
    only?: string
    /** The locks of the host carry the real pid of this process (the default of production). */
    ownPid?: boolean
    writeMarker?: (file: string, reason: BlockedReason, at: number) => Promise<void>
    /** The installation's config.json (default `BASE`). */
    config?: Record<string, unknown>
    /** What summarizes (default: the harness's, which always answers). */
    summarizer?: HarnessOptions['summarizer']
    /** How long a finished preview is kept. */
    previewTtlMs?: number
    /** The runtimes build the configured providers (the harness's summarizer is not injected). */
    realProviders?: boolean
    /** Where the daemon looks for the built web. */
    staticDir?: string
    /** The recent log lines the web serves (RF-75). */
    logs?: LogStore
    /** The least time between two `log` events. */
    logEventMs?: number
  } = {},
): Promise<World> {
  const h = await makeHarness({
    config: options.config ?? BASE,
    accounts: options.accounts ?? [],
    liveClock: true,
    ...(options.staticDir === undefined ? {} : { web: { staticDir: options.staticDir } }),
    ...(options.summarizer === undefined ? {} : { summarizer: options.summarizer }),
  })
  const conn = h.connection
  if (options.realProviders === true) delete (h.ctx as { summarizer?: unknown }).summarizer
  conn.user = { id: ME }
  const factory = { delayMs: 0, fails: false, calls: 0 }
  Object.assign(h.ctx, {
    connectionFactory: async (
      runtime: { layout: { authDir: string }; capture: never },
      hooks: { capture?: unknown },
    ) => {
      factory.calls++
      // Every unit starts from a clean status: this object is shared, and a leftover loggedOut/error/qr of an earlier one
      // would be fed to the next as if it had just happened.
      conn.freshStatus()
      if (factory.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, factory.delayMs))
      if (factory.fails) throw new Error('the factory failed')
      conn.capture = (hooks.capture ?? runtime.capture) as never
      // Like the real adapter: the stored session is deleted from the auth directory.
      conn.clearSession = async () => {
        conn.calls.push('clearSession')
        for (const name of readdirSync(runtime.layout.authDir)) {
          rmSync(join(runtime.layout.authDir, name), { recursive: true, force: true })
        }
      }
      return conn
    },
  })
  const opened = await openInstallation({ layout: h.layout, clock: h.clock })
  if (!opened.ok) throw new Error('refused')
  const installation = opened.installation
  const host = new DaemonHost({
    ctx: h.ctx,
    installation,
    onlyAccount: options.only ?? null,
    language: 'en',
    timing: { ...TIMING, ...options.timing },
    // The "other process" of these tests is this one, so the host's locks carry another (live) pid.
    ...(options.ownPid === true ? {} : { linkLockPid: process.ppid }),
    ...(options.writeMarker === undefined ? {} : { writeMarker: options.writeMarker }),
  })
  const linked = (id: string, jid = ME): void => {
    const runtime = h.runtime(id)
    runtime.identity.bind(jid)
    runtime.close()
    writeFileSync(join(h.accountOf(id).authDir, 'creds.json'), JSON.stringify({ me: { id: jid } }))
  }
  for (const id of options.linked ?? []) linked(id)
  for (const [id, reason] of Object.entries(options.blocked ?? {}))
    await writeBlocked(h.accountOf(id).blockedFile, reason, 5)
  if (options.start !== false) await host.start()
  const web = (await startWeb({
    ctx: h.ctx,
    installation,
    host,
    web: { enabled: true, host: '127.0.0.1', port: 0 },
    language: 'en',
    ...(options.previewTtlMs === undefined ? {} : { previewTtlMs: options.previewTtlMs }),
    ...(options.logs === undefined ? {} : { logs: options.logs }),
    ...(options.logEventMs === undefined ? {} : { logEventMs: options.logEventMs }),
  })) as WebHandle
  const listening = h.logs
    .map((l) => JSON.parse(l) as { event: string; port?: number })
    .find((e) => e.event === 'web.listening')
  const port = listening?.port as number
  const token = readFileSync(h.layout.webTokenFile, 'utf8').trim()
  const sse: SseEvent[] = []
  let buffer = ''
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: '/api/events',
    headers: { Authorization: `Bearer ${token}` },
    agent: false,
  })
  let streaming = false
  req.on('response', (res) => {
    streaming = true
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const event = /^event: (.+)$/m.exec(block)?.[1]
        const data = /^data: (.+)$/m.exec(block)?.[1]
        if (event !== undefined && data !== undefined)
          sse.push({ event, data: JSON.parse(data) as Record<string, unknown> })
      }
    })
  })
  req.on('error', () => {})
  req.end()
  // The server subscribes the stream before it answers: once the answer is here, no event is missed.
  await until(() => streaming, 'the event stream to open')
  const w: World = {
    h,
    host,
    installation,
    web,
    port,
    sse,
    api: async (method, path, body, auth) => {
      const reply = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          ...(auth === null ? {} : { Authorization: `Bearer ${auth ?? token}` }),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: reply.status, body: (await reply.json().catch(() => ({}))) as Record<string, unknown> }
    },
    eventsOf: (name) => sse.filter((e) => e.event === name),
    summarizer: () => (options.summarizer ?? h.summarizer) as unknown as { requests: unknown[] },
    linked,
    factory,
  }
  worlds.push(w)
  return w
}
