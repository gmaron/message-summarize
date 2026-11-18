import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SummarizeRequest } from '../../../src/application/ports/summarizer.js'
import { ok, type Result } from '../../../src/domain/result.js'
import { type AppConfig, parseConfig } from '../../../src/main/config.js'
import { runDigest } from '../../../src/main/run-digest.js'
import { disposeHarnesses, makeHarness, seedMessages } from '../../support/cli-harness.js'

const log = vi.hoisted(() => ({ calls: [] as { kind: string; conversation: string }[] }))

// The real providers spawn a CLI or call a server: fakes that record the calls stand in for them, and the real
// composition (the local-only router, the fallback) stays, so what is tested is that a reconfiguration rebuilds it whole.
vi.mock('../../../src/infrastructure/llm/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/infrastructure/llm/index.js')>()
  const fake = (kind: string) =>
    class {
      async summarize(request: SummarizeRequest): Promise<Result<unknown, string>> {
        log.calls.push({ kind, conversation: request.conversation.name })
        return ok({ resumen: kind, pendientes: [], necesita_respuesta: false, prioridad: 'baja' })
      }
    }
  return { ...original, ClaudeCliSummarizer: fake('claude-cli'), OllamaSummarizer: fake('ollama') }
})

const { createRuntime } = await import('../../../src/main/runtime.js')

const config = (input: Record<string, unknown>): AppConfig => {
  const parsed = parseConfig({ timezone: 'UTC', language: 'en', ...input }, 'UTC')
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
  return parsed.value
}

beforeEach(() => {
  log.calls.length = 0
})
afterEach(disposeHarnesses)

async function open(initial: AppConfig) {
  const h = await makeHarness({ summarizer: undefined })
  // `makeHarness` always passes its own summarizer: this runtime is built from the configuration alone.
  const runtime = createRuntime({ layout: h.account, config: initial, env: {}, clock: h.clock })
  return { h, runtime }
}

describe('Runtime.reconfigure', () => {
  it('swaps the configuration, the renderers and the use case, and keeps everything else', async () => {
    const { runtime } = await open(config({}))
    try {
      expect(runtime.generateDigest).toBeNull()
      const { db, store, capture, ownIds } = runtime
      runtime.reconfigure(
        config({ language: 'es', timezone: 'America/Montevideo', provider: { primary: 'claude-cli' } }),
      )
      expect(runtime.config).toMatchObject({ language: 'es', timezone: 'America/Montevideo' })
      expect(runtime.generateDigest).not.toBeNull()
      expect([runtime.db, runtime.store, runtime.capture, runtime.ownIds]).toEqual([db, store, capture, ownIds])
      expect(runtime.renderers).toBeDefined()
      runtime.reconfigure(config({}))
      expect(runtime.generateDigest).toBeNull()
    } finally {
      runtime.close()
    }
  })

  it('a use case taken before keeps the configuration it had (a digest in progress)', async () => {
    const { h, runtime } = await open(config({ provider: { primary: 'claude-cli' } }))
    try {
      await seedMessages(runtime, [{ id: 'm1', text: 'hello', timestamp: h.clock.time - 3_600_000 }])
      const before = runtime.generateDigest
      runtime.reconfigure(config({}))
      expect(runtime.generateDigest).toBeNull()
      expect(before).not.toBeNull()
      const run = await before?.({
        preview: true,
        settings: runtime.config.digest,
        promptTemplate: null,
        platformName: 'WhatsApp',
        concurrency: 1,
      })
      expect(run?.ok).toBe(true)
      expect(log.calls.map((call) => call.kind)).toEqual(['claude-cli'])
    } finally {
      runtime.close()
    }
  })

  it('keeps the local-only router outermost after a reconfiguration: a local chat never reaches the external provider (RF-43)', async () => {
    const { h, runtime } = await open(config({ provider: { primary: 'claude-cli' } }))
    try {
      await seedMessages(runtime, [
        {
          id: 'a1',
          text: 'private plan',
          conversationId: '5491100000001@s.whatsapp.net',
          conversationName: 'Ana Test',
          timestamp: h.clock.time - 3_600_000,
        },
        {
          id: 'b1',
          text: 'lunch',
          conversationId: '5491100000002@s.whatsapp.net',
          conversationName: 'Beto Test',
          timestamp: h.clock.time - 3_500_000,
        },
      ])
      // Before: nothing is local, both chats go to the CLI.
      expect((await runDigest(runtime, { preview: true })).ok).toBe(true)
      expect(log.calls.map((call) => call.kind)).toEqual(['claude-cli', 'claude-cli'])

      log.calls.length = 0
      runtime.reconfigure(
        config({
          localOnlyPatterns: ['Ana'],
          provider: { primary: 'claude-cli', ollama: { model: 'llama3' } },
        }),
      )
      expect((await runDigest(runtime, { preview: true })).ok).toBe(true)
      expect(log.calls.filter((call) => call.conversation === 'Ana Test').map((call) => call.kind)).toEqual(['ollama'])
      expect(log.calls.filter((call) => call.conversation === 'Beto Test').map((call) => call.kind)).toEqual([
        'claude-cli',
      ])
    } finally {
      runtime.close()
    }
  })

  it('capture reads the new exclusion patterns on its next event', async () => {
    const { h, runtime } = await open(config({}))
    const messages = () => (runtime.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
    try {
      await seedMessages(runtime, [{ id: 'a1', text: 'one', timestamp: h.clock.time - 1_000 }])
      expect(messages()).toBe(1)
      runtime.reconfigure(config({ excludePatterns: ['Ana'] }))
      await seedMessages(runtime, [{ id: 'a2', text: 'two', timestamp: h.clock.time - 900 }])
      expect(messages()).toBe(1)
      runtime.reconfigure(config({}))
      await seedMessages(runtime, [{ id: 'a3', text: 'three', timestamp: h.clock.time - 800 }])
      expect(messages()).toBe(2)
    } finally {
      runtime.close()
    }
  })

  it('a summarizer given in the options is not replaced by a reconfiguration', async () => {
    const h = await makeHarness()
    const runtime = h.runtime()
    try {
      const before = runtime.generateDigest
      expect(before).not.toBeNull()
      runtime.reconfigure(config({ language: 'es' }))
      expect(runtime.generateDigest).not.toBeNull()
      expect(runtime.config.language).toBe('es')
    } finally {
      runtime.close()
    }
  })

  it('a stricter configuration with local-only chats but no Ollama model still never reaches the external provider (RF-43)', async () => {
    const { h, runtime } = await open(config({ provider: { primary: 'claude-cli' } }))
    try {
      await seedMessages(runtime, [
        {
          id: 'a1',
          text: 'private plan',
          conversationId: '5491100000001@s.whatsapp.net',
          conversationName: 'Ana Test',
          timestamp: h.clock.time - 3_600_000,
        },
      ])
      // What the host builds from an invalid file that only ADDS a privacy entry: the last valid config plus the list.
      runtime.reconfigure({ ...runtime.config, localOnlyPatterns: ['Ana'] })
      await runDigest(runtime, { preview: true })
      expect(log.calls.map((call) => call.kind)).toEqual(['ollama'])
    } finally {
      runtime.close()
    }
  })
})
