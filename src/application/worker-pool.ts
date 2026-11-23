/** What one step of a worker did: 'done' (one unit was handled, go on) or 'stop' (nothing left, or it cannot go on now). */
export type StepResult = 'done' | 'stop'

export interface WorkerPool {
  /** Starts workers up to the pool size, unless they already run. Returns at once. A kick during a run makes it look again. */
  kick(): void
  /** Resolves when no worker runs. */
  idle(): Promise<void>
  /** True while a worker runs. */
  readonly busy: boolean
}

export interface WorkerPoolOptions {
  /** How many workers run at once. */
  readonly size: number
  /** One unit of work. Never throws (a step that can fail catches it and says 'stop'). */
  readonly step: () => Promise<StepResult>
  /** True once the pool must not start anything. */
  readonly isStopped: () => boolean
}

/**
 * Up to `size` workers, each one looping `step` until it says 'stop'. Workers pull from a shared queue (the database), so
 * memory holds at most one unit per worker. `kick` tops the pool up: a unit that arrives while some workers are idle is
 * picked up at once by a new worker, in parallel with the ones still busy.
 */
export function createWorkerPool({ size, step, isStopped }: WorkerPoolOptions): WorkerPool {
  const loops = new Set<Promise<void>>()
  let again = false

  const topUp = (): void => {
    while (loops.size < size && !isStopped()) spawn()
  }

  const spawn = (): void => {
    const loop = (async () => {
      try {
        while (!isStopped() && (await step()) === 'done') {
          // next unit
        }
      } catch {
        // a step does not throw; if one does, the worker ends and the next kick starts another
      }
    })()
    loops.add(loop)
    // Registered before anybody can wait on the loop, so `idle` sees what this starts.
    void loop.then(() => {
      loops.delete(loop)
      if (again && !isStopped()) {
        again = false
        topUp()
      }
    })
  }

  return {
    kick() {
      if (isStopped()) return
      if (loops.size < size) topUp()
      else again = true
    },
    get busy() {
      return loops.size > 0
    },
    async idle() {
      while (loops.size > 0) await Promise.all([...loops])
    },
  }
}
