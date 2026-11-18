/** The prefix of the exact form of a pattern: `id:<conversation id>`. */
const ID_PREFIX = 'id:'

/** The pattern that names exactly one conversation by its id (what the web writes when a chat is marked). */
export const idPattern = (conversationId: string): string => `${ID_PREFIX}${conversationId}`

/**
 * The id an exact pattern names, normalized (trimmed, lowercase), or null when the pattern is not of the `id:` form.
 * `id:` alone gives the empty string: it names nothing (the configuration refuses it).
 */
export function exactIdOf(pattern: string): string | null {
  const lower = pattern.toLowerCase()
  return lower.startsWith(ID_PREFIX) ? lower.slice(ID_PREFIX.length).trim() : null
}

/** Whether one of the patterns is the exact form for this conversation id (compared without case and outer spaces). */
export function hasIdPattern(patterns: readonly string[], conversationId: string): boolean {
  const id = conversationId.toLowerCase().trim()
  return patterns.some((pattern) => exactIdOf(pattern) === id)
}

/**
 * Whether a conversation matches any of the patterns (RF-14, RF-43; excluded and "local only" lists use the same rule).
 * The name is the resolved one, as shown in the digest.
 *
 * - A pattern `id:<conversation id>` is EXACT: it matches only the conversation whose id equals it (case-insensitive,
 *   spaces after the prefix ignored) and never matches by substring, so `id:5491112345678@s.whatsapp.net` does not catch
 *   `15491112345678@s.whatsapp.net`.
 * - Every other pattern is a case-insensitive substring of "<id> <name>". On purpose: "ana" also matches "Mariana".
 */
export function isExcluded(patterns: readonly string[], conversationId: string, resolvedName: string | null): boolean {
  if (patterns.length === 0) return false
  const id = conversationId.toLowerCase()
  let haystack: string | null = null
  for (const pattern of patterns) {
    const exact = exactIdOf(pattern)
    if (exact !== null) {
      if (exact !== '' && exact === id.trim()) return true
      continue
    }
    haystack ??= `${id} ${(resolvedName ?? '').toLowerCase()}`
    if (haystack.includes(pattern.toLowerCase())) return true
  }
  return false
}
