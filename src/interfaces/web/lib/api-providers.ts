import type { ProviderName } from './types.js'

/**
 * The providers that are reached by an API with a key (RF-40): the wizard and the settings ask for a model, a key and, for
 * OpenAI only, an address of a compatible server. Pure rules, shared by both pages.
 */
export const API_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const
export type ApiProvider = (typeof API_PROVIDERS)[number]

export const isApiProvider = (provider: string): provider is ApiProvider =>
  (API_PROVIDERS as readonly string[]).includes(provider)

/** The address OpenAI answers at when no other is given (the default of the configuration). */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** The origin of OpenAI itself: the address an agreement to `openai` is recorded for. */
export const OPENAI_ORIGIN = 'https://api.openai.com'

/** The name a stored key goes by (`msum secret`): `openai-compatible` is the key of any server that is not OpenAI itself. */
export type KeyName = 'openai' | 'openai-compatible' | 'anthropic' | 'gemini'

/** Where a key comes from, as the daemon says it. Never the key. */
export type KeyStatus =
  | { readonly present: false }
  | { readonly present: true; readonly source: 'env'; readonly name: string }
  | { readonly present: true; readonly source: 'accountFile' | 'file' }

export type KeyStatuses = Readonly<Record<KeyName, KeyStatus>>

/** The answer of storing a key: what the account has now, and which other source wins over the one just stored. */
export interface KeyStored {
  readonly stored: boolean
  readonly key: KeyStatus
  readonly overriddenBy: 'env' | 'accountFile' | null
}

/** The answer of removing a key. */
export interface KeyRemoved {
  readonly removed: boolean
  readonly key: KeyStatus
}

/** The origin of an address, or null when it cannot be read. */
export function originOf(url: string): string | null {
  try {
    return new URL(url.trim()).origin
  } catch {
    return null
  }
}

/** True when the address is OpenAI's own (the same rule as the daemon: by origin). Empty is the default, which is OpenAI's. */
export const isOpenAiUrl = (url: string): boolean => url.trim() === '' || originOf(url) === 'https://api.openai.com'

/** The key a provider uses for the address it will be reached at (`baseUrl` only matters for `openai`). */
export const keyNameOf = (provider: ApiProvider, baseUrl: string): KeyName =>
  provider === 'openai' ? (isOpenAiUrl(baseUrl) ? 'openai' : 'openai-compatible') : provider

/**
 * Who receives the key and the text: the kind of recipient (a name of the disclosure texts) and, for a server of the user's
 * choice, its address. What the page shows next to the key field and what it sends come from here, so they cannot differ.
 */
export interface Destination {
  readonly kind: KeyName
  /** The origin of the server, only for `openai-compatible`. */
  readonly origin: string | null
}

export function destinationOf(provider: ApiProvider, baseUrl: string): Destination {
  const kind = keyNameOf(provider, baseUrl)
  return { kind, origin: kind === 'openai-compatible' ? (originOf(baseUrl) ?? baseUrl.trim()) : null }
}

/** A text that identifies a destination (to tell whether the recipient of a typed key changed). */
export const destinationId = (destination: Destination): string => `${destination.kind}|${destination.origin ?? ''}`

/** The disclosure of a destination: the provider whose texts apply, and whether it is a compatible server. */
export const disclosureOf = (kind: KeyName): { provider: ApiProvider; compatible: boolean } =>
  kind === 'openai-compatible' ? { provider: 'openai', compatible: true } : { provider: kind, compatible: false }

/** The provider of the page that a consent key stands for (`openai-compatible` is OpenAI pointed elsewhere). */
export function providerOfConsentKey(key: string): ProviderName | null {
  switch (key) {
    case 'claude-cli':
    case 'openai':
    case 'anthropic':
    case 'gemini':
      return key
    case 'openai-compatible':
      return 'openai'
    case 'ollama-remote':
      return 'ollama'
    default:
      return null
  }
}

/** The body of a test with a key typed in the page: the key goes with the name of the slot it is for (`keyProvider`). */
export function withTypedKey(
  body: { provider: string; options: Record<string, string>; consent?: string },
  provider: ApiProvider,
  destination: Destination,
  typed: string,
): { provider: string; options: Record<string, string>; consent?: string; key?: string; keyProvider?: string } {
  const key = typed.trim()
  if (key === '') return body
  // `keyProvider` says which key the typed one is: the daemon checks it against the address it will really use.
  return { ...body, key, ...(provider === 'openai' ? { keyProvider: destination.kind } : {}) }
}

/** The host (with its port) of an address, to name a recipient in a notice; null when it cannot be read. */
export function displayHostOf(url: string): string | null {
  try {
    return new URL(url.trim()).host || null
  } catch {
    return null
  }
}

/** True when the text is an http or https address (what the daemon accepts for a server). */
export function isHttpUrl(url: string): boolean {
  try {
    const { protocol, host } = new URL(url.trim())
    return (protocol === 'http:' || protocol === 'https:') && host !== ''
  } catch {
    return false
  }
}

/**
 * The address an agreement is recorded for, by its consent key. A server of the user's choice (`openai-compatible`,
 * `ollama-remote`) is recorded for the ORIGIN that the daemon named in the 409 that asked (the effective address after the
 * change: it may not be what the field says), and the daemon refuses it without one. OpenAI itself is always its own origin.
 * Undefined for the providers with a fixed recipient.
 */
export function consentAddress(key: string, origin: string | undefined): string | undefined {
  if (key === 'openai') return OPENAI_ORIGIN
  if (key === 'openai-compatible' || key === 'ollama-remote') return origin
  return undefined
}

/** Where `openai` goes with the form as it is, and whether the page can tell. */
export interface OpenAiTarget {
  /** The effective address, or null when it is the installation's and the page cannot see it. */
  readonly address: string | null
  /** True when the address is a server and not OpenAI itself. Meaningless when `address` is null. */
  readonly compatible: boolean
}

/**
 * The address OpenAI will have after saving the settings. An empty field removes the account's own address, so the
 * installation's (or OpenAI's) applies: that is the one in force now unless the account had its own, and then it is unknown.
 */
export function openaiTarget(
  typed: string,
  saved: string,
  source: 'account' | 'installation' | 'default' | undefined,
): OpenAiTarget {
  const text = typed.trim()
  if (text !== '') return { address: text, compatible: !isOpenAiUrl(text) }
  if (source === 'account') return { address: null, compatible: false }
  return { address: saved, compatible: !isOpenAiUrl(saved) }
}
