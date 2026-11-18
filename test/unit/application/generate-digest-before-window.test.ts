import { describe, expect, it } from 'vitest'
import { createGenerateDigest } from '../../../src/application/generate-digest.js'
import { DEFAULT_SETTINGS } from '../../../src/domain/settings.js'
import type { SummaryWindow } from '../../../src/domain/window.js'
import { createRenderers } from '../../../src/infrastructure/rendering/index.js'
import { FakeSummarizer, FixedClock, InMemorySource, InMemoryStore } from '../../support/application-fakes.js'
import { conversation, message } from '../domain/factories.js'
import { BA, ba } from '../rendering/support.js'

const UNTIL = ba(3, 10, 12, 0)
const SINCE = ba(3, 10, 0, 0)

function setup(beforeWindow?: (window: SummaryWindow) => Promise<void>) {
  const source = new InMemorySource()
  source.addConversation(conversation({ id: '5491100000001', name: 'Ana Gómez', participantId: '5491100000001' }))
  source.addParticipant({ id: '5491100000001', savedName: 'Ana Gómez', publicName: null })
  const seen: string[] = []
  // The hook is what makes an audio transcribed in time: it changes the message the source will give afterwards.
  const audio = message({
    id: 'a1',
    conversationId: '5491100000001',
    senderId: '5491100000001',
    kind: 'audio',
    text: '[audio]',
    timestamp: ba(3, 10, 8, 0),
  })
  source.addMessages(audio)
  const summarizer = new FakeSummarizer()
  const store = new InMemoryStore(null)
  const run = createGenerateDigest({
    source,
    summarizer,
    store,
    clock: new FixedClock(UNTIL),
    renderers: createRenderers('en', BA),
    ...(beforeWindow === undefined
      ? {}
      : {
          beforeWindow: async (window) => {
            seen.push(`${window.since}-${window.until}`)
            await beforeWindow(window)
            source.replaceMessages([{ ...audio, transcript: 'Hola, llego tarde.' }])
          },
        }),
  })
  const go = () =>
    run({
      until: UNTIL,
      from: SINCE,
      preview: false,
      settings: DEFAULT_SETTINGS,
      promptTemplate: null,
      platformName: 'WhatsApp',
    })
  return { go, summarizer, seen, store }
}

describe('GenerateDigest: beforeWindow (transcripts right before the digest, RF-15)', () => {
  it('runs once the window is known, before the conversations are read, so the transcript reaches the summarizer', async () => {
    const t = setup(async () => {})
    const result = await t.go()
    expect(result.ok).toBe(true)
    expect(t.seen).toEqual([`${SINCE}-${UNTIL}`])
    expect(t.summarizer.calls[0]?.transcript).toContain('🎤 (audio) Hola, llego tarde.')
  })

  it('without the hook the audio shows as not transcribed (transcription off, RF-21)', async () => {
    const t = setup()
    await t.go()
    expect(t.summarizer.calls[0]?.transcript).toContain('🎤 (audio not transcribed)')
  })

  it('whatever the hook does, even throwing, the digest is made', async () => {
    const t = setup(async () => {
      throw new Error('whisper blew up')
    })
    // The hook throws before the message is replaced: the digest still goes out, with the audio untranscribed.
    const result = await t.go()
    expect(result.ok).toBe(true)
    expect(t.summarizer.calls).toHaveLength(1)
    expect(t.summarizer.calls[0]?.transcript).toContain('🎤 (audio not transcribed)')
    expect(t.store.commits).toHaveLength(1)
  })

  it('is not called when the window is invalid (nothing is transcribed for a digest that does not happen)', async () => {
    const t = setup(async () => {})
    const source = new InMemorySource()
    let called = 0
    const run = createGenerateDigest({
      source,
      summarizer: new FakeSummarizer(),
      store: new InMemoryStore(null),
      clock: new FixedClock(UNTIL),
      renderers: createRenderers('en', BA),
      beforeWindow: async () => {
        called++
      },
    })
    const result = await run({
      until: UNTIL,
      from: UNTIL,
      preview: false,
      settings: DEFAULT_SETTINGS,
      promptTemplate: null,
      platformName: 'WhatsApp',
    })
    expect(result.ok).toBe(false)
    expect(called).toBe(0)
    expect(t.seen).toEqual([])
  })
})
