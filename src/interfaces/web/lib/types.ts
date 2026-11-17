import type { BlockedReason, DigestErrorCode, Language, LinkErrorCode } from '../../../infrastructure/i18n/index.js'

export type { BlockedReason, DigestErrorCode, Language, LinkErrorCode }

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
