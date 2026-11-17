import type {
  BlockedReason,
  DigestErrorCode,
  Language,
  LinkErrorCode,
  WebConfigIssueCode,
} from '../../../infrastructure/i18n/index.js'

export type { BlockedReason, DigestErrorCode, Language, LinkErrorCode, WebConfigIssueCode }

/** What the daemon says about the connection of an account. */
export type UnitState = 'connecting' | 'connected' | 'reconnecting' | 'blocked' | 'idle' | 'linking'

/** One account as `GET /api/accounts` and the `accounts` event give it. */
export interface AccountView {
  readonly id: string
  readonly state: UnitState
  readonly since: number | null
  readonly blockedReason: BlockedReason | null
  /** When it was blocked (epoch ms), or null. */
  readonly blockedAt: number | null
  /** When the web's retry is allowed, for a block WhatsApp asked to wait for. */
  readonly retryAfter: number | null
  /** What fixes the block, decided by the daemon: the page offers only that. */
  readonly fix: 'relink' | 'retry' | null
  /** Already masked by the server: the page never sees a full number. */
  readonly maskedNumber: string | null
  readonly lastDigest: number | null
  readonly nextRun: number | null
  readonly timezone: string
  readonly language: Language
  readonly configValid: boolean
  /** What is wrong when it is not valid: the option and a code to translate. */
  readonly configIssues: readonly SettingsIssue[]
}

/** A problem of the configuration, as the API says it. */
export interface SettingsIssue {
  readonly option: string
  readonly code: WebConfigIssueCode
  readonly allowed?: readonly string[]
}

export type SettingSource = 'account' | 'installation' | 'default'
export type ProviderName = 'claude-cli' | 'ollama'

/** `GET /api/accounts/:id/settings`: the effective values (nested as in config.json) and where each comes from. */
export interface SettingsView {
  readonly values: {
    readonly language: Language
    readonly timezone: string
    readonly ownerName: string | null
    readonly unreadOnly: boolean
    readonly flagUnsaved: boolean
    readonly hideRest: boolean
    readonly maxCharsPerConversation: number
    readonly defaultWindowHours: number
    readonly concurrency: number
    readonly provider: {
      readonly primary: ProviderName | null
      readonly backup: ProviderName | null
      readonly claudeCli: { readonly model: string; readonly timeoutMs: number }
      readonly ollama: { readonly baseUrl: string; readonly model: string | null }
    }
  }
  readonly sources: Readonly<Record<string, SettingSource>>
  readonly options: { readonly providers: readonly ProviderName[]; readonly languages: readonly Language[] }
}

/** A schedule as the API gives it: days as cron numbers (0 is Sunday). */
export interface ScheduleView {
  readonly id: number
  readonly days: readonly number[]
  readonly time: string
  readonly nextRun: number | null
}

export interface SchedulesView {
  readonly timezone: string
  readonly schedules: readonly ScheduleView[]
}

export type LinkPhase = 'idle' | 'waitingQr' | 'qr' | 'syncing' | 'done' | 'failed'

export interface SyncProgress {
  readonly chats: number
  readonly messages: number
  /** 0 to 100 when the platform reports it; absent when the progress is not known. */
  readonly percent?: number
  readonly done: boolean
}

/** `GET /api/accounts/:id/link`. */
export interface LinkSnapshot {
  readonly state: LinkPhase
  readonly sync?: SyncProgress
  readonly error?: LinkErrorCode
}

export type DigestEventState = 'started' | 'deferred' | 'done' | 'empty' | 'failed' | 'busy'

/** `GET /api/accounts/:id/preview`. `parts` is text written from chats of third parties: render it as text only. */
export interface PreviewView {
  readonly state: 'none' | 'running' | 'done' | 'empty' | 'failed'
  readonly generatedAt?: number
  readonly parts?: readonly string[]
  readonly summarized?: number
  readonly failed?: number
  readonly error?: DigestErrorCode
}
