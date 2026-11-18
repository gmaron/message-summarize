import { afterAll, describe, expect, it } from 'vitest'
import { createGenerateDigest } from '../../src/application/generate-digest.js'
import type { SummarizeRequest } from '../../src/application/ports/summarizer.js'
import { parseDigestSettings } from '../../src/domain/settings.js'
import { createRenderers } from '../../src/infrastructure/rendering/index.js'
import { FakeSummarizer, FixedClock } from '../support/application-fakes.js'
import {
  frozenSlugs,
  initialPointer,
  llmResult,
  loadScenario,
  parseRunArgs,
  promptTemplateOf,
  readFrozen,
  runCount,
  scenarioSlugs,
  seedSource,
  settingsInput,
} from '../support/golden-legacy.js'
import { backends, type PersistenceBackend } from '../support/persistence-backends.js'

/**
 * Golden harness (phase 1): runs GenerateDigest on every scenario of test/golden/ and compares, per run, byte for
 * byte, with the files frozen from the legacy tool. stdout.txt is not compared.
 *
 * Approved differences from the legacy output:
 * - A preview (--dry-run) saves nothing, not even the digest file, but returns the digest. The harness compares
 *   the returned digest with the frozen digest.md.
 * - The legacy failures that cannot be frozen (README, "Legacy failures that are not frozen") have no scenario.
 */

const TZ = 'America/Argentina/Buenos_Aires'

const frozenJson = (slug: string, run: number, file: string): unknown => {
  const text = readFrozen(slug, run, file)
  if (text === null) throw new Error(`Missing frozen file ${slug}/run-${run}/${file}`)
  return JSON.parse(text)
}

interface RunOutput {
  /** The system prompt of every call, or the rendered one when the run made no calls. */
  systems: string[]
  calls: { jid: string; chatName: string; isGroup: boolean; userMessage: string }[]
  parts: string[]
  /** The digest the use case returned. */
  digest: string | null
  /** The digest kept in the history by this run: null when nothing was saved. */
  saved: string | null
  changed: boolean
  preview: boolean
  pointer: number | null
  outbox: { id: number; text: string; sent_at: null }[]
}

async function runScenario(
  slug: string,
  backend: PersistenceBackend,
  fixtures: { close(): void }[],
): Promise<RunOutput[]> {
  const scenario = await loadScenario(slug)
  const sourceFixture = backend.source()
  fixtures.push(sourceFixture)
  seedSource(scenario, sourceFixture.seed)
  const source = sourceFixture.source
  const storeFixture = await backend.store(initialPointer(scenario))
  fixtures.push(storeFixture)
  const store = storeFixture.store
  const parsed = parseDigestSettings(settingsInput(scenario.config))
  if (!parsed.ok) throw new Error(`Invalid settings in ${slug}: ${JSON.stringify(parsed.error)}`)
  const settings = parsed.value
  const renderers = createRenderers('es', TZ)
  const template = promptTemplateOf(scenario.prompt)
  const outputs: RunOutput[] = []

  for (const run of scenario.runs) {
    const summarizer = new FakeSummarizer((request: SummarizeRequest) =>
      llmResult(scenario.llm[request.conversation.id], request.conversation.id),
    )
    const generate = createGenerateDigest({
      source,
      summarizer,
      store,
      clock: new FixedClock(0), // every run has --hasta, so the clock is never read
      renderers,
    })
    const outboxBefore = storeFixture.outbox().length
    const historyBefore = storeFixture.history().length
    const pointerBefore = await storeFixture.pointer()
    const result = await generate({
      ...parseRunArgs(run.args),
      settings,
      promptTemplate: template,
      platformName: 'WhatsApp',
    })
    if (!result.ok) throw new Error(`${slug}: the run failed with ${JSON.stringify(result.error)}`)
    const report = result.value
    const outboxNow = storeFixture.outbox()
    const historyNow = storeFixture.history()
    const pointerNow = await storeFixture.pointer()
    outputs.push({
      // The legacy fake LLM wrote the system prompt when it was loaded, even in a run with no chats to summarize.
      systems:
        summarizer.calls.length > 0
          ? summarizer.calls.map((c) => c.systemPrompt)
          : [renderers.systemPrompt.render(template, settings.ownerName)],
      calls: summarizer.calls.map((c) => ({
        jid: c.conversation.id,
        chatName: c.conversation.name,
        isGroup: c.conversation.isGroup,
        userMessage: c.transcript,
      })),
      parts: outboxNow.slice(outboxBefore),
      digest: report.digest === null ? null : report.digest.fullLines.join('\n'),
      saved: historyNow.slice(historyBefore).at(-1)?.text ?? null,
      // A preview saves nothing: no digest, no parts and the pointer where it was.
      changed: historyNow.length !== historyBefore || outboxNow.length !== outboxBefore || pointerNow !== pointerBefore,
      preview: report.preview,
      pointer: pointerNow,
      outbox: outboxNow.map((text, i) => ({ id: i + 1, text, sent_at: null })),
    })
  }
  return outputs
}

it('has one frozen directory per scenario', () => {
  expect(frozenSlugs()).toEqual(scenarioSlugs())
})

// The same 14 scenarios through every persistence backend: the real adapter must reproduce the legacy output.
for (const backend of backends) {
  describe(`golden files (${backend.name})`, () => {
    const fixtures: { close(): void }[] = []
    afterAll(() => {
      for (const fixture of fixtures) fixture.close()
    })

    for (const slug of scenarioSlugs()) {
      describe(slug, () => {
        // One execution per scenario: its runs share the store and the pointer, in order.
        const outputs = runScenario(slug, backend, fixtures)
        outputs.catch(() => {}) // the tests below rethrow it; this only avoids an unhandled rejection

        it('has a frozen directory for every run', async () => {
          expect(runCount(slug)).toBe((await outputs).length)
        })

        const runs = runCount(slug)
        for (let k = 1; k <= runs; k++) {
          describe(`run-${k}`, () => {
            it('llm-input.json', async () => {
              const out = (await outputs)[k - 1]
              const frozen = frozenJson(slug, k, 'llm-input.json') as { system: string; calls: unknown[] }
              // Every call must carry the frozen system prompt, not only the first.
              expect(out?.systems.map((system) => ({ system }))).toEqual(
                out?.systems.map(() => ({ system: frozen.system })),
              )
              expect(out?.calls).toEqual(frozen.calls)
            })

            it('whatsapp-parts.json', async () => {
              expect((await outputs)[k - 1]?.parts).toEqual(frozenJson(slug, k, 'whatsapp-parts.json'))
            })

            it('digest.md', async () => {
              const out = (await outputs)[k - 1]
              const frozen = readFrozen(slug, k, 'digest.md')
              // The digest the use case returns is always the frozen one.
              expect(out?.digest).toBe(frozen)
              if (out?.preview) {
                // Approved change: the legacy tool wrote the file in a preview, the new code saves nothing.
                expect(out.changed).toBe(false)
              } else {
                // A normal run keeps the same text in the history.
                expect(out?.saved).toBe(frozen)
              }
            })

            it('state.json', async () => {
              const out = (await outputs)[k - 1]
              const frozen = frozenJson(slug, k, 'state.json') as { last_summary_ts: string | null; outbox: unknown[] }
              expect({
                last_summary_ts: out?.pointer == null ? null : String(out.pointer),
                outbox: out?.outbox,
              }).toEqual({ last_summary_ts: frozen.last_summary_ts, outbox: frozen.outbox })
            })
          })
        }
      })
    }
  })
}
