#!/usr/bin/env node
// Generates the golden files by running the author's legacy tool on made-up conversations.
//
// Usage: node test/golden/generate.mjs --legacy <path> [scenario-slug ...]
//
// The legacy project is only read: four of its source files are copied into a temp dir, together with a
// fake LLM and a fake transcriber. Nothing is written inside the legacy path and no legacy code is stored here.
import { spawnSync } from 'node:child_process'
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

// node:sqlite works without a flag from Node 22.13 (and 23.4) on; check before importing it
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13) || (major === 23 && minor < 4)) {
  console.error(`Node 22.13 or 23.4 or later is required (found ${process.versions.node}).`)
  process.exit(2)
}
const { DatabaseSync } = await import('node:sqlite')

const TZ = 'America/Argentina/Buenos_Aires'
process.env.TZ = TZ // so that local scenario times convert the same way the legacy tool reads them

const HERE = dirname(fileURLToPath(import.meta.url))
const SCENARIOS_DIR = join(HERE, 'scenarios')
const LEGACY_FILES = ['summarize.js', 'config.js', 'db.js', 'prompt.js']

const { values, positionals } = parseArgs({ options: { legacy: { type: 'string' } }, allowPositionals: true })
if (!values.legacy) {
  console.error('Usage: node test/golden/generate.mjs --legacy <path> [scenario-slug ...]')
  process.exit(2)
}
const legacy = resolve(values.legacy.replace(/^~(?=\/)/, process.env.HOME))

const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const toTs = (local) => {
  const ts = new Date(local.replace(' ', 'T')).getTime()
  if (Number.isNaN(ts)) throw new Error(`Invalid scenario time: ${local}`)
  return ts
}
const fmtLocal = (ts) => (ts == null ? null : new Date(ts).toLocaleString('sv', { timeZone: TZ }))

const FAKE_LLM = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { SYSTEM, userMessage } from './prompt.js'

writeFileSync(process.env.WG_SYSTEM_FILE, SYSTEM)
const responses = JSON.parse(readFileSync(process.env.WG_RESPONSES_FILE, 'utf8'))

export async function summarizeChat(jid, chatName, isGroup, transcript) {
  const record = { jid, chatName, isGroup, userMessage: userMessage(chatName, isGroup, transcript) }
  const response = responses[jid]
  if (!response) record.missing = true
  appendFileSync(process.env.WG_RECORD_FILE, JSON.stringify(record) + '\\n')
  if (!response) throw new Error('no fixed response for ' + jid)
  if (response.error) throw new Error(response.error)
  return { ...response, proveedor: 'fake' }
}

export async function unloadModel() {}
`

const FAKE_TRANSCRIBE = 'export async function transcribePending() {}\n'

const SEED = `import { readFileSync } from 'node:fs'
import { db } from './src/db.js'

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'))
db.exec('BEGIN')
const chat = db.prepare('INSERT INTO chats (jid, name, is_group, unread_count) VALUES (?, ?, ?, ?)')
for (const c of seed.chats) chat.run(c.jid, c.name, c.is_group, c.unread_count)
const contact = db.prepare('INSERT INTO contacts (jid, name, push_name) VALUES (?, ?, ?)')
for (const c of seed.contacts) contact.run(c.jid, c.name, c.push_name)
const message = db.prepare(
  'INSERT INTO messages (chat_jid, id, sender_jid, sender_name, from_me, ts, kind, text, transcript, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
)
for (const m of seed.messages) message.run(m.chat_jid, m.id, m.sender_jid, m.sender_name, m.from_me, m.ts, m.kind, m.text, m.transcript, m.read)
const state = db.prepare('INSERT INTO state (key, value) VALUES (?, ?)')
for (const [key, value] of Object.entries(seed.state)) state.run(key, String(value))
db.exec('COMMIT')
db.close()
`

const FULL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/

// Every run needs a fixed end (--hasta) so the output does not depend on the clock. --desde is optional:
// without it the legacy tool starts at last_summary_ts, or at --hasta minus horasPorDefecto, both fixed.
function validateRuns(slug, runs) {
  if (!Array.isArray(runs) || !runs.length) throw new Error(`[${slug}] the scenario has no runs`)
  for (const [i, run] of runs.entries()) {
    const label = `[${slug} run-${i + 1}]`
    if (run.args.some((a) => a === '--horas' || a.startsWith('--horas='))) throw new Error(`${label} --horas is not allowed: it depends on the clock`)
    if (run.args.some((a) => /^--(desde|hasta)=/.test(a))) throw new Error(`${label} use '--desde <value>' and '--hasta <value>', not the = form`)
    for (const flag of ['--desde', '--hasta']) {
      // parseArgs keeps the last occurrence, so a repeated flag could slip a clock-dependent value past this check
      if (run.args.filter((a) => a === flag).length > 1) throw new Error(`${label} ${flag} appears more than once`)
      const at = run.args.indexOf(flag)
      if (at < 0 && flag === '--desde') continue
      const value = at < 0 ? undefined : run.args[at + 1]
      if (!FULL_TIME.test(value ?? '')) throw new Error(`${label} ${flag} must be in the form 'YYYY-MM-DD HH:MM' (got ${JSON.stringify(value)})`)
    }
  }
}

function normalize(scenario) {
  const chats = scenario.chats.map((c) => ({
    jid: c.jid,
    name: c.name ?? null,
    is_group: c.is_group ?? (c.jid.endsWith('@g.us') ? 1 : 0),
    unread_count: c.unread_count ?? null,
  }))
  const contacts = (scenario.contacts ?? []).map((c) => ({ jid: c.jid, name: c.name ?? null, push_name: c.push_name ?? null }))
  const seq = new Map()
  const messages = scenario.messages.map((m) => {
    const n = (seq.get(m.chat) ?? 0) + 1
    seq.set(m.chat, n)
    const from_me = m.from_me ?? 0
    return {
      chat_jid: m.chat,
      id: m.id ?? `m${String(n).padStart(3, '0')}`,
      sender_jid: m.sender ?? (from_me || m.chat.endsWith('@g.us') ? null : m.chat),
      sender_name: m.sender_name ?? null,
      from_me,
      ts: toTs(m.at),
      kind: m.kind ?? 'text',
      text: m.text ?? null,
      transcript: m.transcript ?? null,
      read: m.read ?? 0,
    }
  })
  const seen = new Map()
  for (const m of messages) {
    const key = m.ts
    if (seen.has(key)) throw new Error(`Duplicate message timestamp ${fmtLocal(key)} (${seen.get(key)} and ${m.chat_jid}/${m.id}): SQLite order on ties is undefined`)
    seen.set(key, `${m.chat_jid}/${m.id}`)
  }
  const state = { ...(scenario.state ?? {}) }
  if (state.last_summary_ts != null && typeof state.last_summary_ts === 'string') state.last_summary_ts = toTs(state.last_summary_ts)
  return { chats, contacts, messages, state }
}

function snapshotDigests(dir) {
  const files = new Map()
  if (existsSync(dir)) for (const name of readdirSync(dir)) files.set(name, readFileSync(join(dir, name), 'utf8'))
  return files
}

function readDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return {
      outbox: db.prepare('SELECT id, text, sent_at FROM outbox ORDER BY id').all().map((r) => ({ ...r })),
      last: db.prepare("SELECT value FROM state WHERE key = 'last_summary_ts'").get()?.value ?? null,
    }
  } finally {
    db.close()
  }
}

async function runScenario(slug, tmp) {
  const scenario = (await import(pathToFileURL(join(SCENARIOS_DIR, `${slug}.mjs`)).href)).default
  validateRuns(slug, scenario.runs)
  const work = join(tmp, slug)
  const dataDir = join(work, 'data')
  mkdirSync(join(work, 'home'), { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  // Fresh project copy per scenario, so each one has its own config and prompt
  const root = join(work, 'root')
  mkdirSync(join(root, 'src'), { recursive: true })
  for (const file of LEGACY_FILES) copyFileSync(join(legacy, 'src', file), join(root, 'src', file))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(root, 'src', 'llm.js'), FAKE_LLM)
  writeFileSync(join(root, 'src', 'transcribe.js'), FAKE_TRANSCRIBE)
  const config = { whisper: { modelo: 'models/none.bin', idioma: 'es' }, ...scenario.config }
  writeFileSync(join(root, 'config.json'), json(config))
  writeFileSync(join(root, 'prompt.md'), scenario.prompt)
  writeFileSync(join(root, 'seed.mjs'), SEED)
  const responsesFile = join(work, 'responses.json')
  writeFileSync(responsesFile, json(scenario.llm))

  const env = (extra = {}) => ({
    PATH: process.env.PATH,
    TZ,
    WA_DATA_DIR: dataDir,
    HOME: join(work, 'home'),
    WG_RESPONSES_FILE: responsesFile,
    ...extra,
  })

  const seedFile = join(work, 'seed.json')
  writeFileSync(seedFile, json(normalize(scenario)))
  const seeded = spawnSync(process.execPath, ['--no-warnings', 'seed.mjs', seedFile], { cwd: root, env: env(), encoding: 'utf8' })
  if (seeded.status !== 0) throw new Error(`[${slug}] seed failed:\n${seeded.stdout}${seeded.stderr}`)

  // Outputs go to a staging dir; the real golden dir is replaced only if every run succeeds
  const outDir = join(work, 'out')
  const calledJids = new Set()
  const digestDir = join(dataDir, 'resumenes')
  const dbPath = join(dataDir, 'whatsapp.db')

  for (const [i, run] of scenario.runs.entries()) {
    const k = i + 1
    const label = `[${slug} run-${k}]`
    const recordFile = join(work, `calls-${k}.jsonl`)
    const systemFile = join(work, `system-${k}.txt`)
    writeFileSync(recordFile, '')
    // Empty the digest dir so any file present after the run was written by this run, even if a previous
    // run wrote the same name with the same content. The legacy tool never reads this dir.
    rmSync(digestDir, { recursive: true, force: true })
    mkdirSync(digestDir, { recursive: true })
    const outboxBefore = Math.max(0, ...readDb(dbPath).outbox.map((r) => r.id))

    const child = spawnSync(process.execPath, ['--no-warnings', 'src/summarize.js', ...run.args], {
      cwd: root,
      env: env({ WG_RECORD_FILE: recordFile, WG_SYSTEM_FILE: systemFile }),
      encoding: 'utf8',
    })
    if (child.status !== 0) throw new Error(`${label} exited with ${child.status}:\n${child.stdout}${child.stderr}`)

    const calls = readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const missing = calls.filter((c) => c.missing)
    if (missing.length) throw new Error(`${label} no fixed LLM response for: ${missing.map((c) => c.jid).join(', ')}`)

    for (const c of calls) calledJids.add(c.jid)
    const after = readDb(dbPath)
    const written = [...snapshotDigests(digestDir)]
    if (written.length > 1) throw new Error(`${label} more than one digest file was written: ${written.map(([n]) => n)}`)

    const dir = join(outDir, `run-${k}`)
    mkdirSync(dir, { recursive: true })
    const system = existsSync(systemFile) ? readFileSync(systemFile, 'utf8') : null
    writeFileSync(join(dir, 'llm-input.json'), json({ system, calls: calls.map(({ jid, chatName, isGroup, userMessage }) => ({ jid, chatName, isGroup, userMessage })) }))
    const added = after.outbox.filter((r) => r.id > outboxBefore)
    writeFileSync(join(dir, 'whatsapp-parts.json'), json(added.map((r) => r.text)))
    if (written.length) writeFileSync(join(dir, 'digest.md'), written[0][1])
    const last = after.last
    writeFileSync(
      join(dir, 'state.json'),
      json({
        last_summary_ts: last,
        last_summary_local: last == null ? null : fmtLocal(Number(last)),
        outbox: after.outbox.map((r) => ({ id: r.id, text: r.text, sent_at: r.sent_at })),
      }),
    )
    let stdout = child.stdout
    if (child.stderr) stdout += `\n--- stderr ---\n${child.stderr}`
    if (!written.length) stdout += '\n--- generator note: no digest file was produced in this run ---\n'
    writeFileSync(join(dir, 'stdout.txt'), stdout)
    console.log(`${label} done (${calls.length} LLM calls, ${added.length} outbox parts, digest ${written.length ? 'yes' : 'no'})`)
  }

  const defined = Object.keys(scenario.llm)
  const unused = defined.filter((jid) => !calledJids.has(jid))
  const undefinedCalls = [...calledJids].filter((jid) => !defined.includes(jid))
  if (unused.length || undefinedCalls.length) {
    throw new Error(`[${slug}] fixed LLM responses and called chats differ. Never called: ${unused.join(', ') || '-'}. Called without response: ${undefinedCalls.join(', ') || '-'}`)
  }

  const finalDir = join(HERE, slug)
  rmSync(finalDir, { recursive: true, force: true })
  cpSync(outDir, finalDir, { recursive: true })
  console.log(`[${slug}] written to ${finalDir}`)
}

const all = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.mjs')).map((f) => basename(f, '.mjs')).sort()
const slugs = positionals.length ? positionals : all
for (const slug of slugs) if (!all.includes(slug)) throw new Error(`Unknown scenario: ${slug}`)

const tmp = mkdtempSync(join(tmpdir(), 'golden-'))
try {
  for (const slug of slugs) await runScenario(slug, tmp)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
