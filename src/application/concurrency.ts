/** Throws a RangeError unless `limit` is a positive integer. */
export function assertConcurrency(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('concurrency must be a positive integer')
}

/**
 * Maps `items` with at most `limit` calls of `fn` running at once. The results keep the order of `items`, whatever
 * the order of completion. If `fn` rejects, no new item is started and the first rejection is rethrown at once
 * (calls already running are left to finish). `limit` must be a positive integer (RangeError otherwise).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  assertConcurrency(limit)
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index] as T, index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
