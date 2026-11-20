import {
  consentKeyFor,
  providerNeedsConsent,
  SETUP_STEPS,
  SETUP_STEPS_SHOWN,
  type SetupStep,
  stepIndex,
} from '../../../domain/setup.js'
import { accountIdFrom } from './accounts.js'
import { isApiProvider, isHttpUrl, isOpenAiUrl, OPENAI_BASE_URL, originOf } from './api-providers.js'
import type { Language, ProviderName } from './types.js'

/** What the wizard holds while the user fills it in. Text fields are text until they are sent. */
export interface WizardDraft {
  readonly language: Language
  readonly ownerName: string
  readonly accountId: string
  readonly provider: ProviderName | ''
  readonly claudeModel: string
  readonly ollamaBaseUrl: string
  readonly ollamaModel: string
  /** The address Ollama has when its field is emptied (what the daemon says: the installation's, or the default). */
  readonly ollamaInherited: string
  /** The address of an OpenAI-compatible server as typed; empty keeps the one in force (`openaiInherited`). */
  readonly openaiBaseUrl: string
  /** The address `openai` has in the configuration of the account (its own, the installation's or OpenAI's). */
  readonly openaiInherited: string
  readonly openaiModel: string
  readonly anthropicModel: string
  readonly geminiModel: string
  /** The box of the agreement to send the text of the chats to an external provider (RNF-02). */
  readonly consent: boolean
}

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
export const OWNER_NAME_MAX = 80

export const emptyDraft = (language: Language): WizardDraft => ({
  language,
  ownerName: '',
  // Empty on purpose: the user names the account (no "default" is suggested).
  accountId: '',
  provider: '',
  claudeModel: '',
  ollamaBaseUrl: DEFAULT_OLLAMA_URL,
  ollamaModel: '',
  ollamaInherited: DEFAULT_OLLAMA_URL,
  openaiBaseUrl: '',
  openaiInherited: OPENAI_BASE_URL,
  openaiModel: '',
  anthropicModel: '',
  geminiModel: '',
  consent: false,
})

/** The providers the wizard offers (Codex and the generic CLI are chosen with `msum provider use`). */
export const WIZARD_PROVIDERS: readonly ProviderName[] = ['claude-cli', 'ollama', 'openai', 'anthropic', 'gemini']

/** True for the consent keys (RNF-02): Claude Code, and an Ollama server that is not on this machine. */
export const needsConsent = (key: string): boolean => providerNeedsConsent(key)

/** The host of an address, or null when it cannot be read. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url.trim()).hostname || null
  } catch {
    return null
  }
}

/** The address Ollama will be reached at: the one typed, or the one the daemon says an empty field gives (never a guess). */
export const ollamaUrlOf = (draft: Pick<WizardDraft, 'ollamaBaseUrl' | 'ollamaInherited'>): string =>
  draft.ollamaBaseUrl.trim() === '' ? draft.ollamaInherited : draft.ollamaBaseUrl
const baseUrlOf = ollamaUrlOf

/** The address `openai` will be reached at: the one typed, or the one in force when the field is empty. */
export const openaiUrlOf = (draft: Pick<WizardDraft, 'openaiBaseUrl' | 'openaiInherited'>): string =>
  draft.openaiBaseUrl.trim() === '' ? draft.openaiInherited : draft.openaiBaseUrl.trim()

/**
 * The consent the choice needs, by its key, or null when it needs none: Claude Code, Anthropic and Gemini always; OpenAI
 * always (`openai` for OpenAI itself, `openai-compatible` for any other address, even on this machine); Ollama only when
 * its address is not loopback (the text goes to another machine).
 */
export const consentKeyOf = (draft: WizardDraft): string | null =>
  draft.provider === '' ? null : consentKeyFor(draft.provider, baseUrlOf(draft), isOpenAiUrl(openaiUrlOf(draft)))

/**
 * Who would get the text, as one value: the consent key, and for a server of the user's choice (a remote Ollama, a
 * compatible server) its origin. An agreement given for one recipient does not carry over to another, even of the same key.
 */
export function recipientOf(provider: ProviderName | '', ollamaBaseUrl: string, openaiBaseUrl: string): string | null {
  if (provider === '') return null
  const key = consentKeyFor(provider, ollamaBaseUrl, isOpenAiUrl(openaiBaseUrl))
  if (key === null) return null
  const address = key === 'ollama-remote' ? ollamaBaseUrl : key === 'openai-compatible' ? openaiBaseUrl : null
  return address === null ? key : `${key}|${originOf(address) ?? address.trim()}`
}

export const recipientOfDraft = (draft: WizardDraft): string | null =>
  recipientOf(draft.provider, baseUrlOf(draft), openaiUrlOf(draft))

/** The draft with `next` applied. An agreement given for another recipient does not carry over. */
function changed(draft: WizardDraft, next: WizardDraft): WizardDraft {
  return recipientOfDraft(next) === recipientOfDraft(draft) ? next : { ...next, consent: false }
}

/** The draft with another Ollama address. */
export const withBaseUrl = (draft: WizardDraft, ollamaBaseUrl: string): WizardDraft =>
  changed(draft, { ...draft, ollamaBaseUrl })

/** The draft with another address for OpenAI (a compatible server): the agreement is asked again. */
export const withOpenAiBaseUrl = (draft: WizardDraft, openaiBaseUrl: string): WizardDraft =>
  changed(draft, { ...draft, openaiBaseUrl })

export type StepState = 'done' | 'current' | 'todo'

/** The indicator: the steps the page shows (not the closing screen), numbered from 1, and whether each is behind, current or ahead. */
export function stepIndicator(current: SetupStep): { step: SetupStep; number: number; state: StepState }[] {
  const at = stepIndex(current)
  return SETUP_STEPS_SHOWN.map((step, index) => ({
    step,
    number: index + 1,
    state: index < at ? 'done' : index === at ? 'current' : 'todo',
  }))
}

/** The step the Back button goes to, or null on the first. */
export const previousStep = (step: SetupStep): SetupStep | null => SETUP_STEPS[stepIndex(step) - 1] ?? null

export type NameIssue = 'ownerBlank' | 'ownerTooLong' | 'invalidAccountId'

/** What is wrong with the name step, checked as the daemon checks it (the account id is not asked again once created). */
export function nameIssue(draft: WizardDraft, accountLocked: boolean): NameIssue | null {
  const name = draft.ownerName.trim()
  if (name === '') return 'ownerBlank'
  if (name.length > OWNER_NAME_MAX) return 'ownerTooLong'
  // Anyone may write the name as they like: it only fails when nothing valid is left once it is turned into an id.
  if (!accountLocked && accountIdFrom(draft.accountId) === '') return 'invalidAccountId'
  return null
}

/** The body that saves the name step. The id is sent only while the account does not exist yet. */
export const nameBody = (draft: WizardDraft, accountLocked: boolean, timezone?: string): Record<string, unknown> => ({
  from: 'you',
  language: draft.language,
  ...(timezone === undefined ? {} : { timezone }),
  ownerName: draft.ownerName.trim(),
  ...(accountLocked ? {} : { accountId: accountIdFrom(draft.accountId) }),
})

export type ProviderIssue = 'choose' | 'openaiAddress' | 'consent' | 'ollamaModel' | 'apiModel'

/** True when the address OpenAI would be reached at is not an http or https address (so no recipient can be shown). */
export const openaiAddressInvalid = (draft: Pick<WizardDraft, 'openaiBaseUrl' | 'openaiInherited'>): boolean =>
  !isHttpUrl(openaiUrlOf(draft))

/**
 * The origin that receives the text with the draft as it is, for the recipients named by their address (a compatible server,
 * a remote Ollama); null for the others. What the notice shows, and what a 409 from the daemon is compared with.
 */
export function shownOriginOf(draft: WizardDraft): string | null {
  const key = consentKeyOf(draft)
  if (key === 'openai-compatible') return originOf(openaiUrlOf(draft))
  if (key === 'ollama-remote') return originOf(baseUrlOf(draft))
  return null
}

/** The model typed for an API provider (trimmed). */
export const modelOf = (draft: WizardDraft): string =>
  (draft.provider === 'openai'
    ? draft.openaiModel
    : draft.provider === 'anthropic'
      ? draft.anthropicModel
      : draft.provider === 'gemini'
        ? draft.geminiModel
        : ''
  ).trim()

/** What keeps the provider step from continuing (or testing). Null when nothing does. */
export function providerIssue(draft: WizardDraft): ProviderIssue | null {
  if (draft.provider === '') return 'choose'
  // An address that is not a web address names no recipient: nothing is shown or agreed to until it is one.
  if (draft.provider === 'openai' && openaiAddressInvalid(draft)) return 'openaiAddress'
  if (consentKeyOf(draft) !== null && !draft.consent) return 'consent'
  if (draft.provider === 'ollama' && draft.ollamaModel.trim() === '') return 'ollamaModel'
  if (isApiProvider(draft.provider) && modelOf(draft) === '') return 'apiModel'
  return null
}

/** The `options` of the chosen provider: only what the user typed (an empty field keeps the default of the configuration). */
export function providerOptions(draft: WizardDraft): Record<string, string> {
  const options: Record<string, string> = {}
  const put = (key: string, value: string): void => {
    if (value.trim() !== '') options[key] = value.trim()
  }
  if (draft.provider === 'claude-cli') put('model', draft.claudeModel)
  if (draft.provider === 'ollama') {
    put('baseUrl', draft.ollamaBaseUrl)
    put('model', draft.ollamaModel)
  }
  // Only OpenAI has an address of its own: the others have a fixed host (a baseUrl for them is a 400).
  if (draft.provider === 'openai') put('baseUrl', draft.openaiBaseUrl)
  if (isApiProvider(draft.provider)) put('model', modelOf(draft))
  return options
}

/** The body that saves the provider step, with the consent when the provider needs it. */
export const providerBody = (draft: WizardDraft): Record<string, unknown> => ({
  from: 'provider',
  provider: draft.provider,
  options: providerOptions(draft),
  ...consentField(draft),
})

/**
 * The agreement, as the daemon wants it: the KEY of the recipient the user saw (`claude-cli`, `openai`, `openai-compatible`,
 * `anthropic`, `gemini`, `ollama-remote`), never a bare `true`, so an agreement for one recipient is never taken for another.
 */
const consentField = (draft: WizardDraft): { consent?: string } => {
  const key = consentKeyOf(draft)
  return key !== null && draft.consent ? { consent: key } : {}
}

/** The body of "Test connection" (a key typed in the page is added by `withTypedKey`, only for the test that sends it). */
export const testBody = (
  draft: WizardDraft,
): { provider: string; options: Record<string, string>; consent?: string } => ({
  provider: draft.provider,
  options: providerOptions(draft),
  ...consentField(draft),
})
