import { afterEach, describe, expect, it } from 'vitest'
import type { Answerer, AnswerRequest } from '../../src/application/ports/answerer.js'

export const ANSWER_REQUEST: AnswerRequest = {
  systemPrompt: 'Sistema: respondé usando solo los chats.',
  input: 'Consulta: ¿quién pidió tortas?\n\nAna Pérez: quiero una torta para el sábado (SECRETO-DEL-CHAT)',
}

/** An adapter pointed at a fake backend (a fake HTTP server or a fake executable) that this fixture scripts. */
export interface AnswererFixture {
  readonly answerer: Answerer
  /** The next answer is this text, as this provider words it. */
  replyText(text: string): void
  /** The next answer is a failure of the provider (an error status, a non-zero exit). */
  replyFailure(): void
  /** The next answer never arrives. */
  replyHang(): void
  /** Everything the backend received for the first request, as text (to look for the prompt in it). */
  received(): string
  /** Closes the backend and makes the adapter unable to reach it, when the provider is a server. False: not applicable. */
  makeUnreachable(): Promise<boolean>
  close(): Promise<void>
}

export interface AnswererBackend {
  readonly name: string
  /** The non-empty name the adapter reports as the provider of a good answer. */
  readonly provider: string
  /** Whether the text never leaves the machine. */
  readonly local: boolean
  open(options: { readonly timeoutMs?: number }): Promise<AnswererFixture>
}

/**
 * Contract of the Answerer port (src/application/ports/answerer.ts) for every provider adapter: what a good answer, an
 * empty one, a failing provider and a slow one come to. No network: the backends are fakes.
 */
export function describeAnswererContract(backend: AnswererBackend): void {
  describe(`Answerer contract (${backend.name})`, () => {
    const fixtures: AnswererFixture[] = []
    const open = async (options: { timeoutMs?: number } = {}): Promise<AnswererFixture> => {
      const fixture = await backend.open(options)
      fixtures.push(fixture)
      return fixture
    }
    afterEach(async () => {
      await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
    })

    it('returns the free text the model wrote and names the provider', async () => {
      const f = await open()
      f.replyText('## Pedidos\n- Ana: una torta')
      const result = await f.answerer.answer(ANSWER_REQUEST)
      expect(result).toEqual({ ok: true, text: '## Pedidos\n- Ana: una torta', provider: backend.provider })
      expect(backend.provider).not.toBe('')
    })

    it('declares whether the text stays on the machine', async () => {
      const f = await open()
      expect(f.answerer.local).toBe(backend.local)
    })

    it('sends the system prompt and the input to the model', async () => {
      const f = await open()
      f.replyText('ok')
      await f.answerer.answer(ANSWER_REQUEST)
      const sent = f.received()
      expect(sent).toContain(JSON.stringify(ANSWER_REQUEST.systemPrompt).slice(1, -1))
      expect(sent).toContain(JSON.stringify(ANSWER_REQUEST.input).slice(1, -1))
    })

    it('fails on an empty answer', async () => {
      const f = await open()
      f.replyText('   ')
      expect((await f.answerer.answer(ANSWER_REQUEST)).ok).toBe(false)
    })

    it('fails when the provider fails, without throwing and without quoting the input', async () => {
      const f = await open()
      f.replyFailure()
      const result = await f.answerer.answer(ANSWER_REQUEST)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).not.toContain('SECRETO-DEL-CHAT')
    })

    it('fails when the provider does not answer in time', async () => {
      const f = await open({ timeoutMs: 150 })
      f.replyHang()
      const result = await f.answerer.answer(ANSWER_REQUEST)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/timed out/)
    })

    it('fails when the provider cannot be reached', async () => {
      const f = await open()
      if (!(await f.makeUnreachable())) return
      expect((await f.answerer.answer(ANSWER_REQUEST)).ok).toBe(false)
    })
  })
}
