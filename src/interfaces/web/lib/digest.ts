import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
import { fmt } from './i18n.js'
import type { DigestUi } from './state.js'

/** The line the card shows for how a digest asked for now goes. Tone: 'ok', 'working', 'warn' or 'error'. */
export function digestMessage(
  digest: DigestUi,
  texts: WebTexts,
): { text: string; tone: 'ok' | 'working' | 'warn' | 'error' } {
  const t = texts.ui.digest
  switch (digest.kind) {
    case 'requesting':
      return { text: t.running, tone: 'working' }
    case 'started':
      return { text: t.started, tone: 'working' }
    case 'deferred':
      return { text: t.deferred, tone: 'working' }
    case 'done': {
      const failed = digest.failed ?? 0
      const text =
        failed > 0
          ? fmt(t.doneFailed, { summarized: digest.summarized ?? 0, failed })
          : fmt(t.done, { summarized: digest.summarized ?? 0, parts: digest.parts ?? 0 })
      return { text, tone: failed > 0 ? 'warn' : 'ok' }
    }
    case 'empty':
      return { text: t.empty, tone: 'ok' }
    case 'busy':
      return { text: t.busy, tone: 'warn' }
    case 'failed':
      return { text: digestErrorText(digest.error, texts), tone: 'error' }
    case 'error': {
      return { text: errorText(digest.code, texts), tone: 'error' }
    }
  }
}

/** The text of a code of the API (`{ "error": code }`), or the generic one for a code the page does not know. */
export const errorText = (code: string | null | undefined, texts: WebTexts): string =>
  lookup(texts.errors, code, texts.errors.internal)

/** The text of an entry of a table of the catalog, or `fallback` for a code the page does not know (a newer daemon). */
function lookup(table: object, code: string | null | undefined, fallback: string): string {
  if (code === null || code === undefined || !Object.hasOwn(table, code)) return fallback
  return (table as Record<string, string>)[code] ?? fallback
}

/** Why a digest or a preview failed (`error` of the event), with the generic text when there is no code or it is new. */
export const digestErrorText = (code: string | null | undefined, texts: WebTexts): string =>
  lookup(texts.digestErrors, code, texts.ui.digest.failed)

/** Why a link failed. */
export const linkErrorText = (code: string | null | undefined, texts: WebTexts): string =>
  lookup(texts.linkErrors, code, texts.ui.link.failed)

/** Why an account is blocked. */
export const blockedText = (code: string | null | undefined, texts: WebTexts): string =>
  lookup(texts.ui.blockedReasons, code, texts.ui.states.blocked)

/** The label of a state. */
export const stateText = (state: string, texts: WebTexts): string => lookup(texts.ui.states, state, state)
