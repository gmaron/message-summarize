import { afterEach, describe, expect, it } from 'vitest'
import type { SummarizeRequest, Summarizer } from '../../src/application/ports/summarizer.js'
import { parseSummaryResponse } from '../../src/domain/summary.js'
import { type FakeServer, startFakeServer } from '../support/fake-http-server.js'

export const VALID_SUMMARY = {
  resumen: 'Hablaron de la cena.',
  pendientes: ['Llevar el postre'],
  necesita_respuesta: true,
  prioridad: 'media',
}

export const REQUEST: SummarizeRequest = {
  conversation: { id: 'c1', name: 'Ana', isGroup: false },
  systemPrompt: 'Sistema: resumí el chat.',
  transcript: 'Chat con: Ana\n\nAna: ¿llevás el postre?',
}

/** No wait between retries in the tests: the contract is about the answers, not about time. */
export const NO_WAIT = { sleep: async () => {}, random: () => 0 }

/** What a backend gives the contract: an adapter pointed at a fake server, and how that provider words its answers. */
export interface SummarizerFixture {
  readonly summarizer: Summarizer
  readonly server: FakeServer
}

export interface SummarizerBackend {
  readonly name: string
  /** An adapter for the fake server at `baseUrl`. `timeoutMs` is for the timeout test. */
  make(baseUrl: string, options: { readonly timeoutMs?: number }): Summarizer
  /** The body of a successful answer of this provider whose model said `text`. */
  answer(text: string): string
}

/**
 * Contract of the Summarizer port (src/application/ports/summarizer.ts) for every adapter that talks HTTP: what a good
 * answer, a bad answer, a failing server and a slow one come to. The adapters of the CLI have their own tests, as they
 * run a process and not a server.
 */
export function describeSummarizerContract(backend: SummarizerBackend): void {
  describe(`Summarizer contract (${backend.name})`, () => {
    const servers: FakeServer[] = []
    const open = async (options: { timeoutMs?: number } = {}): Promise<SummarizerFixture> => {
      const server = await startFakeServer()
      servers.push(server)
      return { summarizer: backend.make(server.baseUrl, options), server }
    }
    afterEach(async () => {
      await Promise.all(servers.splice(0).map((server) => server.close()))
    })

    it('returns the summary the model produced', async () => {
      const { summarizer, server } = await open()
      server.script({ body: backend.answer(JSON.stringify(VALID_SUMMARY)) })
      expect(await summarizer.summarize(REQUEST)).toEqual({ ok: true, value: VALID_SUMMARY })
    })

    it('sends the system prompt and the transcript to the model, and nothing of them in the URL', async () => {
      const { summarizer, server } = await open()
      server.script({ body: backend.answer(JSON.stringify(VALID_SUMMARY)) })
      await summarizer.summarize(REQUEST)
      const sent = server.seen[0]
      expect(sent?.method).toBe('POST')
      // As JSON text, so the line breaks of the transcript are escaped.
      expect(sent?.raw).toContain(JSON.stringify(REQUEST.systemPrompt).slice(1, -1))
      expect(sent?.raw).toContain(JSON.stringify(REQUEST.transcript).slice(1, -1))
      expect(decodeURIComponent(sent?.url ?? '')).not.toContain('postre')
    })

    it('fails when the content is not JSON, without throwing and without quoting it', async () => {
      const { summarizer, server } = await open()
      server.script({ body: backend.answer('SECRETO-DEL-CHAT: no soy JSON') })
      const result = await summarizer.summarize(REQUEST)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).not.toContain('SECRETO-DEL-CHAT')
    })

    it('never passes off JSON that fails the summary schema as a valid summary', async () => {
      const { summarizer, server } = await open()
      server.script({ body: backend.answer(JSON.stringify({ ...VALID_SUMMARY, prioridad: 'urgente' })) })
      const result = await summarizer.summarize(REQUEST)
      // The port lets an adapter return the JSON as is (the use case validates it again), or fail the call (RF-30).
      expect(!result.ok || !parseSummaryResponse(result.value).ok).toBe(true)
    })

    it('fails when the answer is not even a JSON body', async () => {
      const { summarizer, server } = await open()
      server.script({ body: '<html>gateway</html>' })
      expect((await summarizer.summarize(REQUEST)).ok).toBe(false)
    })

    it('fails when the server answers with an error status', async () => {
      const { summarizer, server } = await open()
      server.script({ status: 500, body: JSON.stringify({ error: { message: 'boom' } }) })
      const result = await summarizer.summarize(REQUEST)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('500')
    })

    it('fails when the server does not answer in time', async () => {
      const { summarizer, server } = await open({ timeoutMs: 100 })
      server.script({ hang: true })
      const result = await summarizer.summarize(REQUEST)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/timed out/)
    })

    it('fails when the server cannot be reached', async () => {
      const { summarizer, server } = await open()
      await server.close()
      expect((await summarizer.summarize(REQUEST)).ok).toBe(false)
    })
  })
}
