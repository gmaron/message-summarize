import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '../config/atomic-write.js'

/**
 * What the daemon says about the connection of one account (RF-04): `connecting`, `connected`, `reconnecting`,
 * `blocked` (it stopped using the account, see `blocked.json`), `idle` (the account is not linked, or a `msum link` is
 * linking it) or `linking` (the daemon itself is linking it, started from the web).
 */
export type UnitState = 'connecting' | 'connected' | 'reconnecting' | 'blocked' | 'idle' | 'linking'

const STATES: readonly UnitState[] = ['connecting', 'connected', 'reconnecting', 'blocked', 'idle', 'linking']

export interface UnitStateRecord {
  readonly state: UnitState
  /** Epoch ms of the last change of state. */
  readonly since: number
}

/**
 * `accounts/<id>/state.json`: the state and when it began. Nothing else: no number, no name, no secret. It is replaced
 * atomically (written aside, then renamed), so a reader never sees half of it. Only meaningful while the daemon lives:
 * `status` ignores it otherwise.
 */
export async function writeUnitState(file: string, record: UnitStateRecord): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify({ state: record.state, since: record.since })}\n`)
}

export async function readUnitState(file: string): Promise<UnitStateRecord | null> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as { state?: unknown; since?: unknown }
    if (STATES.includes(data.state as UnitState) && typeof data.since === 'number') {
      return { state: data.state as UnitState, since: data.since }
    }
  } catch {
    // missing or not complete: no state
  }
  return null
}
