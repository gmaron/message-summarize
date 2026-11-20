/**
 * The id of an account inside one installation (RF-03). It names a directory, so it is restricted to what is safe
 * as a path segment on every platform: lowercase letters, digits and dashes, starting with a letter or a digit,
 * 32 characters at most. No dots, slashes or spaces: an id can never climb out of its parent directory.
 */
export const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** The id used when the user gives none and the installation has no account yet. */
export const DEFAULT_ACCOUNT_ID = 'default'

/** The longest id (the pattern above says 32). */
export const ACCOUNT_ID_MAX_LENGTH = 32

/**
 * The id a person's words turn into, for the pages that let anyone name an account ("Personal", "Mi trabajo", "Corporativo
 * Ñandú"): lowercase, accents and diacritics removed (ñ is n), spaces and underscores become a hyphen, any other character
 * is dropped, repeated hyphens collapse, and no hyphen is left at the ends. Cut to the longest id. Empty when nothing valid
 * is left (only symbols, an emoji). The daemon keeps its strict check (`isValidAccountId`): what this returns is valid or
 * empty, never anything else.
 */
export function normalizeAccountId(text: string): string {
  const id = text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, ACCOUNT_ID_MAX_LENGTH)
    .replace(/-+$/, '')
  return isValidAccountId(id) ? id : ''
}

export function isValidAccountId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID_PATTERN.test(value)
}
