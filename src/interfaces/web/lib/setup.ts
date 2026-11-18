import { consentKeyFor, providerNeedsConsent, SETUP_STEPS, type SetupStep, stepIndex } from '../../../domain/setup.js'
import { isAccountIdValid } from './accounts.js'
import { EVERY_DAY, type ScheduleDraft } from './schedules.js'
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
  /** The box of the agreement to send the text of the chats to an external provider (RNF-02). */
  readonly consent: boolean
}

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
export const OWNER_NAME_MAX = 80

export const emptyDraft = (language: Language): WizardDraft => ({
  language,
  ownerName: '',
  accountId: 'default',
  provider: '',
  claudeModel: '',
  ollamaBaseUrl: DEFAULT_OLLAMA_URL,
  ollamaModel: '',
  consent: false,
})

/** The providers the wizard offers today (the API ones, Gemini, Codex and the generic CLI come in phase 3). */
export const WIZARD_PROVIDERS: readonly ProviderName[] = ['claude-cli', 'ollama']

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

/** The address Ollama will be reached at: the one typed, or the usual one when the field is empty. */
const baseUrlOf = (draft: WizardDraft): string =>
  draft.ollamaBaseUrl.trim() === '' ? DEFAULT_OLLAMA_URL : draft.ollamaBaseUrl

/**
 * The consent the choice needs, by its key, or null when it needs none: Claude Code always; Ollama only when its address
 * is not loopback (the text goes to another machine).
 */
export const consentKeyOf = (draft: WizardDraft): string | null =>
  draft.provider === '' ? null : consentKeyFor(draft.provider, baseUrlOf(draft))

/** The draft with another Ollama address. An agreement given for another recipient does not carry over. */
export function withBaseUrl(draft: WizardDraft, ollamaBaseUrl: string): WizardDraft {
  const next = { ...draft, ollamaBaseUrl }
  return consentKeyOf(next) === consentKeyOf(draft) ? next : { ...next, consent: false }
}

export type StepState = 'done' | 'current' | 'todo'

/** The indicator: every step, numbered from 1, and whether it is behind, current or ahead. */
export function stepIndicator(current: SetupStep): { step: SetupStep; number: number; state: StepState }[] {
  const at = stepIndex(current)
  return SETUP_STEPS.map((step, index) => ({
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
  if (!accountLocked && !isAccountIdValid(draft.accountId.trim())) return 'invalidAccountId'
  return null
}

/** The body that saves the name step. The id is sent only while the account does not exist yet. */
export const nameBody = (draft: WizardDraft, accountLocked: boolean): Record<string, unknown> => ({
  from: 'name',
  ownerName: draft.ownerName.trim(),
  ...(accountLocked ? {} : { accountId: draft.accountId.trim() }),
})

export type ProviderIssue = 'choose' | 'consent' | 'ollamaModel'

/** What keeps the provider step from continuing (or testing). Null when nothing does. */
export function providerIssue(draft: WizardDraft): ProviderIssue | null {
  if (draft.provider === '') return 'choose'
  if (consentKeyOf(draft) !== null && !draft.consent) return 'consent'
  if (draft.provider === 'ollama' && draft.ollamaModel.trim() === '') return 'ollamaModel'
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
  return options
}

/** The body that saves the provider step, with the consent when the provider needs it. */
export const providerBody = (draft: WizardDraft): Record<string, unknown> => ({
  from: 'provider',
  provider: draft.provider,
  options: providerOptions(draft),
  ...(consentKeyOf(draft) !== null && draft.consent ? { consent: true } : {}),
})

/** The body of "Test connection". */
export const testBody = (
  draft: WizardDraft,
): { provider: string; options: Record<string, string>; consent?: boolean } => ({
  provider: draft.provider,
  options: providerOptions(draft),
  ...(consentKeyOf(draft) !== null && draft.consent ? { consent: true } : {}),
})

/** The schedules the first schedule step suggests (RF-60): 09:00 and 19:00, every day. */
export const SUGGESTED_SCHEDULES: readonly ScheduleDraft[] = [
  { days: EVERY_DAY, time: '09:00' },
  { days: EVERY_DAY, time: '19:00' },
]
