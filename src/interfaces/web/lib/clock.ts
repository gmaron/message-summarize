/** What the clock needs of the browser; the real timers fit. */
export interface ClockEnv {
  readonly now: () => number
  readonly setInterval: (handler: () => void, ms: number) => unknown
  readonly clearInterval: (handle: unknown) => void
}

/** How often the page looks at the time again. A day that turns is noticed within this. */
export const CLOCK_MS = 30_000

const REAL: ClockEnv = {
  now: () => Date.now(),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/**
 * One clock for the whole page: tells `onTick` the time now, and again every `CLOCK_MS`, so every "today 9:00" and
 * "tomorrow" is worked out from the same moment and the turn of the day shows up on its own. Returns the way to stop it.
 */
export function startClock(onTick: (now: number) => void, env: ClockEnv = REAL): () => void {
  onTick(env.now())
  const handle = env.setInterval(() => onTick(env.now()), CLOCK_MS)
  return () => env.clearInterval(handle)
}
