/**
 * What a person needs to know before choosing a provider (RF-41, RNF-02): whether it charges, whether the chats leave
 * the machine, which hosts it connects to and where its data policy is. One entry per kind, and ONE source of truth: the
 * hosts here are the ones the README lists under "What the program connects to" (RNF-01), and a test checks that the two
 * agree. The words are in the i18n catalogs (`cli.provider`), not here.
 */

/** `openai-compatible` is the `openai` provider pointed at another server with `provider.openai.baseUrl`. */
export const PROVIDER_INFO_KINDS = [
  'claude-cli',
  'gemini-cli',
  'codex-cli',
  'generic-cli',
  'ollama',
  'openai',
  'openai-compatible',
  'anthropic',
  'gemini',
] as const
export type ProviderInfoKind = (typeof PROVIDER_INFO_KINDS)[number]

export const isProviderInfoKind = (value: string): value is ProviderInfoKind =>
  (PROVIDER_INFO_KINDS as readonly string[]).includes(value)

/**
 * `pay-per-use`: an API that bills each call. `your-plan`: a CLI that uses the plan you already have. `free-local`:
 * runs on your machine. `depends`: it is whatever your server or your command does.
 */
export type ProviderCharge = 'pay-per-use' | 'your-plan' | 'free-local' | 'depends'

/**
 * True when the host of a URL is this machine: `localhost`, a loopback address (127.0.0.0/8, ::1) or
 * `host.docker.internal`, the Docker host, which in our sandbox setup is the same machine. Anything else (a LAN address, a
 * name) is another computer, so a server there receives the chats even if the user runs it. Used for Ollama, whose
 * `baseUrl` the user chooses.
 */
export function isOnMachine(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === 'localhost' || host === 'host.docker.internal' || host === '[::1]' || host === '::1') return true
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return octets !== null && Number(octets[1]) === 127 && octets.slice(1).every((part) => Number(part) <= 255)
}

export interface ProviderInfo {
  readonly charge: ProviderCharge
  /**
   * True when the text of the chats is sent out of the machine (every provider but Ollama; Ollama only when its base
   * URL is not on this machine, see `isOnMachine`).
   */
  readonly dataLeaves: boolean
  /**
   * The hosts it connects to (RNF-01). Empty: none that we know (Ollama, a disabled preset), or one the user chooses
   * (`openai-compatible`: the host of its `baseUrl`, `generic-cli`: whatever the command does).
   */
  readonly hosts: readonly string[]
  /** The data policy of the vendor, a link checked when it was written. Null when there is no vendor to ask. */
  readonly policyUrl: string | null
}

export const PROVIDER_INFO: Readonly<Record<ProviderInfoKind, ProviderInfo>> = {
  // Claude Code's own hosts, per https://code.claude.com/docs/en/network-config: the model requests, the sign-in and its
  // optional telemetry.
  'claude-cli': {
    charge: 'your-plan',
    dataLeaves: true,
    hosts: [
      'api.anthropic.com',
      'claude.ai',
      'claude.com',
      'platform.claude.com',
      'sso.claude.com',
      'http-intake.logs.us5.datadoghq.com',
      'browser-intake-us5-datadoghq.com',
    ],
    policyUrl: 'https://code.claude.com/docs/en/data-usage',
  },
  // Shipped disabled (RF-49): nothing is run, so nothing is contacted.
  'gemini-cli': { charge: 'your-plan', dataLeaves: true, hosts: [], policyUrl: null },
  'codex-cli': { charge: 'your-plan', dataLeaves: true, hosts: [], policyUrl: null },
  'generic-cli': { charge: 'depends', dataLeaves: true, hosts: [], policyUrl: null },
  ollama: { charge: 'free-local', dataLeaves: false, hosts: [], policyUrl: null },
  openai: {
    charge: 'pay-per-use',
    dataLeaves: true,
    hosts: ['api.openai.com'],
    policyUrl: 'https://developers.openai.com/api/docs/guides/your-data',
  },
  'openai-compatible': { charge: 'depends', dataLeaves: true, hosts: [], policyUrl: null },
  anthropic: {
    charge: 'pay-per-use',
    dataLeaves: true,
    hosts: ['api.anthropic.com'],
    policyUrl: 'https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training',
  },
  gemini: {
    charge: 'pay-per-use',
    dataLeaves: true,
    hosts: ['generativelanguage.googleapis.com'],
    policyUrl: 'https://aistudio.google.com/docs/logs-policy',
  },
}
