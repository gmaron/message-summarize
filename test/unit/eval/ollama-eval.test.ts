import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { OLLAMA_CANDIDATES, passesRf45 } from '../../../src/infrastructure/llm/index.js'
import {
  type CaseRecord,
  EVAL_DIR,
  type EvalCase,
  kindOf,
  loadCases,
  parseEvalArgs,
  renderTable,
  resultFileName,
  runEval,
  score,
} from '../../eval/ollama-eval.js'

// The fake Ollama answers by model name: "good" says what the label says, "half" always says false, "broken" sends
// text that is not JSON, "invalid" sends JSON with the wrong shape. It is on 127.0.0.1, which the network guard allows.

let cases: EvalCase[] = []
beforeAll(async () => {
  const loaded = await loadCases()
  if (!loaded.ok) throw new Error(loaded.error)
  cases = loaded.value
})

const dirs: string[] = []
let server: Server | undefined
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fakeOllama(): Promise<{
  baseUrl: string
  seen: { model: string; system: string; transcript: string; format: unknown }[]
}> {
  const seen: { model: string; system: string; transcript: string; format: unknown }[] = []
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const body = JSON.parse(raw) as {
        model: string
        format: unknown
        messages: { role: string; content: string }[]
      }
      const transcript = body.messages[1]?.content ?? ''
      seen.push({ model: body.model, system: body.messages[0]?.content ?? '', transcript, format: body.format })
      const expected = cases.find((item) => item.transcript === transcript)?.needsReply ?? false
      const summary = (needsReply: boolean) => ({
        resumen: 'x',
        pendientes: [],
        necesita_respuesta: needsReply,
        prioridad: 'media',
      })
      let content: string
      if (body.model === 'good') content = JSON.stringify(summary(expected))
      else if (body.model === 'half') content = JSON.stringify(summary(false))
      else if (body.model === 'invalid') content = JSON.stringify({ resumen: 'x' })
      else content = 'not json at all'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: { content } }))
    })
  })
  const started = server
  await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${(started.address() as AddressInfo).port}`, seen }
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'msum-eval-'))
  dirs.push(dir)
  const out: string[] = []
  const err: string[] = []
  return {
    dir,
    out,
    err,
    deps: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      today: () => '2026-11-17',
      resultsDir: dir,
    },
  }
}

describe('the evaluation set', () => {
  it('has a hand-written label with a reason for every case, and no case without one', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20)
    for (const item of cases) {
      expect(item.reason.length).toBeGreaterThan(10)
      expect(item.transcript).toMatch(/^(Chat con|Grupo): /)
    }
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length)
    // both classes are present, or agreement would reward always saying the same thing
    expect(cases.some((item) => item.needsReply)).toBe(true)
    expect(cases.some((item) => !item.needsReply)).toBe(true)
  })

  it('marks the filler cases JSON-only and keeps enough clear cases to judge agreement', () => {
    const jsonOnly = cases.filter((item) => item.jsonOnly).map((item) => item.id)
    expect(jsonOnly).toEqual(['c31', 'c32', 'c33', 'c34', 'c35', 'c36'])
    const clear = cases.filter((item) => kindOf(item) === 'clear')
    expect(clear.length).toBeGreaterThanOrEqual(50)
    expect(clear.some((item) => item.needsReply)).toBe(true)
    expect(clear.some((item) => !item.needsReply)).toBe(true)
    // the labelling rule decides these
    const label = (id: string) => cases.find((item) => item.id === id)?.needsReply
    expect([label('c25'), label('c44'), label('c04'), label('c37')]).toEqual([true, true, false, false])
    expect(kindOf({ doubtful: true, jsonOnly: true })).toBe('jsonOnly')
    expect(kindOf({ doubtful: true, jsonOnly: false })).toBe('doubtful')
  })

  it('refuses a label for another chat or an orphan one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'msum-eval-set-'))
    dirs.push(dir)
    const row = { id: 'c01', owner: 'A', chatName: 'Ana', isGroup: false, transcript: 'Chat con: Ana\n\nAna: hola' }
    writeFileSync(join(dir, 'transcripts.json'), JSON.stringify([row]))
    const labels = (list: unknown[]) => writeFileSync(join(dir, 'labels.json'), JSON.stringify({ labels: list }))
    labels([])
    expect(await loadCases(dir)).toEqual({ ok: false, error: 'case c01 has no label' })
    labels([{ id: 'c01', chat: 'Beto', needsReply: true, reason: 'because' }])
    expect(await loadCases(dir)).toMatchObject({ ok: false })
    labels([
      { id: 'c01', chat: 'Ana', needsReply: true, reason: 'because' },
      { id: 'c02', chat: 'Ana', needsReply: true, reason: 'because' },
    ])
    expect(await loadCases(dir)).toEqual({ ok: false, error: 'label c02 has no case' })
    labels([{ id: 'c01', chat: 'Ana', needsReply: true, reason: ' ' }])
    expect(await loadCases(dir)).toEqual({ ok: false, error: 'label c01 is incomplete' })
    labels([{ id: 'c01', chat: 'Ana', needsReply: true, reason: 'because', doubtful: true }])
    expect(await loadCases(dir)).toMatchObject({ ok: true, value: [{ doubtful: true, jsonOnly: false }] })
  })
})

describe('score and table', () => {
  const record = (
    agrees: boolean,
    valid = true,
    error: string | null = null,
    kind: CaseRecord['kind'] = 'clear',
  ): CaseRecord => ({
    id: 'c',
    kind,
    valid,
    answered: valid ? agrees : null,
    expected: true,
    agrees: agrees && valid,
    latencyMs: 100,
    error,
  })

  it('counts invalid JSON as a disagreement and applies the RF-45 limits', () => {
    const all = score('m', [
      record(true),
      record(true),
      record(true),
      record(true),
      record(true),
      record(true),
      record(true),
      record(true),
      record(true),
      record(true),
    ])
    expect(all).toMatchObject({ validJsonRate: 1, needsReplyAgreement: 1, passed: true, meanLatencyMs: 100, errors: 0 })
    const nine = score('m', [...Array.from({ length: 9 }, () => record(true)), record(false)])
    expect(nine).toMatchObject({ needsReplyAgreement: 0.9, passed: true })
    const eight = score('m', [...Array.from({ length: 8 }, () => record(true)), record(false), record(false)])
    expect(eight.passed).toBe(false)
    const oneInvalid = score('m', [...Array.from({ length: 9 }, () => record(true)), record(false, false, 'not JSON')])
    expect(oneInvalid).toMatchObject({ validJsonRate: 0.9, needsReplyAgreement: 0.9, passed: false, errors: 1 })
    expect(score('m', []).passed).toBe(false)
  })

  it('judges agreement on the clear cases and JSON validity on all of them', () => {
    const clear = Array.from({ length: 10 }, () => record(true))
    // doubtful cases that all disagree, and filler that disagrees, do not change the verdict
    const doubtful = [record(false, true, null, 'doubtful'), record(true, true, null, 'doubtful')]
    const filler = [record(false, true, null, 'jsonOnly')]
    expect(score('m', [...clear, ...doubtful, ...filler])).toMatchObject({
      validJsonRate: 1,
      needsReplyAgreement: 1,
      doubtfulAgreement: 0.5,
      overallAgreement: 11 / 12,
      passed: true,
    })
    // invalid JSON on a filler case still fails the 100% of valid JSON
    const badFiller = score('m', [...clear, record(false, false, 'not JSON', 'jsonOnly')])
    expect(badFiller).toMatchObject({ needsReplyAgreement: 1, validJsonRate: 10 / 11, passed: false })
    // filler alone has no clear case to judge
    expect(score('m', filler)).toMatchObject({ needsReplyAgreement: 0, doubtfulAgreement: 0, passed: false })
  })

  it('prints one row per model with its verdict and the three agreement figures', () => {
    const table = renderTable([
      score('a:1b', [record(true)]),
      score('b:2b', [record(false), record(true, false, 'boom'), record(true, true, null, 'doubtful')]),
    ])
    const lines = table.split('\n')
    expect(lines[0]).toMatch(
      /^model\s+calls\s+valid JSON\s+agreement \(clear\)\s+doubtful\s+overall\s+mean latency\s+errors\s+RF-45$/,
    )
    expect(lines[2]).toMatch(/^a:1b\s+1\s+100\.0%\s+100\.0%\s+0\.0%\s+100\.0%\s+100 ms\s+0\s+PASS$/)
    expect(lines[3]).toMatch(/^b:2b\s+3\s+66\.7%\s+0\.0%\s+100\.0%\s+33\.3%\s+100 ms\s+1\s+FAIL$/)
    expect(table).toContain('100.0% valid JSON (every case) and at least 90.0% agreement on the clear cases')
  })

  it('makes the model tag safe for a file name', () => {
    expect(resultFileName('2026-11-17', 'qwen3:4b')).toBe('2026-11-17-qwen3-4b.json')
    expect(resultFileName('2026-11-17', 'hf.co/user/model:Q4_K_M')).toBe('2026-11-17-hf.co-user-model-Q4-K-M.json')
  })
})

describe('parseEvalArgs', () => {
  it('reads models, base URL, runs and --allow-remote', () => {
    expect(
      parseEvalArgs(['--models', 'a, b', '--base-url', 'http://10.0.0.5:11434', '--runs', '3', '--allow-remote']),
    ).toEqual({
      ok: true,
      value: { models: ['a', 'b'], baseUrl: 'http://10.0.0.5:11434', runs: 3, allowRemote: true },
    })
    expect(parseEvalArgs(['--models', 'a'])).toEqual({
      ok: true,
      value: { models: ['a'], baseUrl: 'http://127.0.0.1:11434', runs: 1, allowRemote: false },
    })
  })

  it('rejects missing models, a bad run count and unknown options', () => {
    expect(parseEvalArgs([])).toMatchObject({ ok: false })
    expect(parseEvalArgs(['--models'])).toMatchObject({ ok: false })
    expect(parseEvalArgs(['--models', 'a', '--runs', '0'])).toMatchObject({ ok: false })
    expect(parseEvalArgs(['--models', 'a', '--runs', 'x'])).toMatchObject({ ok: false })
    expect(parseEvalArgs(['--models', 'a', '--base-url'])).toMatchObject({ ok: false })
    expect(parseEvalArgs(['--models', 'a', '--nope'])).toEqual({ ok: false, error: 'unknown option: --nope' })
  })
})

describe('runEval against a fake Ollama', () => {
  it('scores each model, prints the table, writes one results file per model and exits by the verdict', async () => {
    const fake = await fakeOllama()
    const h = harness()
    const code = await runEval(['--models', 'good,half,broken,invalid', '--base-url', fake.baseUrl], h.deps)
    expect(code).toBe(1)
    const table = h.out.join('\n')
    expect(table).toMatch(/good\s+\d+\s+100\.0%\s+100\.0%.*PASS/)
    expect(table).toMatch(/half\s+\d+\s+100\.0%\s+\d+\.\d%.*FAIL/)
    expect(table).toMatch(/broken\s+\d+\s+0\.0%\s+0\.0%.*FAIL/)
    expect(table).toMatch(/invalid\s+\d+\s+0\.0%\s+0\.0%.*FAIL/)
    // only the passing model gets the line that says how to record it
    expect(table).toContain(
      "good: set  evaluated: true, result: { date: '2026-11-17', validJsonRate: 1, needsReplyAgreement: 1 }",
    )
    expect(table).not.toContain('half: set')
    expect(readdirSync(h.dir).sort()).toEqual([
      '2026-11-17-broken.json',
      '2026-11-17-good.json',
      '2026-11-17-half.json',
      '2026-11-17-invalid.json',
    ])
    const good = JSON.parse(readFileSync(join(h.dir, '2026-11-17-good.json'), 'utf8'))
    expect(good).toMatchObject({
      model: 'good',
      needsReplyAgreement: 1,
      doubtfulAgreement: 1,
      overallAgreement: 1,
      calls: cases.length,
      passed: true,
      errors: 0,
      cases: cases.length,
      runs: 1,
    })
    expect(good.records).toHaveLength(cases.length)
    // no chat text in the results
    expect(JSON.stringify(good)).not.toContain('Chat con')
    const broken = JSON.parse(readFileSync(join(h.dir, '2026-11-17-broken.json'), 'utf8'))
    expect(broken.records[0].error).toBe('ollama returned content that is not JSON')
    const invalid = JSON.parse(readFileSync(join(h.dir, '2026-11-17-invalid.json'), 'utf8'))
    expect(invalid.records[0].error).toContain('invalid summary')
  })

  it('exits 0 when every model passes, and sends the production prompt, schema and transcript', async () => {
    const fake = await fakeOllama()
    const h = harness()
    expect(await runEval(['--models', 'good', '--base-url', fake.baseUrl, '--runs', '2'], h.deps)).toBe(0)
    expect(fake.seen).toHaveLength(cases.length * 2)
    const first = fake.seen[0]
    expect(first?.model).toBe('good')
    expect(first?.system).toContain('Sofía')
    expect(first?.system).not.toContain('{{name}}')
    expect(first?.system).not.toContain('<!--')
    expect(first?.transcript).toBe(cases[0]?.transcript)
    expect(first?.format).toMatchObject({ required: ['resumen', 'pendientes', 'necesita_respuesta', 'prioridad'] })
    const file = JSON.parse(readFileSync(join(h.dir, '2026-11-17-good.json'), 'utf8'))
    expect(file).toMatchObject({ calls: cases.length * 2, runs: 2 })
  })

  it('records an unreachable server as errors, not as a crash', async () => {
    const h = harness()
    // a port nobody listens on
    const fake = await fakeOllama()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
    expect(await runEval(['--models', 'good', '--base-url', fake.baseUrl], h.deps)).toBe(1)
    const file = JSON.parse(readFileSync(join(h.dir, '2026-11-17-good.json'), 'utf8'))
    expect(file.errors).toBe(cases.length)
    expect(file.records[0].error).toMatch(/could not reach ollama/)
  })

  it('refuses a base URL that is not on this machine unless --allow-remote is given', async () => {
    const h = harness()
    expect(await runEval(['--models', 'good', '--base-url', 'http://192.168.1.50:11434'], h.deps)).toBe(2)
    expect(h.err.join('\n')).toContain('--allow-remote')
    expect(readdirSync(h.dir)).toEqual([])
    expect(h.out).toEqual([])
  })

  it('reports usage errors and an inconsistent evaluation set with exit 2', async () => {
    const h = harness()
    expect(await runEval(['--runs', '2'], h.deps)).toBe(2)
    expect(h.err[0]).toContain('--models is required')
    const empty = mkdtempSync(join(tmpdir(), 'msum-eval-set-'))
    dirs.push(empty)
    writeFileSync(
      join(empty, 'transcripts.json'),
      JSON.stringify([{ id: 'c01', owner: 'A', chatName: 'Ana', isGroup: false, transcript: 't' }]),
    )
    writeFileSync(join(empty, 'labels.json'), '{"labels":[]}')
    const h2 = harness()
    expect(await runEval(['--models', 'good'], { ...h2.deps, casesDir: empty })).toBe(2)
    expect(h2.err[0]).toContain('inconsistent')
  })
})

describe('the table of candidates and the committed evaluations', () => {
  it('marks a candidate as evaluated when a committed results file says it passed', () => {
    const resultsDir = join(EVAL_DIR, 'results')
    if (!existsSync(resultsDir)) return
    for (const name of readdirSync(resultsDir).filter((file) => file.endsWith('.json'))) {
      const result = JSON.parse(readFileSync(join(resultsDir, name), 'utf8')) as {
        model: string
        validJsonRate: number
        needsReplyAgreement: number
      }
      const candidate = OLLAMA_CANDIDATES.find((entry) => entry.tag === result.model)
      if (candidate === undefined || !passesRf45(result)) continue
      expect(candidate.evaluated, `${result.model} passed in ${name} but the table says it is not evaluated`).toBe(true)
    }
  })

  it('has unique tags of 3 to 8 billion parameters and sensible numbers', () => {
    expect(new Set(OLLAMA_CANDIDATES.map((entry) => entry.tag)).size).toBe(OLLAMA_CANDIDATES.length)
    for (const entry of OLLAMA_CANDIDATES) {
      expect(entry.tag).toMatch(/^[a-z0-9.-]+:[a-z0-9._-]+$/)
      expect(entry.downloadGb).toBeGreaterThan(1)
      expect(entry.downloadGb).toBeLessThan(8)
      expect([8, 16]).toContain(entry.minRamGb)
      expect(entry.evaluated).toBe(Boolean(entry.result))
    }
  })
})
