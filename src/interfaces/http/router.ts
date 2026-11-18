import type { WebErrorCode } from '../../infrastructure/i18n/index.js'

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RouteRequest {
  /** The `:name` segments of the path, decoded. */
  readonly params: Readonly<Record<string, string>>
  readonly query: URLSearchParams
  /** The parsed JSON body, or undefined when there was none. */
  readonly body: unknown
}

export interface RouteResult {
  /** Default 200. */
  readonly status?: number
  /** Sent as JSON. */
  readonly body?: unknown
  /** Sent as is, with this content type, instead of `body` (the QR as an image). */
  readonly raw?: { readonly type: string; readonly text: string }
}

export interface Route {
  readonly method: RouteMethod
  /** Under `/api`, with `:name` segments: "/api/accounts/:id". */
  readonly path: string
  handler(request: RouteRequest): Promise<RouteResult> | RouteResult
}

/** Thrown by a handler to answer with an error: the status and a code, never text (the web translates the code). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: WebErrorCode,
  ) {
    super(code)
    this.name = 'HttpError'
  }
}

export type RouteMatch =
  | { readonly kind: 'found'; readonly route: Route; readonly params: Record<string, string> }
  | { readonly kind: 'methodNotAllowed' }
  | { readonly kind: 'notFound' }

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const wanted = pattern.split('/')
  const actual = pathname.split('/')
  if (wanted.length !== actual.length) return null
  const params: Record<string, string> = {}
  for (const [index, segment] of wanted.entries()) {
    const value = actual[index] as string
    if (segment.startsWith(':')) {
      if (value === '') return null
      try {
        params[segment.slice(1)] = decodeURIComponent(value)
      } catch {
        return null
      }
    } else if (segment !== value) return null
  }
  return params
}

/** The route for a method and path: found, the path exists for other methods only, or nothing. */
export function matchRoute(routes: readonly Route[], method: string, pathname: string): RouteMatch {
  let pathExists = false
  for (const route of routes) {
    const params = matchPath(route.path, pathname)
    if (params === null) continue
    if (route.method === method) return { kind: 'found', route, params }
    pathExists = true
  }
  return pathExists ? { kind: 'methodNotAllowed' } : { kind: 'notFound' }
}
