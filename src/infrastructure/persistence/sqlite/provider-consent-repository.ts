import type { Database } from './database.js'

/** The hosts as they are stored: unique, sorted and comma-joined, so the same list always gives the same key. */
export const consentHostsKey = (hosts: readonly string[]): string => [...new Set(hosts)].sort().join(',')

/**
 * The consents to send chats to a provider (RNF-02), in `app.db`: one per account, provider kind and list of hosts that
 * was disclosed. It sits next to the schedules and is used by `main/` only. A consent says what the user was shown and
 * accepted; it does not gate anything by itself (see `doctor`, which makes a missing one visible).
 */
export class SqliteProviderConsents {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records the consent, now. Accepting the same thing again moves its date. The account must be registered. */
  record(accountId: string, kind: string, hosts: readonly string[]): void {
    this.db
      .prepare(
        `INSERT INTO provider_consents (account_id, kind, hosts, accepted_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id, kind, hosts) DO UPDATE SET accepted_at = excluded.accepted_at`,
      )
      .run(accountId, kind, consentHostsKey(hosts), new Date(this.now()).toISOString())
  }

  /** When (ISO 8601) the account accepted exactly these hosts for this kind, or null. */
  find(accountId: string, kind: string, hosts: readonly string[]): string | null {
    const row = this.db
      .prepare('SELECT accepted_at FROM provider_consents WHERE account_id = ? AND kind = ? AND hosts = ?')
      .get(accountId, kind, consentHostsKey(hosts)) as { accepted_at: string } | undefined
    return row?.accepted_at ?? null
  }

  /** Every consent of an account, for the tests and for listing. */
  list(accountId: string): { kind: string; hosts: string; acceptedAt: string }[] {
    const rows = this.db
      .prepare('SELECT kind, hosts, accepted_at FROM provider_consents WHERE account_id = ? ORDER BY kind, hosts')
      .all(accountId) as { kind: string; hosts: string; accepted_at: string }[]
    return rows.map((row) => ({ kind: row.kind, hosts: row.hosts, acceptedAt: row.accepted_at }))
  }
}
