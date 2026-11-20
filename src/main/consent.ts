import { createHash } from 'node:crypto'
import { CONSENT_TEXT_VERSION, consentHostsKey, OLLAMA_REMOTE } from '../domain/setup.js'
import { isOnMachine, isOpenAiHost, PROVIDER_INFO, type ProviderInfoKind } from '../infrastructure/llm/index.js'
import type { ConsentRecord, SqliteSetupRepository } from '../infrastructure/persistence/sqlite/index.js'
import type { AppConfig, ProviderKind } from './config.js'

/**
 * The consent to send the chats to a provider (RNF-02), in one place: what each provider needs to have been disclosed, and
 * how a consent is recorded and found. `msum provider use`, the web wizard, the web settings, `provider ls` and `doctor` all
 * come here, so one rule says whether a consent is still good (see `consentCovers` in the domain).
 */

export const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/** Which kind of the table the primary or the backup of the configuration is (`openai` depends on its `baseUrl`). */
export function kindOfProvider(config: AppConfig, provider: ProviderKind | null): ProviderInfoKind | null {
  if (provider === null) return null
  if (provider === 'openai') return isOpenAiHost(config.provider.openai.baseUrl) ? 'openai' : 'openai-compatible'
  return provider
}

/**
 * Whether the chats go out of this machine with this provider. Every provider but Ollama sends them out; Ollama only when its
 * base URL is not on this machine (a server of the user's, but on another computer).
 *
 * RF-43 is not touched by this: "local only" conversations still go to the configured Ollama even when it is remote,
 * because it is the user's own server. "Local only" means "your Ollama server": use a loopback URL if it must be on this
 * machine.
 */
export function leavesMachine(kind: ProviderInfoKind, config: AppConfig): boolean {
  if (kind === 'ollama') return !isOnMachine(config.provider.ollama.baseUrl)
  return PROVIDER_INFO[kind].dataLeaves
}

/**
 * True for a provider that sends the chats out and can run: the ones whose activation needs the consent of RNF-02. (The
 * disabled presets send nothing because they never run.)
 */
export const needsConsent = (kind: ProviderInfoKind, config: AppConfig): boolean =>
  leavesMachine(kind, config) && kind !== 'gemini-cli' && kind !== 'codex-cli'

/**
 * The key of what was disclosed for a kind: the hosts of the table; the ORIGIN of the base URL for a compatible server
 * and for a remote Ollama; and for the generic CLI a hash of its command (the disclosure shows the command, so changing
 * it needs a new consent). Pointing a provider somewhere else therefore needs a new consent.
 *
 * Consent is RECORDED by `msum provider use` and by the web, and made VISIBLE by `doctor` (a warning when it is missing),
 * but it never blocks a digest: writing config.json by hand is the expert path, and an installation configured that way (the
 * author's, with claude-cli) must keep working. The guided path records consent; doctor shows the gap.
 */
export function consentHosts(kind: ProviderInfoKind, config: AppConfig): string[] {
  if (kind === 'openai-compatible') return [originOf(config.provider.openai.baseUrl)]
  if (kind === 'ollama') return [originOf(config.provider.ollama.baseUrl)]
  if (kind === 'generic-cli') {
    const command = JSON.stringify(config.provider.genericCli.command ?? [])
    return [`cmd:${createHash('sha256').update(command).digest('hex')}`]
  }
  return [...PROVIDER_INFO[kind].hosts]
}

/** What a consent is recorded under: the kind of the table and the key of the hosts that were disclosed. */
export interface ConsentTarget {
  readonly kind: ProviderInfoKind
  readonly hosts: string
}

/** The consent that `kind` needs with this configuration, or null when it needs none. */
export function consentTarget(kind: ProviderInfoKind, config: AppConfig): ConsentTarget | null {
  return needsConsent(kind, config) ? { kind, hosts: consentHostsKey(consentHosts(kind, config)) } : null
}

/**
 * The consent that covers this provider as configured now, or null (see `consentCovers`: the same kind, the current
 * disclosure text and the same hosts). The ONE check, used by `provider ls`, `doctor`, the wizard and the settings.
 */
export function findConsent(
  setup: SqliteSetupRepository,
  account: string,
  kind: ProviderInfoKind,
  config: AppConfig,
): ConsentRecord | null {
  const target = consentTarget(kind, config)
  return target === null ? null : setup.findConsent(account, target.kind, target.hosts, CONSENT_TEXT_VERSION)
}

/** Records that the user accepted what is disclosed for `kind` as configured (the current text and hosts). */
export function recordConsent(
  setup: SqliteSetupRepository,
  account: string,
  kind: ProviderInfoKind,
  config: AppConfig,
): void {
  const target = consentTarget(kind, config)
  if (target !== null) setup.recordConsent(account, target.kind, CONSENT_TEXT_VERSION, target.hosts)
}

/**
 * The web names a consent by a key (`consentKeyFor` of the domain: `claude-cli`, `ollama-remote` for an Ollama that is not on
 * this machine, `openai`, `openai-compatible`, `anthropic`, `gemini`). This is the kind of the table that the key stands for.
 */
export const kindOfConsentKey = (key: string): ProviderInfoKind | null => {
  if (key === OLLAMA_REMOTE) return 'ollama'
  return (
    (['claude-cli', 'openai', 'openai-compatible', 'anthropic', 'gemini'] as const).find((kind) => kind === key) ?? null
  )
}

/**
 * The kind a web key applies to for this configuration, or null: `openai` and `openai-compatible` are the same provider
 * told apart by its address, so each applies only when `provider.openai.baseUrl` says so.
 */
function applicableKind(key: string, config: AppConfig): ProviderInfoKind | null {
  const kind = kindOfConsentKey(key)
  if (kind === 'openai' || kind === 'openai-compatible') return kindOfProvider(config, 'openai') === kind ? kind : null
  return kind
}

/**
 * Where the consent named by a web key stands for this configuration: `notNeeded` (the key does not apply, for example an
 * Ollama that is on this machine), `given` (a recorded consent covers it) or `missing`.
 */
export function consentStateOfKey(
  setup: SqliteSetupRepository,
  account: string,
  key: string,
  config: AppConfig,
): 'notNeeded' | 'given' | 'missing' {
  const kind = applicableKind(key, config)
  if (kind === null || consentTarget(kind, config) === null) return 'notNeeded'
  return findConsent(setup, account, kind, config) === null ? 'missing' : 'given'
}

/**
 * The origin that receives the text for a consent key, for the keys whose recipient is a server of the user's choice
 * (`openai-compatible`, `ollama-remote`): the effective address after the change that asked. The page shows it in the
 * notice and sends it back to record the agreement, so what is recorded is always what was shown. Undefined for the
 * keys whose recipient is fixed.
 */
export function consentOriginOf(key: string, config: AppConfig): string | undefined {
  if (key === OLLAMA_REMOTE) return originOf(config.provider.ollama.baseUrl)
  if (key === 'openai-compatible') return originOf(config.provider.openai.baseUrl)
  return undefined
}

/** The body of a 409 `consentRequired`: the key and, for a server of the user's choice, its origin. */
export const consentRequiredBody = (key: string, config: AppConfig): Record<string, string> => {
  const origin = consentOriginOf(key, config)
  return { error: 'consentRequired', provider: key, ...(origin === undefined ? {} : { origin }) }
}

/** Records the consent named by a web key for this configuration. False when the key does not apply to it. */
export function recordConsentOfKey(
  setup: SqliteSetupRepository,
  account: string,
  key: string,
  config: AppConfig,
): boolean {
  const kind = applicableKind(key, config)
  if (kind === null || consentTarget(kind, config) === null) return false
  recordConsent(setup, account, kind, config)
  return true
}
