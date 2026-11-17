import { isValidAccountId } from '../../../domain/account-id.js'
import type { WebStateName } from '../../../infrastructure/i18n/catalog.js'
import type { AccountView } from './types.js'

/** What the badge of the card says. An idle account with no number is "not linked". */
export function badgeOf(account: AccountView): WebStateName {
  return account.state === 'idle' && account.maskedNumber === null ? 'notLinked' : account.state
}

export interface AccountActions {
  readonly digest: boolean
  readonly preview: boolean
  readonly schedules: boolean
  /** Always: with an invalid configuration the dialog says what is wrong. */
  readonly settings: boolean
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
    settings: true,
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
