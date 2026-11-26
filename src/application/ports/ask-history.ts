/** What a finished request produced. The answer is private text derived from chats. */
export interface AskResultData {
  readonly answer: string
  readonly provider: string
  readonly chats: number
  readonly messages: number
  readonly leftOutLocalOnly: number
  readonly parts: number
  readonly calls: number
}

export type AskRecordState = 'running' | 'done' | 'failed'

export interface AskRecord {
  readonly id: number
  readonly createdAt: number
  readonly finishedAt: number | null
  readonly state: AskRecordState
  readonly question: string
  readonly selection: 'unanswered' | 'unread' | 'all'
  readonly period: 'today' | 'h24' | 'd3' | 'd7'
  readonly since: number
  readonly until: number
  /** The filter of the request: patterns of names, numbers or `id:<id>`. */
  readonly chats: readonly string[]
  /** The answer was asked to be queued for the owner's own chat. */
  readonly deliver: boolean
  /** The id of the last outbox part of the delivery, or null when nothing was queued. */
  readonly outboxId: number | null
  readonly result: AskResultData | null
  /** A fixed code of what failed, never a message. */
  readonly error: string | null
}

export type NewAsk = Pick<
  AskRecord,
  'createdAt' | 'question' | 'selection' | 'period' | 'since' | 'until' | 'chats' | 'deliver'
>

export interface AskFinish {
  readonly finishedAt: number
  readonly state: 'done' | 'failed'
  readonly result?: AskResultData
  readonly error?: string
  readonly outboxId?: number | null
}

/** The persistent history of the requests of an account (the latest `ASK_HISTORY_LIMIT`). */
export interface AskHistory {
  /** Stores a request as running and returns its id. Older requests beyond the limit are deleted. */
  start(request: NewAsk): Promise<number>
  /** Closes a request. False when it does not exist (it was deleted meanwhile). */
  finish(id: number, update: AskFinish): Promise<boolean>
  /** The requests, newest first. */
  list(): Promise<readonly AskRecord[]>
  /** Deletes one request. False when it does not exist. */
  remove(id: number): Promise<boolean>
  /** Closes as failed (`interrupted`) every request still running: the process that was writing it is gone. Returns how many. */
  failRunning(finishedAt: number): Promise<number>
  /** Deletes everything (the account is linked again). Returns how many. */
  clear(): Promise<number>
}

/** How many requests an account keeps. */
export const ASK_HISTORY_LIMIT = 50
