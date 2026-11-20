import { describe, expect, it } from 'vitest'
import type { SummarizeRequest, SummarizeResult, Summarizer } from '../../../src/application/ports/summarizer.js'
import { err, ok } from '../../../src/domain/result.js'
import {
  composeSummarizer,
  FallbackSummarizer,
  LOCAL_ONLY_UNAVAILABLE,
  LocalOnlyRouter,
} from '../../../src/infrastructure/llm/index.js'

const VALID = { resumen: 'r', pendientes: [], necesita_respuesta: false, prioridad: 'alta' }

class Fake implements Summarizer {
  readonly requests: SummarizeRequest[] = []
  constructor(private readonly answer: SummarizeResult) {}
  async summarize(request: SummarizeRequest) {
    this.requests.push(request)
    return this.answer
  }
}

const req = (id: string, name: string): SummarizeRequest => ({
  conversation: { id, name, isGroup: false },
  systemPrompt: 's',
  transcript: 't',
})

describe('FallbackSummarizer (RF-42)', () => {
  it('returns the primary answer and does not call the fallback when it is valid', async () => {
    const primary = new Fake(ok(VALID))
    const fallback = new Fake(ok({ other: true }))
    expect(await new FallbackSummarizer(primary, fallback).summarize(req('1', 'A'))).toEqual(ok(VALID))
    expect(fallback.requests).toHaveLength(0)
  })

  it('uses the fallback when the primary fails', async () => {
    const fallback = new Fake(ok(VALID))
    const result = await new FallbackSummarizer(new Fake(err('down')), fallback).summarize(req('1', 'A'))
    expect(result).toEqual(ok(VALID))
    expect(fallback.requests).toEqual([req('1', 'A')])
  })

  it('uses the fallback when the primary answer fails the schema', async () => {
    const fallback = new Fake(ok(VALID))
    const bad = { resumen: 'x', pendientes: [], necesita_respuesta: false, prioridad: 'urgente' }
    expect(await new FallbackSummarizer(new Fake(ok(bad)), fallback).summarize(req('1', 'A'))).toEqual(ok(VALID))
    expect(fallback.requests).toHaveLength(1)
  })

  it('reports both reasons when both fail', async () => {
    const result = await new FallbackSummarizer(new Fake(err('down')), new Fake(err('also down'))).summarize(
      req('1', 'A'),
    )
    expect(result).toEqual(err('down; fallback: also down'))
  })

  it('reports a schema failure of the primary together with the fallback failure', async () => {
    const result = await new FallbackSummarizer(new Fake(ok('nope')), new Fake(err('down'))).summarize(req('1', 'A'))
    expect(result).toEqual(err('invalid summary: the response must be a JSON object; fallback: down'))
  })
})

describe('LocalOnlyRouter with a function for its patterns (RF-43)', () => {
  it('reads the patterns on every conversation, so a mark made meanwhile applies to the next one', async () => {
    const external = new Fake(ok(VALID))
    const local = new Fake(ok(VALID))
    let patterns: readonly string[] = []
    const router = composeSummarizer({ primary: external, local, localOnlyPatterns: () => patterns })
    await router.summarize(req('a', 'A'))
    patterns = ['id:b']
    await router.summarize(req('b', 'B'))
    await router.summarize(req('a', 'A'))
    expect(external.requests.map((r) => r.conversation.id)).toEqual(['a', 'a'])
    expect(local.requests.map((r) => r.conversation.id)).toEqual(['b'])
  })
})

describe('LocalOnlyRouter (RF-43)', () => {
  const patterns = ['familia', '9911963367943']

  it('sends ordinary conversations to the external summarizer', async () => {
    const external = new Fake(ok(VALID))
    const local = new Fake(ok({ local: true }))
    expect(await new LocalOnlyRouter(external, local, patterns).summarize(req('9', 'Trabajo'))).toEqual(ok(VALID))
    expect(local.requests).toHaveLength(0)
  })

  it('sends a conversation matching by name (case-insensitive substring) to the local one', async () => {
    const external = new Fake(ok(VALID))
    const local = new Fake(ok({ local: true }))
    const result = await new LocalOnlyRouter(external, local, patterns).summarize(req('9', 'Grupo FAMILIA Pérez'))
    expect(result).toEqual(ok({ local: true }))
    expect(external.requests).toHaveLength(0)
  })

  it('sends a conversation matching by id to the local one', async () => {
    const external = new Fake(ok(VALID))
    const local = new Fake(ok({ local: true }))
    await new LocalOnlyRouter(external, local, patterns).summarize(req('9911963367943@s.whatsapp.net', 'X'))
    expect(local.requests).toHaveLength(1)
    expect(external.requests).toHaveLength(0)
  })

  it('never reaches the external summarizer when the local one fails', async () => {
    const external = new Fake(ok(VALID))
    const local = new Fake(err('ollama down'))
    const result = await new LocalOnlyRouter(external, local, patterns).summarize(req('9', 'familia'))
    expect(result).toEqual(err('ollama down'))
    expect(external.requests).toHaveLength(0)
  })

  it('fails with localOnlyUnavailable and never reaches the external one when there is no local summarizer', async () => {
    const external = new Fake(ok(VALID))
    const result = await new LocalOnlyRouter(external, undefined, patterns).summarize(req('9', 'familia'))
    expect(result).toEqual(err(LOCAL_ONLY_UNAVAILABLE))
    expect(LOCAL_ONLY_UNAVAILABLE).toBe('localOnlyUnavailable')
    expect(external.requests).toHaveLength(0)
  })

  it('with no patterns everything goes to the external one', async () => {
    const external = new Fake(ok(VALID))
    await new LocalOnlyRouter(external, undefined, []).summarize(req('9', 'familia'))
    expect(external.requests).toHaveLength(1)
  })

  it('composeSummarizer: a local-only chat whose local call fails never reaches the primary or the backup', async () => {
    const primary = new Fake(err('down'))
    const backup = new Fake(ok(VALID))
    const composed = composeSummarizer({
      primary,
      backup,
      local: new Fake(err('ollama down')),
      localOnlyPatterns: patterns,
    })
    expect(await composed.summarize(req('9', 'familia'))).toEqual(err('ollama down'))
    expect(primary.requests).toHaveLength(0)
    expect(backup.requests).toHaveLength(0)
  })

  it('composeSummarizer: without a local summarizer a local-only chat fails and reaches nobody', async () => {
    const primary = new Fake(ok(VALID))
    const backup = new Fake(ok(VALID))
    const composed = composeSummarizer({ primary, backup, localOnlyPatterns: patterns })
    expect(await composed.summarize(req('9', 'familia'))).toEqual(err(LOCAL_ONLY_UNAVAILABLE))
    expect(primary.requests).toHaveLength(0)
    expect(backup.requests).toHaveLength(0)
  })

  it('composeSummarizer: ordinary chats use primary then backup, and work without a backup', async () => {
    const backup = new Fake(ok(VALID))
    const withBackup = composeSummarizer({ primary: new Fake(err('down')), backup, localOnlyPatterns: patterns })
    expect(await withBackup.summarize(req('1', 'Trabajo'))).toEqual(ok(VALID))
    expect(backup.requests).toHaveLength(1)
    const alone = composeSummarizer({ primary: new Fake(ok(VALID)), localOnlyPatterns: [] })
    expect(await alone.summarize(req('1', 'Trabajo'))).toEqual(ok(VALID))
  })
})

describe('the provider of an answer survives the wrappers (RF-74)', () => {
  const named = (provider: string, value: unknown = VALID): SummarizeResult => ({ ok: true, value, provider })

  it('keeps the primary name when the primary answers, and the fallback name when it does not', async () => {
    const primary = new FallbackSummarizer(new Fake(named('claude-cli')), new Fake(named('ollama')))
    expect(await primary.summarize(req('1', 'A'))).toMatchObject({ ok: true, provider: 'claude-cli' })
    const backup = new FallbackSummarizer(new Fake(err('down')), new Fake(named('ollama')))
    expect(await backup.summarize(req('1', 'A'))).toMatchObject({ ok: true, provider: 'ollama' })
    const afterSchemaFailure = new FallbackSummarizer(
      new Fake(named('claude-cli', { resumen: 'x' })),
      new Fake(named('ollama')),
    )
    expect(await afterSchemaFailure.summarize(req('1', 'A'))).toMatchObject({ ok: true, provider: 'ollama' })
  })

  it('composeSummarizer passes the name of the external and of the local provider through', async () => {
    const summarizer = composeSummarizer({
      primary: new Fake(named('claude-cli')),
      local: new Fake(named('ollama')),
      localOnlyPatterns: ['secret'],
    })
    expect(await summarizer.summarize(req('1', 'Ana'))).toMatchObject({ provider: 'claude-cli' })
    expect(await summarizer.summarize(req('2', 'Secret chat'))).toMatchObject({ provider: 'ollama' })
  })
})
