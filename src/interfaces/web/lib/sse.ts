/** What the page needs of an `EventSource`; the browser's one fits. */
export interface EventSourceLike {
  readonly readyState: number
  addEventListener(type: string, listener: (event: { data?: string }) => void): void
  close(): void
}

export const SSE_EVENTS = ['accounts', 'qr', 'sync', 'link', 'digest', 'preview', 'history'] as const

export interface SseHandlers {
  event(name: string, data: unknown): void
  /** The stream is open. `again` is true when it had been open before (a reconnect): what was missed must be asked for. */
  open(again: boolean): void
  /** The stream broke. The browser reconnects by itself unless the answer was an error (then `closed` is true). */
  broken(closed: boolean): void
}

const CLOSED = 2

/**
 * One stream of events with the daemon. The browser's `EventSource` reconnects on its own after a break; when it gives
 * up (the answer was not a stream, for instance a 401) this opens a new one after `retryMs`. `close()` ends it all.
 */
export function connectEvents(
  create: () => EventSourceLike,
  handlers: SseHandlers,
  retryMs = 3_000,
): { close(): void } {
  let source: EventSourceLike | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let opened = false
  const attach = (): void => {
    const current = create()
    source = current
    const listen = (type: string, listener: (event: { data?: string }) => void) =>
      current.addEventListener(type, listener)
    listen('open', () => {
      handlers.open(opened)
      opened = true
    })
    listen('error', () => {
      if (stopped || source !== current) return
      const closed = current.readyState === CLOSED
      handlers.broken(closed)
      if (closed) {
        timer = setTimeout(attach, retryMs)
      }
    })
    for (const name of SSE_EVENTS) {
      listen(name, (event) => {
        try {
          handlers.event(name, JSON.parse(event.data ?? 'null'))
        } catch {
          // a block that is not JSON is not ours
        }
      })
    }
  }
  attach()
  return {
    close: () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      source?.close()
    },
  }
}
