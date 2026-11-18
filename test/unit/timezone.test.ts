import { expect, it } from 'vitest'

// Golden files depend on this timezone.
it('runs in America/Argentina/Buenos_Aires', () => {
  expect(process.env.TZ).toBe('America/Argentina/Buenos_Aires')
  expect(new Date('2026-01-15T12:00:00Z').getTimezoneOffset()).toBe(180)
})
