import type { WaNumber } from './wa-types.js'

/** Epoch seconds (or ms) of a protobuf number, or null when it is missing or not finite. */
export function toNumber(value: WaNumber): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'object' ? value.toNumber() : Number(value)
  return Number.isFinite(n) ? n : null
}
