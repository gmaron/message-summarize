/**
 * The first-use setup wizard (RF-70) and the consent to an external provider (RNF-02). Pure rules: the order of the
 * steps and which providers send the text of the chats out of this machine.
 */

/**
 * The steps, in order. `link` holds the QR and the sync of the history (RF-70 names them apart, but they are one
 * linking: the page shows the QR, then the progress). `done` is the last screen: leaving it completes the setup.
 */
export const SETUP_STEPS = ['language', 'name', 'provider', 'transcription', 'link', 'schedule', 'done'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export const isSetupStep = (value: unknown): value is SetupStep =>
  typeof value === 'string' && (SETUP_STEPS as readonly string[]).includes(value)

export const stepIndex = (step: SetupStep): number => SETUP_STEPS.indexOf(step)

/** The step after `step`, or null after the last one. */
export const nextStep = (step: SetupStep): SetupStep | null => SETUP_STEPS[stepIndex(step) + 1] ?? null

/** True when `target` comes before `from` (the wizard only goes back to a step already passed). */
export const isEarlier = (target: SetupStep, from: SetupStep): boolean => stepIndex(target) < stepIndex(from)

/**
 * The version of the disclosure text the user agrees to (RNF-02). Raise it when what is sent, to whom or what the provider
 * does with it changes: a consent given for an older version no longer counts.
 *
 * 1: the first text (the wizard). 2: the text lists the phone numbers of unsaved contacts and the transcripts of voice
 * notes among what is sent, and the consent is also keyed by the hosts that were disclosed.
 */
export const CONSENT_TEXT_VERSION = 2

/** The hosts as they are stored in a consent: unique, sorted and comma-joined, so the same list always gives the same key. */
export const consentHostsKey = (hosts: readonly string[]): string => [...new Set(hosts)].sort().join(',')

/**
 * The provider kinds whose hosts are fixed by the program (the table of `provider-info`): a consent for one of them was
 * recorded with no hosts before the hosts were part of the key, and that is still the same consent. A kind that depends
 * on what the user configures (a compatible server, a generic command, a remote Ollama) is not here: its consent must carry
 * the exact key of what was disclosed.
 */
export const FIXED_HOSTS_KINDS: readonly string[] = ['openai', 'anthropic', 'gemini', 'claude-cli']

/** A recorded consent, as the repository holds it. */
export interface StoredConsent {
  readonly provider: string
  readonly hosts: string
  readonly textVersion: number
}

/**
 * True when a recorded consent covers the configuration in force (RNF-02). The ONE rule that `doctor`, `provider ls`, the
 * wizard and the settings use: the kind is the same, the disclosure text is the current one (new text, new consent), and
 * the hosts are the ones now (`hostsKey`), or, for a kind with fixed hosts, were not recorded.
 */
export function consentCovers(
  consent: StoredConsent,
  kind: string,
  hostsKey: string,
  currentVersion: number = CONSENT_TEXT_VERSION,
): boolean {
  if (consent.provider !== kind || consent.textVersion !== currentVersion) return false
  return consent.hosts === hostsKey || (consent.hosts === '' && FIXED_HOSTS_KINDS.includes(kind))
}

/**
 * The recipients that need the user's agreement before they get the text of the chats (RNF-02), by the key the consent is
 * recorded under: Claude Code (Anthropic), and an Ollama server that is not on this machine (whoever runs it).
 */
export const OLLAMA_REMOTE = 'ollama-remote'
export const EXTERNAL_PROVIDERS: readonly string[] = ['claude-cli', OLLAMA_REMOTE]

export const providerNeedsConsent = (key: string): boolean => EXTERNAL_PROVIDERS.includes(key)

/**
 * True when the host of the address is this machine: localhost, 127.0.0.0/8, ::1, or `host.docker.internal` (the Docker host,
 * which in the sandbox setup is the same machine; the same rule as `isOnMachine` of the provider table). An address that
 * cannot be read is not.
 */
export function isLoopbackUrl(value: string): boolean {
  // The core build has no URL class: the authority of an http(s) address is read by hand (no userinfo, no port).
  const match = /^https?:\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)(?::\d*)?(?:[/?#]|$)/i.exec(value.trim())
  const host = match?.[1]?.toLowerCase() ?? ''
  return host === 'localhost' || host === 'host.docker.internal' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)
}

/**
 * The key of the consent a provider needs, or null when it needs none: Claude Code always; Ollama only when its address is
 * not loopback (then the text goes to another machine).
 */
export function consentKeyFor(provider: string, ollamaBaseUrl: string): string | null {
  if (provider === 'claude-cli') return 'claude-cli'
  if (provider === 'ollama' && !isLoopbackUrl(ollamaBaseUrl)) return OLLAMA_REMOTE
  return null
}
