// Extracts the evaluation transcripts of the small Ollama model (RF-45) from the golden files.
//
//   node test/eval/extract-cases.mjs
//
// Every conversation the legacy tool sent to its LLM in a golden run (test/golden/NN-slug/run-K/llm-input.json) is a
// case: the exact text the summarizer receives, plus who the owner is. The same conversation appearing in several
// scenarios (02 on/off, 09 on/off) is kept once. The output is test/eval/ollama/transcripts.json.
//
// The reference labels are NOT here: they are written by hand in test/eval/ollama/labels.json. The answer the legacy
// tool got for a conversation (fixed in the scenario) is copied as `legacyNeedsReply` only so a person can cross-check
// a label; the harness never reads it.
//
// All the data is made up (see test/golden/README.md).

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const golden = join(root, 'golden')
const out = join(root, 'eval', 'ollama', 'transcripts.json')

const slugs = readdirSync(golden, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d\d-/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const byTranscript = new Map()
for (const slug of slugs) {
  const scenario = (await import(pathToFileURL(join(golden, 'scenarios', `${slug}.mjs`)).href)).default
  const runs = readdirSync(join(golden, slug), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^run-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
  for (const run of runs) {
    const file = join(golden, slug, run, 'llm-input.json')
    if (!existsSync(file)) continue
    const input = JSON.parse(readFileSync(file, 'utf8'))
    for (const call of input.calls) {
      if (byTranscript.has(call.userMessage)) continue
      const legacy = scenario.llm?.[call.jid]
      byTranscript.set(call.userMessage, {
        source: `${slug}/${run}`,
        owner: scenario.config.miNombre,
        chatName: call.chatName,
        isGroup: call.isGroup,
        transcript: call.userMessage,
        legacyNeedsReply: typeof legacy?.necesita_respuesta === 'boolean' ? legacy.necesita_respuesta : null,
      })
    }
  }
}

const cases = [...byTranscript.values()].map((entry, index) => ({
  id: `c${String(index + 1).padStart(2, '0')}`,
  ...entry,
}))
writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`)
console.log(`${cases.length} cases written to ${out}`)
