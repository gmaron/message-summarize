import { describe, expect, it } from 'vitest'
import { isInWindow, nextPointer, resolveWindow } from '../../../src/domain/window.js'

const H = 3_600_000
const UNTIL = 100 * H

const resolved = (req: Parameters<typeof resolveWindow>[0]) => {
  const r = resolveWindow(req)
  if (!r.ok) throw new Error(`unexpected error: ${r.error.join(', ')}`)
  return r.value
}
const errorsOf = (req: Parameters<typeof resolveWindow>[0]) => {
  const r = resolveWindow(req)
  if (r.ok) throw new Error('expected an error')
  return r.error
}

describe('resolveWindow start', () => {
  it('uses the default hours with no from, hours or pointer', () => {
    expect(resolved({ until: UNTIL, defaultHours: 6 })).toEqual({ since: UNTIL - 6 * H, until: UNTIL })
  })
  it('uses the pointer before the default hours', () => {
    expect(resolved({ until: UNTIL, pointer: 90 * H, defaultHours: 6 }).since).toBe(90 * H)
  })
  it('treats a null pointer as absent', () => {
    expect(resolved({ until: UNTIL, pointer: null, defaultHours: 6 }).since).toBe(UNTIL - 6 * H)
  })
  it('uses explicit hours before the pointer', () => {
    expect(resolved({ until: UNTIL, hours: 2, pointer: 90 * H, defaultHours: 6 }).since).toBe(UNTIL - 2 * H)
  })
  it('accepts fractional hours', () => {
    expect(resolved({ until: UNTIL, hours: 0.5, defaultHours: 6 }).since).toBe(UNTIL - H / 2)
  })
  it('uses an explicit from before everything else', () => {
    expect(resolved({ until: UNTIL, from: 50 * H, hours: 2, pointer: 90 * H, defaultHours: 6 }).since).toBe(50 * H)
  })
  it('allows a pointer after the end: an empty window, not an error', () => {
    const w = resolved({ until: UNTIL, pointer: 110 * H, defaultHours: 6 })
    expect(w.since).toBe(110 * H)
    expect(isInWindow(w, 105 * H)).toBe(false)
    expect(isInWindow(w, 112 * H)).toBe(false)
  })
})

describe('resolveWindow validation', () => {
  it('rejects a start equal to the end', () => {
    expect(errorsOf({ until: UNTIL, from: UNTIL, defaultHours: 6 })).toEqual(['startNotBeforeEnd'])
  })
  it('rejects a start after the end', () => {
    expect(errorsOf({ until: UNTIL, from: UNTIL + 1, defaultHours: 6 })).toEqual(['startNotBeforeEnd'])
  })
  it('accepts a start one millisecond before the end', () => {
    expect(resolved({ until: UNTIL, from: UNTIL - 1, defaultHours: 6 }).since).toBe(UNTIL - 1)
  })
  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects an end of %s', (until) => {
    expect(errorsOf({ until, defaultHours: 6 })).toEqual(['invalidEnd'])
  })
  it('rejects a start that is not a valid date', () => {
    expect(errorsOf({ until: UNTIL, from: Number.NaN, defaultHours: 6 })).toEqual(['invalidStart'])
  })
  it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY])('rejects hours = %s', (hours) => {
    expect(errorsOf({ until: UNTIL, hours, defaultHours: 6 })).toEqual(['invalidHours'])
  })
  it('validates hours even when from wins', () => {
    expect(errorsOf({ until: UNTIL, from: 1, hours: -1, defaultHours: 6 })).toEqual(['invalidHours'])
  })
  it('rejects an invalid pointer and invalid default hours', () => {
    expect(errorsOf({ until: UNTIL, pointer: Number.NaN, defaultHours: 6 })).toEqual(['invalidPointer'])
    expect(errorsOf({ until: UNTIL, defaultHours: 0 })).toEqual(['invalidDefaultHours'])
  })
  it('lists every problem', () => {
    expect(errorsOf({ until: Number.NaN, hours: 0, defaultHours: 6 })).toEqual(['invalidEnd', 'invalidHours'])
  })
})

describe('isInWindow', () => {
  const w = { since: 10, until: 20 }
  it('includes the start', () => expect(isInWindow(w, 10)).toBe(true))
  it('excludes the end', () => expect(isInWindow(w, 20)).toBe(false))
  it('includes the inside and excludes both outsides', () => {
    expect(isInWindow(w, 19)).toBe(true)
    expect(isInWindow(w, 9)).toBe(false)
    expect(isInWindow(w, 21)).toBe(false)
  })
})

describe('nextPointer', () => {
  it('moves forward', () => expect(nextPointer(20, 10)).toBe(20))
  it('never goes back', () => expect(nextPointer(10, 20)).toBe(20))
  it('starts from nothing', () => {
    expect(nextPointer(20, null)).toBe(20)
    expect(nextPointer(20, undefined)).toBe(20)
  })
})
