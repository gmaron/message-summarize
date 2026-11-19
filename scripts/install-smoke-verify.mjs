// Verifies an installed message-summarize (install smoke test in CI, RNF-05/06/07, RF-80).
//
//   MSUM_DATA_DIR=<temp dir> node scripts/install-smoke-verify.mjs <path to the installed msum or msum.cmd> [--version-only]
//
// With --version-only only step 1 runs (used after an update to see the program still answers).
//
// 1. `msum --version` prints the version in package.json.
// 2. `msum doctor --skip-model-check` runs. On a fresh install it reports problems (no LLM provider, no linked
//    account) and exits 1; that is expected. Anything else (a crash, another code) fails.
// 3. `msum daemon` starts and the web answers on 127.0.0.1, then the daemon is stopped.
// Nothing is installed as a service and nothing leaves the machine. Uses only the temporary data folder given in
// MSUM_DATA_DIR.
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const WINDOWS = process.platform === 'win32'
const PORT = 18787
const bin = process.argv[2]
const dataDir = process.env.MSUM_DATA_DIR

function fail(message) {
  console.error(`install smoke: ${message}`)
  process.exit(1)
}

if (!bin) fail('usage: install-smoke-verify.mjs <msum path>')
if (!dataDir) fail('MSUM_DATA_DIR must point to a temporary folder')

// A .cmd shim needs a shell on Windows; the path comes from our own workflow, never from chat text.
const command = WINDOWS ? `"${bin}"` : bin
const options = { shell: WINDOWS, encoding: 'utf8', env: { ...process.env, MSUM_LANG: 'en' } }
const PROBE_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 10_000

const expected = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const version = spawnSync(command, ['--version'], { ...options, timeout: PROBE_TIMEOUT_MS })
if (version.status !== 0) fail(`--version exited ${version.status}: ${version.stderr}`)
if (version.stdout.trim() !== expected) fail(`--version printed "${version.stdout.trim()}", expected "${expected}"`)
console.log(`version ok: ${expected}`)
if (process.argv.includes('--version-only')) process.exit(0)

const doctor = spawnSync(command, ['doctor', '--skip-model-check'], { ...options, timeout: PROBE_TIMEOUT_MS })
console.log(doctor.stdout)
if (doctor.status !== 0 && doctor.status !== 1) fail(`doctor exited ${doctor.status}: ${doctor.stderr}`)
// Exit 1 is also what a crash produces, so with exit 1 the report must have reached its closing line (en or es
// catalog; the language comes from the config, not from MSUM_LANG) and stderr must not carry a crash event.
const REPORT_END = ['There are problems to solve.', 'Hay problemas por resolver.']
if (
  doctor.status === 1 &&
  (!REPORT_END.some((line) => doctor.stdout.includes(line)) || /cli\.crashed|process\.uncaught/.test(doctor.stderr))
) {
  fail(`doctor exited 1 without finishing its report (a crash?): ${doctor.stderr}`)
}
console.log(`doctor ran (exit ${doctor.status})`)

// A fixed, unusual port keeps the smoke away from a service the runner might already have on 8787.
const configPath = join(dataDir, 'config.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
config.web = { enabled: true, host: '127.0.0.1', port: PORT }
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

const daemon = spawn(command, ['daemon'], { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
daemon.stdout.on('data', (chunk) => {
  output += chunk
})
daemon.stderr.on('data', (chunk) => {
  output += chunk
})

let exited = false
daemon.once('exit', () => {
  exited = true
})

/** Stops the daemon (the whole tree on Windows) and waits for it to exit; forces it after a timeout. */
async function stopDaemon() {
  if (exited) return
  const done = new Promise((resolve) => daemon.once('exit', resolve))
  if (WINDOWS) spawnSync('taskkill', ['/pid', String(daemon.pid), '/T', '/F'])
  else daemon.kill('SIGTERM')
  const timer = setTimeout(() => daemon.kill('SIGKILL'), STOP_TIMEOUT_MS)
  await done
  clearTimeout(timer)
}

let answered = false
for (let attempt = 0; attempt < 40 && !answered && !exited; attempt++) {
  await sleep(500)
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) })
    answered = response.status === 200
  } catch {
    // not up yet
  }
}
await stopDaemon()
if (!answered) fail(`the web did not answer on 127.0.0.1:${PORT}. Daemon output:\n${output}`)
console.log(`daemon ok: the web answered on 127.0.0.1:${PORT}`)
