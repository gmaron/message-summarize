/**
 * A conversation is excluded when any pattern is a case-insensitive substring of "<id> <name>" (RF-14). The name is
 * the resolved one, as shown in the digest. It is a substring match on purpose: "ana" also excludes "Mariana".
 */
export function isExcluded(patterns: readonly string[], conversationId: string, resolvedName: string | null): boolean {
  if (patterns.length === 0) return false
  const haystack = `${conversationId} ${resolvedName ?? ''}`.toLowerCase()
  return patterns.some((pattern) => haystack.includes(pattern.toLowerCase()))
}
