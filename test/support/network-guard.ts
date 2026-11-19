// RNF-01: no network calls beyond the declared ones. For every test, outbound network fails loudly unless the
// target is loopback. Later phases may declare an explicit allowlist through allowNetwork(), in tests only.
//
// Subprocesses (child_process, worker_threads) run WITHOUT this guard, so they are blocked too unless the command
// was declared through allowSubprocess(). Tests that need a subprocess must spawn fake binaries (a script under
// test/fixtures that prints canned output), never a real tool that could reach the network.
import childProcess from 'node:child_process'
import dgram from 'node:dgram'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import tls from 'node:tls'
import workerThreads from 'node:worker_threads'

const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const extraHosts = new Set<string>()
const allowedCommands = new Set<string>()

function normalize(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
}

/** Allows a host for the rest of the test file. Returns a function that revokes it. For tests only. */
export function allowNetwork(host: string): () => void {
  const normalized = normalize(host)
  extraHosts.add(normalized)
  return () => {
    extraHosts.delete(normalized)
  }
}

/**
 * Allows spawning a command (child_process: the command or file; for exec, the first word of the line;
 * worker_threads: the worker file). Returns a function that revokes it. For tests only, with fake binaries.
 */
export function allowSubprocess(command: string): () => void {
  allowedCommands.add(command)
  return () => {
    allowedCommands.delete(command)
  }
}

function isAllowed(host: string): boolean {
  const normalized = normalize(host)
  return LOCAL_HOSTS.has(normalized) || extraHosts.has(normalized)
}

function assertAllowed(host: string | undefined | null): void {
  const target = host === undefined || host === null || host === '' ? 'localhost' : host
  if (!isAllowed(target)) throw new Error(`Undeclared network call to ${target}`)
}

function assertSubprocessAllowed(command: unknown): void {
  const text = command instanceof URL ? command.href : String(command)
  if (allowedCommands.has(text) || allowedCommands.has(text.trim().split(/\s+/)[0] ?? '')) return
  // Vite on Windows runs exactly `net use` (it lists mapped network drives, no data traffic) to resolve real paths.
  // Only that exact command, only on win32; any other `net ...` stays blocked.
  if (process.platform === 'win32' && text === 'net use') return
  throw new Error(`Undeclared subprocess: ${text}`)
}

function hostFromUrlLike(input: unknown): string | undefined {
  if (typeof input === 'string' || input instanceof URL) return new URL(input).hostname
  if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url).hostname
  return undefined
}

function hostFromRequestArgs(args: unknown[]): string | undefined {
  const [first, second] = args
  const fromUrl = typeof first === 'string' || first instanceof URL ? new URL(first).hostname : undefined
  const options = (typeof first === 'object' && !(first instanceof URL) ? first : second) as
    | { hostname?: string; host?: string }
    | undefined
  if (options && typeof options === 'object') return options.hostname ?? options.host ?? fromUrl
  return fromUrl
}

/** Checks the target of net.connect / Socket#connect style arguments: (options) | (port, host) | (path). */
function assertConnectArgs(args: unknown[]): void {
  const [first, second] = args
  if (typeof first === 'object' && first !== null) {
    const options = first as { path?: string; host?: string }
    if (options.path === undefined) assertAllowed(options.host)
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    assertAllowed(typeof second === 'string' ? second : undefined)
  }
  // anything else is a unix socket / pipe path, which is local
}

type Fn = (...args: unknown[]) => unknown

/** Replaces target[name] with a wrapper that runs `check` with the call arguments before calling the original. */
function guardMethod(target: object, name: string, check: (args: unknown[]) => void): void {
  const holder = target as Record<string, unknown>
  const original = holder[name]
  if (typeof original !== 'function') return
  holder[name] = function (this: unknown, ...args: unknown[]) {
    check(args)
    return (original as Fn).apply(this, args)
  }
}

const hostFromFirstArg = (args: unknown[]) => assertAllowed(typeof args[0] === 'string' ? args[0] : undefined)

const INSTALLED = Symbol.for('message-summarize.network-guard')

export function installNetworkGuard(): void {
  const g = globalThis as Record<symbol, unknown>
  if (g[INSTALLED]) return
  g[INSTALLED] = true

  // net.Socket.prototype.connect is the choke point for net, tls, http and https
  guardMethod(net.Socket.prototype, 'connect', assertConnectArgs)
  guardMethod(net, 'connect', assertConnectArgs)
  guardMethod(net, 'createConnection', assertConnectArgs)

  guardMethod(tls, 'connect', (args) => {
    const [first, second] = args
    if (typeof first === 'object' && first !== null) {
      const options = first as { host?: string; servername?: string }
      assertAllowed(options.host ?? options.servername)
    } else {
      assertAllowed(typeof second === 'string' ? second : undefined)
    }
  })

  for (const mod of [http, https]) {
    guardMethod(mod, 'request', (args) => assertAllowed(hostFromRequestArgs(args)))
    guardMethod(mod, 'get', (args) => assertAllowed(hostFromRequestArgs(args)))
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    assertAllowed(hostFromUrlLike(input))
    return originalFetch(input, init)
  }) as typeof fetch

  // DNS: lookup, every resolve*/reverse, lookupService, on the module, the promises API and both Resolver classes
  const dnsTargets: object[] = [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]
  for (const target of dnsTargets) {
    for (const name of Object.getOwnPropertyNames(target)) {
      if (name === 'lookup' || name === 'lookupService' || name === 'reverse' || name.startsWith('resolve')) {
        guardMethod(target, name, hostFromFirstArg)
      }
    }
  }

  // UDP
  guardMethod(dgram.Socket.prototype, 'connect', (args) =>
    assertAllowed(typeof args[1] === 'string' ? args[1] : undefined),
  )
  guardMethod(dgram.Socket.prototype, 'send', (args) => {
    // send(msg, port, address, cb) | send(msg, offset, length, port, address, cb) | send(msg, port, cb) when connected
    const strings = args.slice(1).filter((arg): arg is string => typeof arg === 'string')
    const address = strings.at(-1)
    if (address !== undefined) assertAllowed(address)
  })

  // Subprocesses run without this guard
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    guardMethod(childProcess, name, (args) => assertSubprocessAllowed(args[0]))
  }
  const OriginalWorker = workerThreads.Worker
  class GuardedWorker extends OriginalWorker {
    constructor(
      filename: ConstructorParameters<typeof OriginalWorker>[0],
      options?: ConstructorParameters<typeof OriginalWorker>[1],
    ) {
      assertSubprocessAllowed(filename)
      super(filename, options)
    }
  }
  workerThreads.Worker = GuardedWorker

  syncBuiltinESMExports()
}
