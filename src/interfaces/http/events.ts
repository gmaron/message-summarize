/** Where the server gets the events it pushes over SSE. */
export interface EventSource {
  /** Calls `listener` for every event until the returned function is called. */
  subscribe(listener: (event: string, data: unknown) => void): () => void
}

/**
 * A typed in-process bus: `E` maps each event name to the shape of its data (`accounts`, and later `qr` and `sync`).
 * The producers publish here and the server forwards what is published to every open `GET /api/events` connection.
 */
export class EventBus<E extends Record<string, unknown>> implements EventSource {
  private readonly listeners = new Set<(event: string, data: unknown) => void>()

  /** How many connections are listening: a producer with nobody to tell can skip the work of building the data. */
  get size(): number {
    return this.listeners.size
  }

  subscribe(listener: (event: string, data: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish<K extends keyof E & string>(event: K, data: E[K]): void {
    for (const listener of [...this.listeners]) listener(event, data)
  }
}
