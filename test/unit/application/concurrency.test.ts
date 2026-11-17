import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '../../../src/application/concurrency.js'

describe('mapWithConcurrency', () => {
  it.each([0, -2, 1.5, Number.NaN])('rejects an invalid limit (%s), even with no items', async (limit) => {
    await expect(mapWithConcurrency([], limit, async () => 1)).rejects.toThrow(RangeError)
  })

  it('returns the results in input order', async () => {
    const out = await mapWithConcurrency([3, 1, 2], 3, async (n) => {
      await new Promise((r) => setTimeout(r, n))
      return n * 10
    })
    expect(out).toEqual([30, 10, 20])
  })

  it('stops taking new items after the first rejection', async () => {
    const started: number[] = []
    const run = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n)
      await Promise.resolve()
      if (n === 1) throw new Error('boom')
      await new Promise((r) => setTimeout(r, 2))
      return n
    })
    await expect(run).rejects.toThrow('boom')
    await new Promise((r) => setTimeout(r, 20))
    expect(started).toEqual([0, 1])
  })
})
