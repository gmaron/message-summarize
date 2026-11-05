import { err, ok, type Result } from './result.js'

export interface DigestSettings {
  /** Null: the renderer uses a translated default label. */
  readonly ownerName: string | null
  readonly excludePatterns: readonly string[]
  readonly defaultWindowHours: number
  readonly maxCharsPerConversation: number
  readonly unreadOnly: boolean
  readonly flagUnsaved: boolean
  readonly hideRest: boolean
}

export const DEFAULT_SETTINGS = {
  ownerName: null as string | null,
  excludePatterns: [] as readonly string[],
  defaultWindowHours: 24,
  maxCharsPerConversation: 24000,
  unreadOnly: false,
  flagUnsaved: false,
  hideRest: false,
} as const

/** Why an option is invalid. Codes, not text: the interfaces translate them. */
export type SettingsIssueCode =
  | 'notString'
  | 'emptyString'
  | 'notArray'
  | 'notStringList'
  | 'emptyPattern'
  | 'notNumber'
  | 'notPositive'
  | 'notInteger'
  | 'notBoolean'
  | 'notObject'

/** A problem with one option: which one and why. */
export interface SettingsIssue {
  readonly option: string
  readonly code: SettingsIssueCode
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validates the digest options (RF-73). A missing option (absent or undefined) takes its default (`ownerName` too: null); an option that is
 * present but invalid is reported, never replaced silently. Keys that are not digest options are ignored, so a larger
 * configuration object can be passed as is.
 */
export function parseDigestSettings(input: unknown): Result<DigestSettings, SettingsIssue[]> {
  if (!isPlainObject(input)) return err([{ option: '(settings)', code: 'notObject' }])
  const issues: SettingsIssue[] = []
  const fail = (option: string, code: SettingsIssueCode): undefined => {
    issues.push({ option, code })
    return undefined
  }

  const ownerName = ((): string | null | undefined => {
    const v = input.ownerName
    if (v === undefined) return DEFAULT_SETTINGS.ownerName
    if (typeof v !== 'string') return fail('ownerName', 'notString')
    if (v.trim() === '') return fail('ownerName', 'emptyString')
    return v
  })()

  const excludePatterns = ((): readonly string[] | undefined => {
    const v = input.excludePatterns
    if (v === undefined) return DEFAULT_SETTINGS.excludePatterns
    if (!Array.isArray(v)) return fail('excludePatterns', 'notArray')
    if (!v.every((p) => typeof p === 'string')) return fail('excludePatterns', 'notStringList')
    // An empty pattern is a substring of everything: it would exclude every conversation.
    if (v.some((p: string) => p.trim() === '')) return fail('excludePatterns', 'emptyPattern')
    return [...(v as string[])]
  })()

  const defaultWindowHours = ((): number | undefined => {
    const v = input.defaultWindowHours
    if (v === undefined) return DEFAULT_SETTINGS.defaultWindowHours
    if (typeof v !== 'number') return fail('defaultWindowHours', 'notNumber')
    if (!Number.isFinite(v) || v <= 0) return fail('defaultWindowHours', 'notPositive')
    return v
  })()

  const maxCharsPerConversation = ((): number | undefined => {
    const v = input.maxCharsPerConversation
    if (v === undefined) return DEFAULT_SETTINGS.maxCharsPerConversation
    if (typeof v !== 'number') return fail('maxCharsPerConversation', 'notNumber')
    if (!Number.isInteger(v)) return fail('maxCharsPerConversation', 'notInteger')
    if (v <= 0) return fail('maxCharsPerConversation', 'notPositive')
    return v
  })()

  const flag = (option: 'unreadOnly' | 'flagUnsaved' | 'hideRest'): boolean | undefined => {
    const v = input[option]
    if (v === undefined) return DEFAULT_SETTINGS[option]
    if (typeof v !== 'boolean') return fail(option, 'notBoolean')
    return v
  }
  const unreadOnly = flag('unreadOnly')
  const flagUnsaved = flag('flagUnsaved')
  const hideRest = flag('hideRest')

  if (
    issues.length > 0 ||
    ownerName === undefined ||
    excludePatterns === undefined ||
    defaultWindowHours === undefined ||
    maxCharsPerConversation === undefined ||
    unreadOnly === undefined ||
    flagUnsaved === undefined ||
    hideRest === undefined
  ) {
    return err(issues)
  }
  return ok({
    ownerName,
    excludePatterns,
    defaultWindowHours,
    maxCharsPerConversation,
    unreadOnly,
    flagUnsaved,
    hideRest,
  })
}
