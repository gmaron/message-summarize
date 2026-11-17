import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'

// A fake provider server on 127.0.0.1 (node:http). The network guard lets loopback through, so no test that uses this
// needs allowNetwork(): nothing leaves the machine, and any other host still fails at the guard.

export interface SeenRequest {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly headers: IncomingHttpHeaders
  readonly raw: string
  /** The body parsed as JSON, or undefined when it is not JSON. */
  readonly json: Record<string, unknown> | undefined
}

/** What the fake answers. */
export type Reply =
  | { readonly status?: number; readonly headers?: Record<string, string>; readonly body: string }
  | { readonly hang: true }
  /** A body that never ends: 64 KB chunks, written as fast as the client reads, until the client goes away. */
  | { readonly endless: true; readonly status?: number }

export interface FakeServer {
  readonly baseUrl: string
  readonly seen: SeenRequest[]
  /** Bytes written by `endless` replies. */
  endlessBytes(): number
  /** Replies in order, one per request; the last one repeats. */
  script(...replies: Reply[]): void
  close(): Promise<void>
}

export async function startFakeServer(): Promise<FakeServer> {
  const seen: SeenRequest[] = []
  let replies: Reply[] = []
  let endless = 0
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let json: Record<string, unknown> | undefined
      try {
        json = JSON.parse(raw)
      } catch {
        json = undefined
      }
      seen.push({ method: req.method, url: req.url, headers: req.headers, raw, json })
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)]
      if (reply === undefined || 'hang' in reply) return
      if ('endless' in reply) {
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
        const chunk = Buffer.alloc(64 * 1024, 0x20)
        let open = true
        res.on('close', () => {
          open = false
        })
        const pump = (): void => {
          while (open) {
            endless += chunk.length
            if (!res.write(chunk)) {
              res.once('drain', pump)
              return
            }
          }
        }
        pump()
        return
      }
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers })
      res.end(reply.body)
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    endlessBytes: () => endless,
    script: (...next) => {
      replies = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
