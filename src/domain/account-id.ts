/**
 * The id of an account inside one installation (RF-03). It names a directory, so it is restricted to what is safe
 * as a path segment on every platform: lowercase letters, digits and dashes, starting with a letter or a digit,
 * 32 characters at most. No dots, slashes or spaces: an id can never climb out of its parent directory.
 */
export const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** The id used when the user gives none and the installation has no account yet. */
export const DEFAULT_ACCOUNT_ID = 'default'

export function isValidAccountId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID_PATTERN.test(value)
}
