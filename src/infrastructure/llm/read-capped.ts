/**
 * The body of a response as text, read from the stream with a byte limit: when more than `maxBytes` arrive the stream is
 * cancelled at once and the answer is null, so a server that sends an endless body is never held in memory. (Checking the
 * length after `text()` would be too late.) A response with no body is the empty text.
 */
export async function readTextCapped(response: Response, maxBytes: number): Promise<string | null> {
  const body = response.body
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}
