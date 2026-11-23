import type { FetchFn } from './api.js'

/** What `consumeToken` needs of the browser. */
export interface AuthEnv {
  readonly location: { readonly hash: string; readonly pathname: string; readonly search: string }
  readonly history: { replaceState(data: unknown, unused: string, url: string): void }
  readonly fetch: FetchFn
}

/**
 * `msum open` opens the page as `/#token=...`. The token is taken out of the address first (so it stays neither in the
 * bar nor in the history, whatever happens next) and exchanged for the session cookie. It is never stored by the page.
 * `none`: there was no token in the address. `rejected`: the daemon did not accept it. `failed`: it did not answer.
 */
export async function consumeToken(env: AuthEnv): Promise<'none' | 'ok' | 'rejected' | 'failed'> {
  const token = new URLSearchParams(env.location.hash.replace(/^#/, '')).get('token')
  if (token === null) return 'none'
  env.history.replaceState(null, '', env.location.pathname + env.location.search)
  try {
    const reply = await env.fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (reply.ok) return 'ok'
    return reply.status === 401 ? 'rejected' : 'failed'
  } catch {
    return 'failed'
  }
}

/**
 * The token out of what a person pasted: the token alone, or the whole link (`https://host/#token=...`), with blanks
 * around either. null when it is empty or cannot be a token (a token is only letters, digits, `-` and `_`).
 */
export function tokenFromInput(text: string): string | null {
  const trimmed = text.trim()
  const fromLink = /(?:^|[#?&])token=([^&#\s]*)/.exec(trimmed)
  const token = fromLink === null ? trimmed : (fromLink[1] as string)
  return /^[A-Za-z0-9_-]+$/.test(token) ? token : null
}
