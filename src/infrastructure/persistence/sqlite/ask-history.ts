import {
  ASK_HISTORY_LIMIT,
  type AskFinish,
  type AskHistory,
  type AskRecord,
  type AskResultData,
  type NewAsk,
} from '../../../application/ports/ask-history.js'
import type { Database } from './database.js'

interface Row {
  id: number
  created_at: number
  finished_at: number | null
  state: string
  question: string
  selection: string
  period: string
  since: number
  until: number
  chats: string
  deliver: number
  outbox_id: number | null
  result: string | null
  error: string | null
}

const COLUMNS =
  'id, created_at, finished_at, state, question, selection, period, since, until, chats, deliver, outbox_id, result, error'

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

const toRecord = (row: Row): AskRecord => ({
  id: row.id,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
  state: row.state as AskRecord['state'],
  question: row.question,
  selection: row.selection as AskRecord['selection'],
  period: row.period as AskRecord['period'],
  since: row.since,
  until: row.until,
  chats: parseJson<string[]>(row.chats, []),
  deliver: row.deliver !== 0,
  outboxId: row.outbox_id,
  result: parseJson<AskResultData | null>(row.result, null),
  error: row.error,
})

/** The history of the requests of the "Ask" tab on SQLite (migration 7). Keeps the latest `ASK_HISTORY_LIMIT`. */
export class SqliteAskHistory implements AskHistory {
  constructor(
    private readonly db: Database,
    private readonly limit: number = ASK_HISTORY_LIMIT,
  ) {}

  async start(request: NewAsk): Promise<number> {
    const inserted = this.db
      .prepare(
        `INSERT INTO asks (created_at, state, question, selection, period, since, until, chats, deliver)
         VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.createdAt,
        request.question,
        request.selection,
        request.period,
        request.since,
        request.until,
        JSON.stringify(request.chats),
        request.deliver ? 1 : 0,
      )
    const id = Number(inserted.lastInsertRowid)
    this.db
      .prepare('DELETE FROM asks WHERE id NOT IN (SELECT id FROM asks ORDER BY id DESC LIMIT ?)')
      .run(Math.max(1, this.limit))
    return id
  }

  async finish(id: number, update: AskFinish): Promise<boolean> {
    const result = this.db
      .prepare('UPDATE asks SET state = ?, finished_at = ?, result = ?, error = ?, outbox_id = ? WHERE id = ?')
      .run(
        update.state,
        update.finishedAt,
        update.result === undefined ? null : JSON.stringify(update.result),
        update.error ?? null,
        update.outboxId ?? null,
        id,
      )
    return Number(result.changes) === 1
  }

  async list(): Promise<readonly AskRecord[]> {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM asks ORDER BY id DESC`).all() as unknown as Row[]
    return rows.map(toRecord)
  }

  async remove(id: number): Promise<boolean> {
    return Number(this.db.prepare('DELETE FROM asks WHERE id = ?').run(id).changes) === 1
  }

  async failRunning(finishedAt: number): Promise<number> {
    return Number(
      this.db
        .prepare("UPDATE asks SET state = 'failed', finished_at = ?, error = 'interrupted' WHERE state = 'running'")
        .run(finishedAt).changes,
    )
  }

  async clear(): Promise<number> {
    return Number(this.db.prepare('DELETE FROM asks').run().changes)
  }
}
