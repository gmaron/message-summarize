// Healthy when the daemon's web answers on loopback. Any HTTP answer counts, a 401 included: the web has no
// unauthenticated route, and the token must not be needed here. A refused connection (or no web.json: the web is not
// listening) is unhealthy.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

try {
  const { port } = JSON.parse(readFileSync(join(process.env.MSUM_DATA_DIR ?? '/data', 'web.json'), 'utf8'))
  await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(4000), redirect: 'manual' })
} catch {
  process.exit(1)
}
