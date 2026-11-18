import { describe, expect, it } from 'vitest'
import type { MessageReceived } from '../../../src/application/capture-events.js'
import { createCaptureMessages } from '../../../src/application/capture-messages.js'
import type { DownloadDescriptor } from '../../../src/application/ports/capture-repository.js'
import { FixedClock } from '../../support/application-fakes.js'
import { InMemoryCaptureRepository } from '../../support/capture-fakes.js'
import { message } from '../domain/factories.js'

const NOW = 5_000_000_000

function setup(patterns: readonly string[] = [], own: readonly string[] = []) {
  const clock = new FixedClock(NOW)
  const repository = new InMemoryCaptureRepository(() => clock.time)
  const capture = createCaptureMessages({
    repository,
    clock,
    excludePatterns: () => patterns,
    ownConversationIds: () => own,
  })
  return { repository, capture }
}

const audio = (id = 'a1', conversationId = 'c1'): MessageReceived => ({
  message: message({ id, conversationId, kind: 'audio', text: '[audio]', timestamp: NOW - 1000 }),
  isGroup: false,
  origin: 'live',
})
const target = (messageId = 'a1', conversationId = 'c1') => ({ conversationId, isGroup: false, messageId })
const DESCRIPTOR: DownloadDescriptor = {
  directPath: '/v/t62.7117-24/1_2_n.enc?ccb=11-4',
  mediaKey: new Uint8Array(32).fill(7),
  mimetype: 'audio/ogg; codecs=opus',
  fileLength: 1234,
}

describe('CaptureMessages: the durable download queue (RF-15, RNF-08)', () => {
  it('queueMedia stores the descriptor with the message and puts the audio in the download queue', async () => {
    const t = setup()
    await t.capture.receiveMessage(audio())
    await t.capture.queueMedia({ ...target(), descriptor: DESCRIPTOR })
    expect(await t.repository.countDownloads()).toBe(1)
    expect(await t.repository.nextDownload(Date.now())).toMatchObject({
      conversationId: 'c1',
      messageId: 'a1',
      descriptor: DESCRIPTOR,
    })
    // not yet in the transcription queue: there is no file
    expect(await t.repository.countPending()).toBe(0)
  })

  it('does not queue a message that is not there, or one that is not an audio', async () => {
    const t = setup()
    await t.capture.queueMedia({ ...target('ghost'), descriptor: DESCRIPTOR })
    await t.repository.insertMessage(message({ id: 'txt', text: 'hi' }))
    await t.capture.queueMedia({ ...target('txt'), descriptor: DESCRIPTOR })
    expect(await t.repository.countDownloads()).toBe(0)
  })

  it('queues an audio once: asking again changes nothing', async () => {
    const t = setup()
    await t.capture.receiveMessage(audio())
    await t.capture.queueMedia({ ...target(), descriptor: DESCRIPTOR })
    await t.capture.queueMedia({ ...target(), descriptor: { ...DESCRIPTOR, directPath: '/v/other' } })
    expect((await t.repository.nextDownload(Date.now()))?.descriptor.directPath).toBe(DESCRIPTOR.directPath)
  })

  it('an audio that is queued is not asked for again when it is replayed', async () => {
    const t = setup()
    expect((await t.capture.receiveMessage(audio())).downloadAudio).toBe(true)
    await t.capture.queueMedia({ ...target(), descriptor: DESCRIPTOR })
    expect((await t.capture.receiveMessage(audio())).downloadAudio).toBe(false)
  })

  it('mediaFailed records a failure that can never be fixed; the audio is not queued and not asked for again', async () => {
    const t = setup()
    await t.capture.receiveMessage(audio())
    await t.capture.mediaFailed({ ...target(), reason: 'invalid-media-path' })
    expect(await t.repository.countDownloads()).toBe(0)
    expect(t.repository.media.get(JSON.stringify(['c1', 'a1']))).toMatchObject({
      status: 'failed',
      error: 'invalid-media-path',
      descriptor: null,
    })
    expect((await t.capture.receiveMessage(audio())).downloadAudio).toBe(false)
  })

  it('an excluded conversation (RF-14) gets no queue entry and no record, whatever the adapter says', async () => {
    const t = setup(['secret'])
    await t.repository.insertMessage(message({ id: 'a2', conversationId: 'c-secret', kind: 'audio' }))
    await t.capture.queueMedia({ ...target('a2', 'c-secret'), descriptor: DESCRIPTOR })
    await t.capture.mediaFailed({ ...target('a2', 'c-secret'), reason: 'timeout' })
    expect(await t.repository.countDownloads()).toBe(0)
    expect(t.repository.media.size).toBe(0)
  })

  it('the own chat of the owner is dropped too', async () => {
    const t = setup([], ['me'])
    await t.repository.insertMessage(message({ id: 'a1', conversationId: 'me', kind: 'audio' }))
    await t.capture.queueMedia({ ...target('a1', 'me'), descriptor: DESCRIPTOR })
    expect(await t.repository.countDownloads()).toBe(0)
  })
})
