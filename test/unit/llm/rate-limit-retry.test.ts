import { describe, expect, it } from 'vitest'
import { err, ok } from '../../../src/domain/result.js'
import {
  type Attempt,
  backoffMs,
  parseRetryAfter,
  parseRetryInfoDelay,
  type RetryClock,
  withRateLimitRetry,
} from '../../../src/infrastructure/llm/api/rate-limit-retry.js'

/** A clock that does not wait: it records how long it was asked to. */
function fakeClock(random = 0): RetryClock & { readonly waits: number[] } {
  const waits: number[] = []
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms)
    },
    random: () => random,
  }
}

const script =
  (...outcomes: Attempt<string>[]) =>
  async (): Promise<Attempt<string>> =>
    outcomes.shift() ?? { kind: 'fail', reason: 'the script ran out' }

const budget = { maxRetries: 3, maxTotalWaitMs: 120_000 }

describe('withRateLimitRetry (RF-46)', () => {
  it('returns the value of the first attempt without waiting', async () => {
    const clock = fakeClock()
    expect(await withRateLimitRetry(script({ kind: 'done', value: 'x' }), budget, clock)).toEqual(ok('x'))
    expect(clock.waits).toEqual([])
  })

  it('waits the time the provider asks for, then tries again', async () => {
    const clock = fakeClock()
    const result = await withRateLimitRetry(
      script({ kind: 'retry', reason: '429', hintMs: 7_000 }, { kind: 'done', value: 'y' }),
      budget,
      clock,
    )
    expect(result).toEqual(ok('y'))
    expect(clock.waits).toEqual([7_000])
  })

  it('uses exponential backoff with jitter when there is no hint', async () => {
    const clock = fakeClock(0)
    await withRateLimitRetry(
      script(
        { kind: 'retry', reason: 'overloaded' },
        { kind: 'retry', reason: 'overloaded' },
        { kind: 'retry', reason: 'overloaded' },
        { kind: 'done', value: 'z' },
      ),
      budget,
      clock,
    )
    // random 0: half of each step (1 s, 2 s, 4 s)
    expect(clock.waits).toEqual([500, 1_000, 2_000])
    expect(backoffMs(0, 0.999)).toBeGreaterThan(900)
    expect(backoffMs(10, 1)).toBe(30_000)
  })

  it('does not retry a failure', async () => {
    const clock = fakeClock()
    expect(await withRateLimitRetry(script({ kind: 'fail', reason: 'bad key' }), budget, clock)).toEqual(err('bad key'))
    expect(clock.waits).toEqual([])
  })

  it('gives up after the retries of the budget, with the last reason', async () => {
    const clock = fakeClock()
    const result = await withRateLimitRetry(
      script(...Array.from({ length: 10 }, () => ({ kind: 'retry', reason: '429', hintMs: 1_000 }) as const)),
      budget,
      clock,
    )
    expect(result).toEqual(err('429 (gave up after 3 retries)'))
    expect(clock.waits).toEqual([1_000, 1_000, 1_000])
  })

  it('does not retry at all with a budget of zero retries', async () => {
    const clock = fakeClock()
    const result = await withRateLimitRetry(
      script({ kind: 'retry', reason: '429', hintMs: 10 }),
      { maxRetries: 0, maxTotalWaitMs: 1000 },
      clock,
    )
    expect(result).toEqual(err('429'))
    expect(clock.waits).toEqual([])
  })

  it('fails at once when the wait asked for does not fit in the budget, instead of waiting for nothing', async () => {
    const clock = fakeClock()
    const result = await withRateLimitRetry(
      script({ kind: 'retry', reason: '429', hintMs: 300_000 }, { kind: 'done', value: 'never' }),
      budget,
      clock,
    )
    expect(result.ok).toBe(false)
    expect(clock.waits).toEqual([])
  })

  it('counts the waits together: the second wait may not fit even if the first did', async () => {
    const clock = fakeClock()
    const result = await withRateLimitRetry(
      script(
        { kind: 'retry', reason: '429', hintMs: 80_000 },
        { kind: 'retry', reason: '429', hintMs: 80_000 },
        { kind: 'done', value: 'never' },
      ),
      budget,
      clock,
    )
    expect(result.ok).toBe(false)
    expect(clock.waits).toEqual([80_000])
  })

  describe('the total deadline of the call', () => {
    /** A clock that moves: sleeping and the attempts themselves (`spend`) advance it. */
    function movingClock() {
      let t = 0
      const waits: number[] = []
      return {
        waits,
        spend: (ms: number) => {
          t += ms
        },
        sleep: async (ms: number) => {
          waits.push(ms)
          t += ms
        },
        random: () => 0,
        now: () => t,
      }
    }

    it('tells each attempt how much time is left, attempts and waits counted together, and stops past the deadline', async () => {
      const clock = movingClock()
      const remaining: number[] = []
      const result = await withRateLimitRetry(
        async (left) => {
          remaining.push(left)
          clock.spend(40_000)
          return { kind: 'retry', reason: '429', hintMs: 1_000 }
        },
        { maxRetries: 10, maxTotalWaitMs: 1_000_000, maxTotalMs: 100_000 },
        clock,
      )
      expect(remaining).toEqual([100_000, 59_000, 18_000])
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('total time limit')
    })

    it('does not start a wait that would end after the deadline', async () => {
      const clock = movingClock()
      const result = await withRateLimitRetry(
        script({ kind: 'retry', reason: '429', hintMs: 90_000 }, { kind: 'done', value: 'never' }),
        { maxRetries: 3, maxTotalWaitMs: 1_000_000, maxTotalMs: 60_000 },
        clock,
      )
      expect(result.ok).toBe(false)
      expect(clock.waits).toEqual([])
    })

    it('fails without calling the attempt when the deadline has already passed', async () => {
      const clock = movingClock()
      clock.spend(10)
      let called = false
      const result = await withRateLimitRetry(
        async () => {
          called = true
          return { kind: 'done', value: 'x' }
        },
        { maxRetries: 3, maxTotalWaitMs: 1000, maxTotalMs: 0 },
        clock,
      )
      expect(result.ok).toBe(false)
      expect(called).toBe(false)
    })

    it('is 300 seconds when the budget does not say', async () => {
      const clock = movingClock()
      const remaining: number[] = []
      await withRateLimitRetry(
        async (left) => {
          remaining.push(left)
          return { kind: 'done', value: 'x' }
        },
        { maxRetries: 3, maxTotalWaitMs: 1000 },
        clock,
      )
      expect(remaining).toEqual([300_000])
    })
  })
})

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-17T12:00:00Z')

  it('reads seconds, also with decimals', () => {
    expect(parseRetryAfter('30', now)).toBe(30_000)
    expect(parseRetryAfter('1.5', now)).toBe(1_500)
  })

  it('reads an HTTP date as the time left until it', () => {
    expect(parseRetryAfter('Tue, 17 Nov 2026 12:01:00 GMT', now)).toBe(60_000)
  })

  it('treats a date in the past as no wait', () => {
    expect(parseRetryAfter('Tue, 17 Nov 2026 11:00:00 GMT', now)).toBe(0)
  })

  it('gives null for nothing or for something it does not understand', () => {
    expect(parseRetryAfter(null, now)).toBeNull()
    expect(parseRetryAfter(undefined, now)).toBeNull()
    expect(parseRetryAfter('soon', now)).toBeNull()
  })
})

describe('parseRetryInfoDelay (Gemini)', () => {
  const body = (details: unknown) => JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details } })

  it('reads retryDelay of the RetryInfo detail', () => {
    const details = [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure' },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
    ]
    expect(parseRetryInfoDelay(body(details))).toBe(37_000)
  })

  it('accepts fractions of a second', () => {
    expect(parseRetryInfoDelay(body([{ '@type': 'x.RetryInfo', retryDelay: '0.5s' }]))).toBe(500)
  })

  it('gives null when there is none, or the body is not what it expects', () => {
    expect(parseRetryInfoDelay(body([]))).toBeNull()
    expect(parseRetryInfoDelay(body('nope'))).toBeNull()
    expect(parseRetryInfoDelay(body([{ '@type': 'x.RetryInfo', retryDelay: 'later' }]))).toBeNull()
    expect(parseRetryInfoDelay('not json')).toBeNull()
  })
})
