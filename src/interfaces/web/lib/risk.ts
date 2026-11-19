/** The browser's tab storage, as much of it as the notice needs (injected so it can be tested). */
export interface RiskStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const KEY = 'msum.riskAccepted'

/**
 * Whether the legal notice was accepted in this tab. Only the browser remembers it (the daemon stores nothing about it),
 * and only for the tab's session: a storage that is missing or throws counts as "not accepted".
 */
export function riskAccepted(storage: RiskStorage | undefined): boolean {
  try {
    return storage?.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function rememberRisk(storage: RiskStorage | undefined): void {
  try {
    storage?.setItem(KEY, '1')
  } catch {
    // Without storage the box is asked for again: that is all.
  }
}

/** The notice is asked for only when a new account is linked, never to reconnect or link again one that was linked. */
export const linkNeedsNotice = (account: { readonly state: string; readonly maskedNumber: string | null }): boolean =>
  account.state === 'idle' && account.maskedNumber === null

/** The start button of a link that needs the notice is enabled once the box is checked. */
export const canStartLink = (needsNotice: boolean, checked: boolean): boolean => !needsNotice || checked

/**
 * A link that has not been started: nothing is known about it, or it is back to idle after a cancel (like the wizard's
 * 'start' view). Then a new account shows the notice again instead of a progress bar with no button.
 */
export const linkNotStarted = (
  link: { readonly phase: string; readonly requestError: string | null } | undefined,
): boolean => link === undefined || (link.phase === 'idle' && link.requestError === null)
