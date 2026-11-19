// RNF-09 (informational): starts the daemon from dist/ with a throwaway data directory and no accounts, waits a few
// seconds, prints its resident memory (RSS) and stops it. No network beyond the loopback web port, which is a free one.
// It never fails on the number: the 150 MB target has no baseline yet. It fails only if the daemon cannot be measured.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SETTLE_MS = 8000
const TARGET_MB = 150

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Resident set size of a process in MB, or null when the platform has no cheap way to read it. */
async function rssMb(pid) {
  const { execFileSync } = await import('node:child_process')
  try {
    if (process.platform === 'win32') return null
    const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    return Number.isFinite(kb) ? kb / 1024 : null
  } catch {
    return null
  }
}

const dir = mkdtempSync(join(tmpdir(), 'msum-idle-'))
let child
let exited = false
const STOP_TIMEOUT_MS = 5000

/** Stops the daemon and waits for it to exit, so it cannot recreate files in the directory we are about to delete. */
async function stop() {
  if (!child || exited) return
  const done = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS)
  await done
  clearTimeout(timer)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    child?.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
    process.exit(1)
  })
}

try {
  const port = await freePort()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ web: { enabled: true, host: '127.0.0.1', port } }))
  child = spawn(process.execPath, [join(root, 'dist', 'main', 'cli.js'), 'daemon'], {
    env: { ...process.env, MSUM_DATA_DIR: dir },
    stdio: 'ignore',
  })
  child.once('exit', () => {
    exited = true
  })
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  if (exited) throw new Error('the daemon exited before it could be measured')
  const mb = await rssMb(child.pid)
  if (mb === null) throw new Error('cannot read the RSS on this platform')
  console.log(`idle RSS with no accounts: ${mb.toFixed(1)} MB (target ${TARGET_MB} MB, informational)`)
} catch (error) {
  console.error(`measure-idle-memory: ${error.message}`)
  process.exitCode = 1
} finally {
  await stop()
  rmSync(dir, { recursive: true, force: true })
}
