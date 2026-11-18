import type { DigestRun } from '../infrastructure/persistence/sqlite/index.js'
import { SqliteDigestRuns } from '../infrastructure/persistence/sqlite/index.js'
import { HttpError, type Route } from '../interfaces/http/router.js'
import { databaseAccess } from './web-database.js'
import { type AccountRoutesSource, knownAccount } from './web-routes.js'

export const DEFAULT_HISTORY_PAGE = 20
export const MAX_HISTORY_PAGE = 100

/** A run as the history list shows it: counts and codes, no chat names. */
function summary(run: DigestRun) {
  return {
    id: run.id,
    trigger: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.finishedAt === null ? null : Math.max(0, run.finishedAt - run.startedAt),
    outcome: run.outcome,
    error: run.error,
    summarized: run.summarized,
    failed: run.failed,
    providers: run.providers,
    digestId: run.digestId,
  }
}

/**
 * The history of digest runs (RF-74): `GET .../history` lists them newest first, `GET .../history/:runId` gives one with
 * the COMPLETE digest (RF-36: what was delivered may hide the detail of "the rest", the history keeps it) and the
 * conversations that could not be summarized, with a reason code. Both are private chat data: behind the token, read from
 * the account's database like the conversations are (never created), and not in any event or log.
 */
export function historyRoutes(source: AccountRoutesSource): Route[] {
  const withDatabase = databaseAccess(source)
  const intParam = (query: URLSearchParams, name: string): number | undefined => {
    const value = query.get(name)
    if (value === null || value === '') return undefined
    if (!/^\d{1,9}$/.test(value)) throw new HttpError(400, 'invalidRequest')
    return Number(value)
  }
  return [
    {
      method: 'GET',
      path: '/api/accounts/:id/history',
      handler: async ({ params, query }) => {
        const id = knownAccount(source, params)
        const limit = Math.min(Math.max(intParam(query, 'limit') ?? DEFAULT_HISTORY_PAGE, 1), MAX_HISTORY_PAGE)
        const offset = intParam(query, 'offset') ?? 0
        const page = await withDatabase(id, (db) => new SqliteDigestRuns(db).list(limit, offset))
        return { body: { total: page?.total ?? 0, items: (page?.items ?? []).map(summary) } }
      },
    },
    {
      method: 'GET',
      path: '/api/accounts/:id/history/:runId',
      handler: async ({ params }) => {
        const id = knownAccount(source, params)
        const raw = params.runId ?? ''
        if (!/^\d{1,15}$/.test(raw)) throw new HttpError(404, 'notFound')
        const found = await withDatabase(id, (db) => {
          const runs = new SqliteDigestRuns(db)
          const run = runs.get(Number(raw))
          if (run === null) return null
          return { run, digest: run.digestId === null ? null : runs.digest(run.digestId) }
        })
        if (found === null) throw new HttpError(404, 'notFound')
        const { run, digest } = found
        return {
          body: {
            ...summary(run),
            since: run.since,
            until: run.until,
            digest,
            failedConversations: run.failedConversations,
          },
        }
      },
    },
  ]
}
