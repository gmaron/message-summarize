import type {
  AccountView,
  DigestErrorCode,
  DigestEventState,
  Language,
  LinkErrorCode,
  LinkPhase,
  PreviewView,
  SyncProgress,
} from './types.js'

/** How the page's link of one account stands. `qrSeq` changes whenever there is a new QR image to ask for. */
export interface LinkUi {
  readonly phase: LinkPhase
  readonly qrSeq: number
  readonly sync: SyncProgress | null
  readonly error: LinkErrorCode | null
  /** A code of the API when asking to link was refused. */
  readonly requestError: string | null
}

export interface DigestUi {
  readonly kind: 'requesting' | DigestEventState | 'error'
  readonly summarized?: number
  readonly failed?: number
  readonly parts?: number
  readonly error?: DigestErrorCode
  /** The code of the API when the request was refused. */
  readonly code?: string
}

export interface PreviewUi {
  readonly kind: 'idle' | 'running' | 'done' | 'empty' | 'failed' | 'error'
  readonly view?: PreviewView
  readonly error?: DigestErrorCode
  readonly code?: string
}

export interface AppState {
  readonly language: Language
  /** Null until the first answer. */
  readonly accounts: readonly AccountView[] | null
  readonly links: Readonly<Record<string, LinkUi>>
  readonly digests: Readonly<Record<string, DigestUi>>
  readonly previews: Readonly<Record<string, PreviewUi>>
  readonly connection: 'connecting' | 'online' | 'offline'
  /** The daemon refused the session: the page asks to open it again with `msum open`. */
  readonly unauthorized: boolean
  /** The code of the error that stopped the first load, if any. */
  readonly loadError: string | null
}

export const initialState = (language: Language): AppState => ({
  language,
  accounts: null,
  links: {},
  digests: {},
  previews: {},
  connection: 'connecting',
  unauthorized: false,
  loadError: null,
})

export const EMPTY_LINK: LinkUi = { phase: 'idle', qrSeq: 0, sync: null, error: null, requestError: null }

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

export const withLink = (
  state: AppState,
  id: string,
  change: Partial<LinkUi> | ((link: LinkUi) => LinkUi),
): AppState => {
  const current = state.links[id] ?? EMPTY_LINK
  const next = typeof change === 'function' ? change(current) : { ...current, ...change }
  return { ...state, links: { ...state.links, [id]: next } }
}
export const withDigest = (state: AppState, id: string, digest: DigestUi): AppState => ({
  ...state,
  digests: { ...state.digests, [id]: digest },
})
export const withPreview = (state: AppState, id: string, preview: PreviewUi): AppState => ({
  ...state,
  previews: { ...state.previews, [id]: preview },
})

const LINK_PHASES: readonly LinkPhase[] = ['idle', 'waitingQr', 'qr', 'syncing', 'done', 'failed']

/**
 * What an event of `GET /api/events` does to the state. Only the codes and counts the daemon sends are kept; an event of
 * a shape it does not know changes nothing.
 */
export function applyServerEvent(state: AppState, name: string, raw: unknown): AppState {
  const data = record(raw)
  const account = typeof data.account === 'string' ? data.account : null
  switch (name) {
    case 'accounts':
      return Array.isArray(data.accounts) ? { ...state, accounts: data.accounts as AccountView[] } : state
    case 'qr': {
      if (account === null) return state
      return withLink(state, account, (link) => ({
        ...link,
        phase: 'qr',
        qrSeq: Math.max(link.qrSeq + 1, num(data.seq) ?? 0),
        error: null,
        requestError: null,
      }))
    }
    case 'sync': {
      if (account === null) return state
      const sync = { chats: num(data.chats) ?? 0, messages: num(data.messages) ?? 0, done: data.done === true }
      return withLink(state, account, (link) => ({ ...link, phase: link.phase === 'done' ? 'done' : 'syncing', sync }))
    }
    case 'link': {
      if (account === null || !LINK_PHASES.includes(data.state as LinkPhase)) return state
      const phase = data.state as LinkPhase
      const error = typeof data.error === 'string' ? (data.error as LinkErrorCode) : null
      return withLink(state, account, (link) => ({
        ...link,
        phase,
        error,
        requestError: null,
        // a link that starts again does not show the progress of the previous one
        sync: phase === 'waitingQr' ? null : link.sync,
        qrSeq: phase === 'waitingQr' ? link.qrSeq + 1 : link.qrSeq,
      }))
    }
    case 'digest': {
      if (account === null || typeof data.state !== 'string') return state
      const kind = data.state as DigestEventState
      if (!['started', 'deferred', 'done', 'empty', 'failed', 'busy'].includes(kind)) return state
      return withDigest(state, account, {
        kind,
        ...(num(data.summarized) === undefined ? {} : { summarized: num(data.summarized) as number }),
        ...(num(data.failed) === undefined ? {} : { failed: num(data.failed) as number }),
        ...(num(data.parts) === undefined ? {} : { parts: num(data.parts) as number }),
        ...(typeof data.error === 'string' ? { error: data.error as DigestErrorCode } : {}),
      })
    }
    case 'preview': {
      if (account === null || !['done', 'empty', 'failed'].includes(data.state as string)) return state
      const previous = state.previews[account]
      return withPreview(state, account, {
        kind: data.state as 'done' | 'empty' | 'failed',
        // the content is asked for (it is not in the event); what was there stays until it arrives
        ...(previous?.view === undefined ? {} : { view: previous.view }),
        ...(typeof data.error === 'string' ? { error: data.error as DigestErrorCode } : {}),
      })
    }
    default:
      return state
  }
}

/** A preview as `GET .../preview` answers. */
export function previewFromView(view: PreviewView): PreviewUi {
  switch (view.state) {
    case 'none':
      return { kind: 'idle' }
    case 'running':
      return { kind: 'running' }
    default:
      return { kind: view.state, view, ...(view.error === undefined ? {} : { error: view.error }) }
  }
}

/** A link as `GET .../link` answers (it has no QR: the image is asked for). */
export function linkFromSnapshot(
  current: LinkUi,
  snapshot: { state: LinkPhase; sync?: SyncProgress; error?: LinkErrorCode },
): LinkUi {
  return {
    phase: snapshot.state,
    qrSeq: snapshot.state === 'qr' ? current.qrSeq + 1 : current.qrSeq,
    sync: snapshot.sync ?? null,
    error: snapshot.error ?? null,
    requestError: null,
  }
}
