const REDACTED = '[redacted]'

/** Shapes of the keys of the supported providers, removed even when the key itself is not known (a provider may echo a prefix). */
const KEY_SHAPES = [/\bsk-[A-Za-z0-9_-]{8,}/g, /\bAIza[A-Za-z0-9_-]{16,}/g]

/**
 * RNF-04: removes every secret from a text that is going to an error message, a log or the screen. Providers do echo
 * keys in their errors ("Incorrect API key provided: sk-abc..."), so the text of a provider is never passed on without this.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret !== undefined && secret !== '') result = result.split(secret).join(REDACTED)
  }
  for (const shape of KEY_SHAPES) result = result.replace(shape, REDACTED)
  return result
}
