export const DEFAULT_PART_MAX = 3500

/**
 * Splits the lines of a message into parts of at most `max` UTF-16 units, joined with "\n". It only splits between
 * lines, so a line longer than `max` stays whole as an oversized part, and a part may be exactly `max` long.
 * A blank line that does not fit is dropped, so no part starts with a blank line. A blank line that fits is kept
 * even when the next line starts a new part: that part then ends with "\n" (inherited behavior).
 */
export function splitIntoParts(lines: readonly string[], max: number = DEFAULT_PART_MAX): string[] {
  const parts: string[] = []
  let current = ''
  for (const line of lines) {
    if (current !== '' && current.length + line.length + 1 > max) {
      parts.push(current)
      current = ''
    }
    current += (current !== '' ? '\n' : '') + line
  }
  if (current !== '') parts.push(current)
  return parts
}
