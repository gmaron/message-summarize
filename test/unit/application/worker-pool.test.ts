import { describe, expect, it } from 'vitest'
import { createWorkerPool, type StepResult } from '../../../src/application/worker-pool.js'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A gate the test opens by hand. */
function gate(): { wait: Promise<void>; open(): void } {
  let open: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

describe('createWorkerPool', () => {
  it('runs at most `size` steps at once and uses all of them', async () => {
    const hold = gate()
    let running = 0
    let most = 0
    let left = 6
    const pool = createWorkerPool({
      size: 2,
      isStopped: () => false,
      step: async () => {
        if (left === 0) return 'stop'
        left--
        running++
        most = Math.max(most, running)
        await hold.wait
        running--
        return 'done'
      },
    })
    pool.kick()
    pool.kick()
    await flush()
    expect(pool.busy).toBe(true)
    expect(running).toBe(2)
    hold.open()
    await pool.idle()
    expect(most).toBe(2)
    expect(left).toBe(0)
    expect(pool.busy).toBe(false)
  })

  it('a kick while every worker is busy makes the pool look again once they are done: work that arrives late is not lost', async () => {
    const queue: string[] = ['first']
    const handled: string[] = []
    const hold = gate()
    let looks = 0
    const pool = createWorkerPool({
      size: 1,
      isStopped: () => false,
      step: async (): Promise<StepResult> => {
        looks++
        const next = queue.shift()
        if (looks === 2) await hold.wait // the second look finds nothing, and its answer is held on its way back
        if (next === undefined) return 'stop'
        handled.push(next)
        return 'done'
      },
    })
    pool.kick()
    await flush()
    queue.push('late')
    pool.kick()
    hold.open()
    await pool.idle()
    expect(handled).toEqual(['first', 'late'])
  })

  it('does not start anything once stopped, not even for a kick that was waiting', async () => {
    const queue: string[] = ['first']
    const handled: string[] = []
    const hold = gate()
    let stopped = false
    let looks = 0
    const pool = createWorkerPool({
      size: 1,
      isStopped: () => stopped,
      step: async (): Promise<StepResult> => {
        looks++
        const next = queue.shift()
        if (looks === 2) await hold.wait
        if (next === undefined) return 'stop'
        handled.push(next)
        return 'done'
      },
    })
    pool.kick()
    await flush()
    queue.push('late')
    pool.kick()
    stopped = true
    hold.open()
    await pool.idle()
    pool.kick()
    await pool.idle()
    expect(handled).toEqual(['first'])
    expect(looks).toBe(2)
  })

  it('a step that throws ends that worker, and the next kick starts another', async () => {
    let calls = 0
    const pool = createWorkerPool({
      size: 1,
      isStopped: () => false,
      step: async () => {
        calls++
        if (calls === 1) throw new Error('boom')
        return 'stop'
      },
    })
    pool.kick()
    await pool.idle()
    pool.kick()
    await pool.idle()
    expect(calls).toBe(2)
  })
})
