import type { SettingsFieldKey, WebTexts } from '../../../infrastructure/i18n/catalog.js'
import { ApiError } from './api.js'
import { fmt } from './i18n.js'
import type { ProviderName, SettingsIssue, SettingsView } from './types.js'

export type FieldKind = 'boolean' | 'number' | 'text' | 'choice' | 'language' | 'timezone'
export type GroupName = 'digest' | 'languageTime' | 'provider'

export interface FieldSpec {
  /** The dotted name of the option in config.json (also the key of the draft). */
  readonly option: string
  /** Where its texts are in the catalog. */
  readonly key: SettingsFieldKey
  readonly kind: FieldKind
  readonly group: GroupName
  /** Shown only while this provider is the primary or the backup (its fields are noise otherwise). */
  readonly only?: ProviderName
  /** A required value: an empty field is not "use the installation's", so the hint does not say so. */
  readonly required?: true
}

/** The fields of the form, in the order they are shown. */
export const FIELDS: readonly FieldSpec[] = [
  { option: 'unreadOnly', key: 'unreadOnly', kind: 'boolean', group: 'digest' },
  { option: 'flagUnsaved', key: 'flagUnsaved', kind: 'boolean', group: 'digest' },
  { option: 'hideRest', key: 'hideRest', kind: 'boolean', group: 'digest' },
  { option: 'maxCharsPerConversation', key: 'maxCharsPerConversation', kind: 'number', group: 'digest' },
  { option: 'defaultWindowHours', key: 'defaultWindowHours', kind: 'number', group: 'digest' },
  { option: 'language', key: 'language', kind: 'language', group: 'languageTime' },
  { option: 'timezone', key: 'timezone', kind: 'timezone', group: 'languageTime' },
  { option: 'ownerName', key: 'ownerName', kind: 'text', group: 'languageTime' },
  { option: 'provider.primary', key: 'providerPrimary', kind: 'choice', group: 'provider' },
  { option: 'provider.backup', key: 'providerBackup', kind: 'choice', group: 'provider' },
  { option: 'provider.claudeCli.model', key: 'claudeModel', kind: 'text', group: 'provider' },
  { option: 'provider.claudeCli.timeoutMs', key: 'claudeTimeoutMs', kind: 'number', group: 'provider' },
  { option: 'provider.ollama.baseUrl', key: 'ollamaBaseUrl', kind: 'text', group: 'provider' },
  { option: 'provider.ollama.model', key: 'ollamaModel', kind: 'text', group: 'provider' },
  {
    option: 'provider.openai.model',
    key: 'openaiModel',
    kind: 'text',
    group: 'provider',
    only: 'openai',
    required: true,
  },
  { option: 'provider.openai.baseUrl', key: 'openaiBaseUrl', kind: 'text', group: 'provider', only: 'openai' },
  {
    option: 'provider.anthropic.model',
    key: 'anthropicModel',
    kind: 'text',
    group: 'provider',
    only: 'anthropic',
    required: true,
  },
  {
    option: 'provider.gemini.model',
    key: 'geminiModel',
    kind: 'text',
    group: 'provider',
    only: 'gemini',
    required: true,
  },
]

/** True when an empty text in this field means "use the value of the installation" (the hint says so). */
export const inheritsWhenEmpty = (option: string): boolean => {
  const field = FIELDS.find((one) => one.option === option)
  return field !== undefined && field.kind === 'text' && field.required !== true && option !== 'provider.openai.baseUrl'
}

/** The fields to show for the providers in use: those of no provider in particular, and those of a provider that is chosen. */
export const fieldsFor = (group: GroupName, active: readonly string[]): readonly FieldSpec[] =>
  FIELDS.filter((field) => field.group === group && (field.only === undefined || active.includes(field.only)))

export const GROUPS: readonly GroupName[] = ['digest', 'languageTime', 'provider']

/** What the form holds: a boolean for a switch, text for everything else (a number is typed text until it is sent). */
export type Draft = Readonly<Record<string, string | boolean>>

const valueAt = (values: SettingsView['values'], path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | null)?.[key], values)

/** The draft that shows the current values. A value that is not there (no provider, no model) is the empty text. */
export function draftOf(view: SettingsView): Draft {
  const draft: Record<string, string | boolean> = {}
  for (const { option, kind } of FIELDS) {
    const value = valueAt(view.values, option)
    draft[option] = kind === 'boolean' ? value === true : value === null || value === undefined ? '' : String(value)
  }
  return draft
}

export type PatchResult =
  | { readonly ok: true; readonly patch: Record<string, unknown> }
  /** A value that cannot even be sent (a number that is not one): the option and the code, as the server would say it. */
  | { readonly ok: false; readonly issue: SettingsIssue }

/**
 * The request for what changed: only the options whose value differs from `view`, nested as in config.json. An empty
 * text (or number) is `null`, which removes the account's own value so it inherits again; for the providers, empty is
 * `null` too, but that is a choice of its own ("none"). Empty patch: nothing to send.
 */
export function buildPatch(view: SettingsView, draft: Draft): PatchResult {
  const before = draftOf(view)
  const patch: Record<string, unknown> = {}
  for (const { option, kind } of FIELDS) {
    const raw: unknown = draft[option]
    if (raw === undefined) continue
    // A number input hands over a number (or null when it is empty): everything but a switch is compared as text.
    const now = typeof raw === 'boolean' ? raw : raw === null ? '' : String(raw)
    if (now === before[option]) continue
    let value: unknown
    if (kind === 'boolean') value = now === true
    else {
      const text = String(now).trim()
      if (kind === 'number' && text !== '') {
        const parsed = Number(text)
        if (!Number.isFinite(parsed)) return { ok: false, issue: { option, code: 'notNumber' } }
        value = parsed
      } else value = text === '' ? null : text
    }
    const keys = option.split('.')
    let node = patch
    for (const key of keys.slice(0, -1)) {
      node[key] ??= {}
      node = node[key] as Record<string, unknown>
    }
    node[keys[keys.length - 1] as string] = value
  }
  return { ok: true, patch }
}

/** Options the page shows in seconds while the daemon keeps them in milliseconds. */
export const SECONDS_OPTIONS: readonly string[] = ['provider.claudeCli.timeoutMs']

/** "120000" ms as the "120" the page shows; anything that is not a number is left as it is. */
export function secondsFromMs(ms: string): string {
  const value = Number(ms)
  return ms.trim() === '' || !Number.isFinite(value) ? ms : String(value / 1000)
}

/** The "120" typed as the "120000" the daemon keeps; anything that is not a number is left as it is (the daemon refuses it). */
export function msFromSeconds(seconds: string): string {
  const value = Number(seconds)
  return seconds.trim() === '' || !Number.isFinite(value) ? seconds : String(Math.round(value * 1000))
}

/** The draft as the form shows it: the options in seconds converted from the milliseconds of the view. */
export function shownDraft(view: SettingsView): Draft {
  const draft: Record<string, string | boolean> = { ...draftOf(view) }
  for (const option of SECONDS_OPTIONS) draft[option] = secondsFromMs(String(draft[option] ?? ''))
  return draft
}

/** The draft as `buildPatch` compares it with the view: seconds back to milliseconds. */
export function storedDraft(draft: Draft): Draft {
  const stored: Record<string, string | boolean> = { ...draft }
  for (const option of SECONDS_OPTIONS) stored[option] = msFromSeconds(String(stored[option] ?? ''))
  return stored
}

export const isEmptyPatch = (patch: Record<string, unknown>): boolean => Object.keys(patch).length === 0

/** The reason of an issue, in the language of the page. A code the page does not know (a newer daemon) says only the option. */
export function issueReason(issue: SettingsIssue, texts: WebTexts): string {
  const table = texts.configIssues as Readonly<Record<string, string>>
  const template = Object.hasOwn(table, issue.code) ? (table[issue.code] as string) : null
  return template === null
    ? texts.errors.invalidConfig
    : fmt(template, { allowed: (issue.allowed ?? []).join(texts.ui.text.listSeparator) })
}

const keyOf = (option: string): SettingsFieldKey | null => FIELDS.find((field) => field.option === option)?.key ?? null

/** The label of an option of the form, or its own name when it has none (an option of a newer daemon). */
export function optionLabel(option: string, texts: WebTexts): string {
  const key = keyOf(option)
  return key === null ? option : texts.ui.settings.fields[key].label
}

/** The hint under a field, when it has one. */
export function optionHint(option: string, texts: WebTexts): string | undefined {
  const key = keyOf(option)
  return key === null ? undefined : (texts.ui.settings.fields[key] as { hint?: string }).hint
}

/** Splits the issues into the ones that belong to a field (by option) and the ones that belong to none. */
export function groupIssues(issues: readonly SettingsIssue[]): {
  byOption: Readonly<Record<string, readonly SettingsIssue[]>>
  general: readonly SettingsIssue[]
} {
  const known = new Set<string>(FIELDS.map((field) => field.option))
  const byOption: Record<string, SettingsIssue[]> = {}
  const general: SettingsIssue[] = []
  for (const issue of issues) {
    if (!known.has(issue.option)) general.push(issue)
    else byOption[issue.option] = [...(byOption[issue.option] ?? []), issue]
  }
  return { byOption, general }
}

/** The issues of a refused save (a 422 `invalidConfig`), or null when the error is another. */
export const issuesOf = (error: unknown): readonly SettingsIssue[] | null =>
  error instanceof ApiError && error.code === 'invalidConfig' && error.issues !== undefined ? error.issues : null

/**
 * True when `value` is an address whose host is NOT this machine (anything but localhost, 127.0.0.0/8 and ::1). An
 * address that cannot be read is not "remote": the server says what is wrong with it.
 */
export function isRemoteUrl(value: string): boolean {
  let host: string
  try {
    host = new URL(value.trim()).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === '') return false
  return !(host === 'localhost' || host === '[::1]' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host))
}

/** The time zones the browser knows, for the suggestions of the field. Empty where it cannot tell (the field still works). */
export function timeZoneChoices(): readonly string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    return intl.supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
}
