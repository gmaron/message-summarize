import { describe, expect, it } from 'vitest'
import { CLOCK_MS, startClock } from '../../../src/interfaces/web/lib/clock.js'

describe('the shared clock', () => {
  it('tells the time at once and then each half minute, until it is stopped', () => {
    let time = 1_000
    let handler: (() => void) | null = null
    let cleared = false
    const seen: number[] = []
    const stop = startClock((now) => seen.push(now), {
      now: () => time,
      setInterval: (h, ms) => {
        expect(ms).toBe(CLOCK_MS)
        handler = h
        return 7
      },
      clearInterval: (handle) => {
        expect(handle).toBe(7)
        cleared = true
      },
    })
    time = 31_000
    ;(handler as (() => void) | null)?.()
    expect(seen).toEqual([1_000, 31_000])
    stop()
    expect(cleared).toBe(true)
    expect(CLOCK_MS).toBe(30_000)
  })
})
