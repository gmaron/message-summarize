import { isValidAccountId } from '../domain/account-id.js'
import { HttpError, type Route } from '../interfaces/http/router.js'
import type { LogStore } from './log-store.js'
import { LOG_LEVELS, type LogLevel } from './logger.js'

export const DEFAULT_LOGS_PAGE = 200
export const MAX_LOGS_PAGE = 1000
/** `account=-` asks for the lines that belong to no account: the installation's own. An id can never be "-". */
export const INSTALLATION_FILTER = '-'

/**
 * `GET /api/logs?level=&account=&limit=&before=` (RF-75): the last lines of the daemon's log, newest first. `level` is
 * the lowest shown, `account` an account id or `-` for the installation's own lines, `before` the `seq` of the oldest
 * line the page already has. What is served went through the logger's allowlist: codes, counts and times, never chat
 * text or secrets (RNF-04). The lines are not a stream: the page learns that there are new ones from the `log` event.
 */
export function logRoutes(store: LogStore): Route[] {
  const intParam = (query: URLSearchParams, name: string): number | undefined => {
    const value = query.get(name)
    if (value === null || value === '') return undefined
    if (!/^\d{1,15}$/.test(value)) throw new HttpError(400, 'invalidRequest')
    return Number(value)
  }
  return [
    {
      method: 'GET',
      path: '/api/logs',
      handler: ({ query }) => {
        const level = query.get('level') ?? 'info'
        if (!LOG_LEVELS.includes(level as LogLevel)) throw new HttpError(400, 'invalidRequest')
        const accountParam = query.get('account')
        let account: string | null | undefined
        if (accountParam === null || accountParam === '') account = undefined
        else if (accountParam === INSTALLATION_FILTER) account = null
        else if (isValidAccountId(accountParam)) account = accountParam
        else throw new HttpError(400, 'invalidRequest')
        const limit = Math.min(Math.max(intParam(query, 'limit') ?? DEFAULT_LOGS_PAGE, 1), MAX_LOGS_PAGE)
        const before = intParam(query, 'before')
        const items = store.query({
          level: level as LogLevel,
          ...(account === undefined ? {} : { account }),
          limit,
          ...(before === undefined ? {} : { before }),
        })
        return { body: { boot: store.boot, items } }
      },
    },
  ]
}
