import type { ChatSummary, Priority } from './summary.js'

export interface ChatResult {
  readonly name: string
  readonly messageCount: number
  /** The contact is not in the address book. */
  readonly unsaved: boolean
  readonly summary: ChatSummary
}

export interface DigestSections<R extends ChatResult> {
  /** Only filled when unsaved contacts are flagged. */
  readonly unsaved: readonly R[]
  readonly needsReply: readonly R[]
  readonly withTodos: readonly R[]
  readonly rest: readonly R[]
  readonly counts: {
    readonly total: number
    /** Chats that need a reply, leaving out the ones listed under `unsaved` (inherited behavior). */
    readonly needsReply: number
    readonly unsaved: number
    readonly rest: number
  }
}

const PRIORITY_RANK: Readonly<Record<Priority, number>> = { high: 0, medium: 1, low: 2 }

/**
 * Sorts and splits chat results into the digest sections (RF-35). Results come in conversation order; the sort is
 * by priority (high first), then by message count (most first), and is stable. A chat appears in one section only.
 * Hiding the rest is a rendering choice: `rest` always holds the chats.
 */
export function composeDigest<R extends ChatResult>(results: readonly R[], flagUnsaved: boolean): DigestSections<R> {
  const sorted = results.toSorted(
    (a, b) => PRIORITY_RANK[a.summary.priority] - PRIORITY_RANK[b.summary.priority] || b.messageCount - a.messageCount,
  )
  const unsaved = flagUnsaved ? sorted.filter((r) => r.unsaved) : []
  const inUnsaved = new Set<R>(unsaved)
  const urgent = (r: R): boolean => r.summary.needsReply || inUnsaved.has(r)
  const needsReply = sorted.filter((r) => r.summary.needsReply && !inUnsaved.has(r))
  const withTodos = sorted.filter((r) => !urgent(r) && r.summary.todos.length > 0)
  const rest = sorted.filter((r) => !urgent(r) && r.summary.todos.length === 0)
  return {
    unsaved,
    needsReply,
    withTodos,
    rest,
    counts: { total: results.length, needsReply: needsReply.length, unsaved: unsaved.length, rest: rest.length },
  }
}
