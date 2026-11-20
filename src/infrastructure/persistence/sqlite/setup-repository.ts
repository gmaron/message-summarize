import { consentCovers, normalizeSetupStep, type SetupStep } from '../../../domain/setup.js'
import type { Database } from './database.js'

/** The state of the setup wizard (RF-70). */
export interface SetupRecord {
  readonly step: SetupStep
  /** The account the wizard is setting up, once the "name" step created (or adopted) it. */
  readonly account: string | null
  /** ISO 8601, UTC. Null while the wizard is not over. */
  readonly completedAt: string | null
}

export interface ConsentRecord {
  readonly provider: string
  readonly textVersion: number
  /** The hosts that were disclosed, as `consentHostsKey` writes them. Empty for a consent recorded before they were kept. */
  readonly hosts: string
  /** ISO 8601, UTC. */
  readonly givenAt: string
}

/**
 * The setup state and the consents of the installation, in `app.db` (RF-70, RNF-02). Used by `main/` only. The wizard
 * and the settings read it on every request, so a daemon restarted halfway finds the wizard where it was left.
 */
export class SqliteSetupRepository {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  private stamp(): string {
    return new Date(this.now()).toISOString()
  }

  /** The state, or null when the wizard never started. A step of an older wizard reads as the nearest current one, and one nobody knows as the first. */
  get(): SetupRecord | null {
    const row = this.db.prepare('SELECT step, account_id, completed_at FROM setup WHERE id = 1').get() as
      | { step: string; account_id: string | null; completed_at: string | null }
      | undefined
    if (row === undefined) return null
    return {
      step: normalizeSetupStep(row.step),
      account: row.account_id,
      completedAt: row.completed_at,
    }
  }

  /**
   * Creates the state when there is none (never replaces one): at the first step, or already completed for an
   * installation that did not need the wizard. Returns what is stored.
   */
  ensure(completed: boolean): SetupRecord {
    const at = this.stamp()
    this.db
      .prepare(
        "INSERT INTO setup (id, step, account_id, completed_at, updated_at) VALUES (1, 'you', NULL, ?, ?) ON CONFLICT (id) DO NOTHING",
      )
      .run(completed ? at : null, at)
    return this.get() as SetupRecord
  }

  /** Moves the wizard to a step (and remembers its account). Does nothing to a completed setup. */
  save(step: SetupStep, account: string | null): void {
    this.db
      .prepare('UPDATE setup SET step = ?, account_id = ?, updated_at = ? WHERE id = 1 AND completed_at IS NULL')
      .run(step, account, this.stamp())
  }

  /** Marks the setup as completed (by finishing it or by skipping it). It stays completed. */
  complete(): void {
    const at = this.stamp()
    this.db
      .prepare(
        "INSERT INTO setup (id, step, account_id, completed_at, updated_at) VALUES (1, 'you', NULL, ?, ?) ON CONFLICT (id) DO UPDATE SET completed_at = COALESCE(completed_at, excluded.completed_at), updated_at = excluded.updated_at",
      )
      .run(at, at)
  }

  /**
   * Records that the user agreed to send the text of the chats of `account` to `provider` (a kind of the provider table),
   * as disclosed in `textVersion` of the text and for `hosts` (see `consentHostsKey`). The ONE way a consent is recorded:
   * the wizard, the settings and `msum provider use` all come here. False when it was recorded already (its date is kept).
   */
  recordConsent(account: string, provider: string, textVersion: number, hosts = ''): boolean {
    const result = this.db
      .prepare(
        'INSERT INTO consents (account_id, provider, text_version, hosts, given_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      )
      .run(account, provider, textVersion, hosts, this.stamp())
    return Number(result.changes) > 0
  }

  /**
   * The consent that covers what is configured now, or null (see `consentCovers`: same kind, the current text, the same
   * hosts, or none recorded for a kind with fixed hosts). When more than one covers it, the latest.
   */
  findConsent(account: string, provider: string, hostsKey: string, currentVersion: number): ConsentRecord | null {
    const found = this.consents(account)
      .filter((consent) => consentCovers(consent, provider, hostsKey, currentVersion))
      .at(-1)
    return found ?? null
  }

  /** True when `findConsent` finds one. */
  hasConsent(account: string, provider: string, hostsKey: string, currentVersion: number): boolean {
    return this.findConsent(account, provider, hostsKey, currentVersion) !== null
  }

  /** Every consent of the account, oldest first. */
  consents(account: string): ConsentRecord[] {
    const rows = this.db
      .prepare(
        'SELECT provider, text_version, hosts, given_at FROM consents WHERE account_id = ? ORDER BY given_at, provider, hosts',
      )
      .all(account) as { provider: string; text_version: number; hosts: string; given_at: string }[]
    return rows.map((row) => ({
      provider: row.provider,
      textVersion: Number(row.text_version),
      hosts: row.hosts,
      givenAt: row.given_at,
    }))
  }
}
