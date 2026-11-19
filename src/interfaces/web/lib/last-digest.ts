import type { Api } from './api.js'
import type { HistoryRun } from './types.js'

/** The last digest an account produced: what it said and when it was made. `text` comes from chats of third parties. */
export interface LastDigest {
  readonly run: HistoryRun
  readonly text: string
  /** When the digest was made (epoch ms). */
  readonly at: number
}

const PAGE = 20
/** How many pages of runs are looked through: a run with a digest is almost always on the first. */
export const MAX_PAGES = 5

/**
 * The last digest of an account, read from its history: the newest run that has a digest, looking through up to
 * `MAX_PAGES` pages, with the detail that holds the text. Null when none was found (the account may still have made
 * digests earlier: `account.lastDigest` says).
 */
export async function loadLastDigest(api: Api, account: string): Promise<LastDigest | null> {
  for (let page = 0; page < MAX_PAGES; page++) {
    const view = await api.history(account, { limit: PAGE, offset: page * PAGE })
    const run = view.items.find((item) => item.digestId !== null)
    if (run !== undefined) {
      const detail = await api.historyRun(account, run.id)
      return detail.digest === null ? null : { run, text: detail.digest.text, at: run.finishedAt ?? run.startedAt }
    }
    if (view.items.length < PAGE || (page + 1) * PAGE >= view.total) return null
  }
  return null
}
