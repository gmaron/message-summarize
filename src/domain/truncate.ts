/**
 * Keeps the last `max` UTF-16 units of a transcript (RF-37): the oldest messages are the ones lost. The cut can fall
 * in the middle of a line or split a surrogate pair (inherited behavior). The marker line is added by the renderer.
 */
export function truncateTranscript(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(text.length - max), truncated: true }
}
