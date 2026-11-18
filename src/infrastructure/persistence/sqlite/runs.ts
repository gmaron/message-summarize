import type { FailureCode, RunCompletion, RunFailedConversation } from '../../../application/ports/digest-store.js'
import type { Database } from './database.js'

/** Why a digest ran. `cli` is `msum digest`. */
export type RunTrigger = 'schedule' | 'missed' | 'manual' | 'cli'
export type RunOutcome = 'committed' | 'empty' | 'failed'

/** The code kept of a run that failed: a `RunDigestError` kind, `failed` for an exception, `interrupted` for a crash. */
export type RunErrorCode = string

/** One digest run as the history shows it (RF-74). Counts and codes; the names of `failedConversations` are private. */
export interface DigestRun {
  readonly id: number
  readonly trigger: RunTrigger
  readonly startedAt: number
  /** Null while the run is open (or was interrupted before `markInterruptedRuns` closed it). */
  readonly finishedAt: number | null
  readonly outcome: RunOutcome | null
  readonly error: RunErrorCode | null
  readonly summarized: number
  readonly failed: number
  readonly providers: Readonly<Record<string, number>>
  readonly failedConversations: readonly RunFailedConversation[]
  readonly digestId: number | null
  readonly since: number | null
  readonly until: number | null
}

export interface RunPage {
  readonly total: number
  readonly items: readonly DigestRun[]
}

interface Row {
  id: number
  trigger_kind: RunTrigger
  started_at: number
  finished_at: number | null
  outcome: RunOutcome | null
  error: string | null
  summarized: number
  failed: number
  providers: string
  failed_conversations: string
  digest_id: number | null
  since: number | null
  until: number | null
}

const COLUMNS =
  'id, trigger_kind, started_at, finished_at, outcome, error, summarized, failed, providers, failed_conversations, digest_id, since, until'

/**
 * A run its owner may still close: open, or marked `interrupted` by a look that saw it open for too long while it was
 * in fact still running (a digest slower than the grace).
 */
const OPEN_OR_INTERRUPTED = "(finished_at IS NULL OR error = 'interrupted')"

const FAILURE_CODES: readonly string[] = ['localOnlyUnavailable', 'timeout', 'invalidSummary', 'failed']

function parseProviders(text: string): Record<string, number> {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const out: Record<string, number> = {}
    for (const [name, count] of Object.entries(value)) if (typeof count === 'number') out[name] = count
    return out
  } catch {
    return {}
  }
}

function parseFailed(text: string): RunFailedConversation[] {
  try {
    const value: unknown = JSON.parse(text)
    if (!Array.isArray(value)) return []
    const out: RunFailedConversation[] = []
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const { id, name, reason } = item as Record<string, unknown>
      if (typeof id !== 'string' || typeof name !== 'string') continue
      out.push({ id, name, reason: (FAILURE_CODES.includes(String(reason)) ? reason : 'failed') as FailureCode })
    }
    return out
  } catch {
    return []
  }
}

function toRun(row: Row): DigestRun {
  return {
    id: row.id,
    trigger: row.trigger_kind,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome,
    error: row.error,
    summarized: row.summarized,
    failed: row.failed,
    providers: parseProviders(row.providers),
    failedConversations: parseFailed(row.failed_conversations),
    digestId: row.digest_id,
    since: row.since,
    until: row.until,
  }
}

/**
 * Closes a run that ended in a commit. Called by the digest store INSIDE the commit's transaction, so the digest and
 * its run row are saved together or not at all.
 */
export function closeCommittedRun(db: Database, run: RunCompletion, digestId: number | null): void {
  const stmt = db.prepare(
    `UPDATE digest_runs SET finished_at = ?, outcome = ?, error = NULL, summarized = ?, failed = ?, providers = ?,
       failed_conversations = ?, digest_id = ?, since = ?, until = ? WHERE id = ? AND ${OPEN_OR_INTERRUPTED}`,
  )
  const result = stmt.run(
    run.finishedAt,
    digestId === null ? 'empty' : 'committed',
    run.summarized,
    run.failed,
    JSON.stringify(run.providers),
    JSON.stringify(run.failedConversations),
    digestId,
    run.since,
    run.until,
    run.runId,
  )
  // Only the owner of the run closes it, so the row is there and open (or was called interrupted while it ran, which a
  // late commit corrects). Anything else breaks "a committed digest has its run": the transaction is rolled back.
  if (Number(result.changes) !== 1) throw new Error(`The run ${run.runId} cannot be closed: it is not open`)
}

/** The history of digest runs (RF-74): opening and closing the rows, and reading them. */
export class SqliteDigestRuns {
  constructor(private readonly db: Database) {}

  /** Opens a run row: it stays open until the run is closed (by the commit or by `fail`). Returns its id. */
  start(trigger: RunTrigger, startedAt: number): number {
    const result = this.db
      .prepare('INSERT INTO digest_runs (trigger_kind, started_at) VALUES (?, ?)')
      .run(trigger, startedAt)
    return Number(result.lastInsertRowid)
  }

  /** Closes an open run as failed. A run that already closed is left alone. Returns whether it changed. */
  fail(runId: number, finishedAt: number, error: RunErrorCode): boolean {
    const result = this.db
      .prepare(
        `UPDATE digest_runs SET finished_at = ?, outcome = 'failed', error = ? WHERE id = ? AND ${OPEN_OR_INTERRUPTED}`,
      )
      .run(finishedAt, error, runId)
    return Number(result.changes) === 1
  }

  /**
   * Closes as failed with `interrupted` the runs that never ended: the process died while they ran (RNF-08). Rows of
   * `msum digest` are only closed when older than `cliGraceMs`, because that command may be running right now in
   * another process while the daemon starts. Returns how many were closed.
   */
  markInterrupted(now: number, cliGraceMs: number): number {
    const result = this.db
      .prepare(
        `UPDATE digest_runs SET finished_at = ?, outcome = 'failed', error = 'interrupted'
         WHERE finished_at IS NULL AND (trigger_kind <> 'cli' OR started_at <= ?)`,
      )
      .run(now, now - cliGraceMs)
    return Number(result.changes)
  }

  /**
   * Closes as `interrupted` every open run that started `graceMs` ago or earlier, whoever owns it: a run that is still
   * going is not that old, and one that is (a very slow digest) is corrected by its owner when it ends. Safe to call from
   * any process at any time, unlike `markInterrupted`. Returns how many were closed.
   */
  markStale(now: number, graceMs: number): number {
    const result = this.db
      .prepare(
        "UPDATE digest_runs SET finished_at = ?, outcome = 'failed', error = 'interrupted' WHERE finished_at IS NULL AND started_at <= ?",
      )
      .run(now, now - graceMs)
    return Number(result.changes)
  }

  /** Changes whenever a run is added, closed or reopened: what a look compares to notice a run of another process. */
  signature(): string {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(id), 0) AS last, COUNT(*) AS total, COUNT(finished_at) AS closed FROM digest_runs')
      .get() as { last: number; total: number; closed: number }
    return `${row.last}:${row.total}:${row.closed}`
  }

  /** Newest first. */
  list(limit: number, offset: number): RunPage {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM digest_runs').get() as { n: number }).n
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM digest_runs ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as unknown as Row[]
    return { total, items: rows.map(toRun) }
  }

  get(runId: number): DigestRun | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM digest_runs WHERE id = ?`).get(runId) as unknown as
      | Row
      | undefined
    return row === undefined ? null : toRun(row)
  }

  /** The complete text of a digest of the history (RF-36), or null. */
  digest(digestId: number): { text: string; since: number; until: number } | null {
    const row = this.db.prepare('SELECT text, since, until FROM digests WHERE id = ?').get(digestId) as
      | { text: string; since: number; until: number }
      | undefined
    return row ?? null
  }
}
