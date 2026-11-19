import { isValidAccountId } from '../../../domain/account-id.js'
import type { WebStateName, WebTexts } from '../../../infrastructure/i18n/catalog.js'
import { whenText } from './format.js'
import { fmt } from './i18n.js'
import type { DigestUi } from './state.js'
import type { AccountView } from './types.js'

/** What the badge of the card says. An idle account with no number is "not linked". */
export function badgeOf(account: AccountView): WebStateName {
  return account.state === 'idle' && account.maskedNumber === null ? 'notLinked' : account.state
}

export interface AccountActions {
  readonly digest: boolean
  readonly preview: boolean
  readonly schedules: boolean
  /** The conversations are in the database of the account: the configuration must be valid to read it as the daemon does. */
  readonly conversations: boolean
  /** The prompt is read through the configuration of the account: it must be valid. */
  readonly prompt: boolean
  /** Opens the link dialog: the account is not linked, or a link is in progress. */
  readonly link: boolean
  /** The daemon says that linking again fixes the block. */
  readonly relink: boolean
  /** The daemon says that retrying fixes the block. */
  readonly retry: boolean
}

/**
 * Which buttons a card offers, from the state of its account. What fixes a block is the daemon's to say (`fix`, by the
 * same rules its routes apply): the page does not repeat them. The daemon still decides each request.
 */
export function accountActions(account: AccountView): AccountActions {
  return {
    digest: ['connected', 'connecting', 'reconnecting'].includes(account.state),
    preview: account.configValid && account.maskedNumber !== null && account.state !== 'linking',
    schedules: account.configValid,
    conversations: account.configValid,
    prompt: account.configValid,
    link:
      account.configValid &&
      (account.state === 'linking' || (account.state === 'idle' && account.maskedNumber === null)),
    relink: account.configValid && account.fix === 'relink',
    retry: account.configValid && account.fix === 'retry',
  }
}

/** When retrying is allowed, if it is not yet at `now` (epoch ms); null when it can be done. */
export function retryWaitUntil(account: AccountView, now: number): number | null {
  return account.retryAfter !== null && account.retryAfter > now ? account.retryAfter : null
}

/** The id typed to add an account, checked as the daemon checks it. */
export const isAccountIdValid = (value: string): boolean => isValidAccountId(value)

/** What the pill of an account says and how it looks. */
export type PillTone = 'ok' | 'bad' | 'busy' | 'idle'

export type PillKey = WebStateName | 'sessionClosed' | 'invalidConfig' | 'running'

/** A block that only linking again fixes: the session is closed, so the pill says so. */
const SESSION_REASONS: readonly string[] = ['loggedOut', 'noAccount', 'notLinked', 'mismatch']

/** Whether the account needs its owner: it is blocked, or its configuration is broken. These go first. */
export const hasProblem = (account: AccountView): boolean => !account.configValid || account.state === 'blocked'

/** The pill of an account: its state, or what is wrong, or that a digest is being made. */
export function pillOf(account: AccountView, running: boolean): { tone: PillTone; key: PillKey } {
  if (!account.configValid) return { tone: 'bad', key: 'invalidConfig' }
  if (account.state === 'blocked') {
    return { tone: 'bad', key: SESSION_REASONS.includes(account.blockedReason ?? '') ? 'sessionClosed' : 'blocked' }
  }
  if (running && account.state === 'connected') return { tone: 'busy', key: 'running' }
  const key = badgeOf(account)
  switch (key) {
    case 'connected':
      return { tone: 'ok', key }
    case 'connecting':
    case 'reconnecting':
    case 'linking':
      return { tone: 'busy', key }
    default:
      return { tone: 'idle', key }
  }
}

/** Accounts with a problem first, the rest in the order the daemon gives them. */
export const problemsFirst = (accounts: readonly AccountView[]): AccountView[] => [
  ...accounts.filter(hasProblem),
  ...accounts.filter((account) => !hasProblem(account)),
]

/** The letter of the avatar. */
export const initialOf = (id: string): string => (id.trim().charAt(0) || '?').toUpperCase()

/** The word of a pill. */
export function pillText(key: PillKey, texts: WebTexts): string {
  if (key === 'sessionClosed' || key === 'invalidConfig' || key === 'running') return texts.ui.pills[key]
  return texts.ui.states[key]
}

/** The one action that fixes what is wrong with an account (the daemon says which), or null when nothing is wrong. */
export function fixKind(account: AccountView): 'relink' | 'retry' | 'link' | 'settings' | null {
  const actions = accountActions(account)
  if (actions.relink) return 'relink'
  if (actions.retry) return 'retry'
  if (actions.link) return 'link'
  if (!account.configValid) return 'settings'
  return null
}

/** A digest asked for now is being made (asked, or started and not finished). */
export const isDigestRunning = (digest: DigestUi | undefined): boolean =>
  digest?.kind === 'requesting' || digest?.kind === 'started'

/** The line under the name of an account in the rail: what is wrong, that it is working, or when comes the next digest. */
export function railStatus(
  account: AccountView,
  running: boolean,
  texts: WebTexts,
  now: number,
): { text: string; bad: boolean } {
  const pill = pillOf(account, running)
  if (pill.tone === 'bad') return { text: pillText(pill.key, texts), bad: true }
  if (running) return { text: texts.ui.shell.running, bad: false }
  if (account.nextRun === null) return { text: texts.ui.shell.noSchedules, bad: false }
  return {
    text: fmt(texts.ui.shell.next, { when: whenText(account.nextRun, account.timezone, texts.locale, now) }),
    bad: false,
  }
}
