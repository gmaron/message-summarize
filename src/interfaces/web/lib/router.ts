/**
 * The pages of the web and the hash addresses they live at. Hand-written and tiny: the address is `#/path?query`, the
 * path is made of readable words, an address nobody knows goes to the home page. Nothing here touches the document: the
 * pieces are pure (`parseRoute`, `hrefOf`) except `watchHash`, which only needs something shaped like `window`.
 */

export type AccountTab = 'resumen' | 'pedir' | 'conversaciones' | 'horarios' | 'historial' | 'ajustes'

export const ACCOUNT_TABS: readonly AccountTab[] = [
  'resumen',
  'pedir',
  'conversaciones',
  'horarios',
  'historial',
  'ajustes',
]

export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'add' }
  | { readonly name: 'logs'; readonly account: string | null }
  | { readonly name: 'account'; readonly id: string; readonly tab: AccountTab }
  | { readonly name: 'run'; readonly id: string; readonly runId: number }
  | { readonly name: 'prompt'; readonly id: string }
  | { readonly name: 'preview'; readonly id: string }
  | { readonly name: 'link'; readonly id: string }

const HOME: Route = { name: 'home' }

const decode = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/** The route of an address (`location.hash`, with or without the `#`). Anything that is not a page is the home page. */
export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const cut = raw.indexOf('?')
  const path = cut < 0 ? raw : raw.slice(0, cut)
  const query = new URLSearchParams(cut < 0 ? '' : raw.slice(cut + 1))
  const parts = path.split('/').filter((part) => part !== '')

  if (parts.length === 0) return HOME
  if (parts[0] === 'logs' && parts.length === 1) {
    const account = query.get('cuenta')
    return { name: 'logs', account: account === null || account === '' ? null : account }
  }
  if (parts[0] === 'agregar-cuenta' && parts.length === 1) return { name: 'add' }
  if (parts[0] !== 'cuentas') return HOME

  const id = parts[1] === undefined ? null : decode(parts[1])
  if (id === null || id === '') return HOME
  const section = parts[2]
  if (parts.length === 2) return { name: 'account', id, tab: 'resumen' }
  if (parts.length === 3) {
    if (section === 'vista-previa') return { name: 'preview', id }
    if (section === 'vincular') return { name: 'link', id }
    if ((ACCOUNT_TABS as readonly string[]).includes(section ?? ''))
      return { name: 'account', id, tab: section as AccountTab }
    return HOME
  }
  if (parts.length === 4 && section === 'historial') {
    const runId = Number(parts[3])
    return Number.isInteger(runId) && runId > 0 ? { name: 'run', id, runId } : HOME
  }
  if (parts.length === 4 && section === 'ajustes' && parts[3] === 'prompt') return { name: 'prompt', id }
  return HOME
}

const enc = encodeURIComponent
const account = (id: string): string => `#/cuentas/${enc(id)}`

/** The address of a page. */
export function hrefOf(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/'
    case 'add':
      return '#/agregar-cuenta'
    case 'logs':
      return route.account === null ? '#/logs' : `#/logs?cuenta=${enc(route.account)}`
    case 'account':
      return route.tab === 'resumen' ? account(route.id) : `${account(route.id)}/${route.tab}`
    case 'run':
      return `${account(route.id)}/historial/${route.runId}`
    case 'prompt':
      return `${account(route.id)}/ajustes/prompt`
    case 'preview':
      return `${account(route.id)}/vista-previa`
    case 'link':
      return `${account(route.id)}/vincular`
  }
}

/** The account a route is about, or null for the pages that are about none. */
export function accountOfRoute(route: Route): string | null {
  switch (route.name) {
    case 'home':
    case 'add':
    case 'logs':
      return null
    default:
      return route.id
  }
}

/** The tab an account route belongs to (the run, the preview and the prompt hang from one). Null elsewhere. */
export function tabOfRoute(route: Route): AccountTab | null {
  switch (route.name) {
    case 'account':
      return route.tab
    case 'run':
      return 'historial'
    case 'prompt':
      return 'ajustes'
    case 'preview':
    case 'link':
      return 'resumen'
    default:
      return null
  }
}

/** The part of `window` that `watchHash` needs. */
export interface HashTarget {
  readonly location: { readonly hash: string }
  addEventListener(type: 'hashchange', listener: () => void): void
  removeEventListener(type: 'hashchange', listener: () => void): void
}

/** Calls `listener` with the route now and each time the address changes. Returns the way to stop. */
export function watchHash(target: HashTarget, listener: (route: Route) => void): () => void {
  const changed = (): void => listener(parseRoute(target.location.hash))
  target.addEventListener('hashchange', changed)
  changed()
  return () => target.removeEventListener('hashchange', changed)
}
