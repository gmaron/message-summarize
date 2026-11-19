// Runs before the daemon starts, inside the container (see entrypoint.sh).
//
// A daemon that was killed leaves daemon.pid behind. A lock written by the same host name is from a previous run of this
// same container (process ids start again in a new one), so it is stale and is removed. A lock of another host name is
// left alone (it may be a live daemon of another container on the same volume), and so is a lock that was refreshed
// lately: a live daemon touches it every HEARTBEAT_MS, so it can never be removed from under a running daemon (this is
// why `docker compose run` of the daemon service is not supported: use `exec`).
import { readFileSync, rmSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** HEARTBEAT_MS of src/main/daemon-lock.ts (a unit test keeps them in step). */
export const HEARTBEAT_MS = 30_000
/** A lock untouched for this long has no live daemon behind it. */
export const STALE_AFTER_MS = 3 * HEARTBEAT_MS

/** Removes the stale lock of this host in `dataDir`. Returns true when it removed one. Never throws. */
export function dropStaleLock({ dataDir, host = hostname(), now = Date.now() }) {
  const file = join(dataDir, 'daemon.pid')
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'))
    if (lock === null || typeof lock !== 'object' || lock.host !== host) return false
    if (now - statSync(file).mtimeMs < STALE_AFTER_MS) return false
    rmSync(file, { force: true })
    return true
  } catch {
    // No lock, or one msum reads on its own terms.
    return false
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  dropStaleLock({ dataDir: process.env.MSUM_DATA_DIR ?? '/data' })
}
