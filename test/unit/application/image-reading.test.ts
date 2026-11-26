import { describe, expect, it } from 'vitest'
import type { MessageReceived } from '../../../src/application/capture-events.js'
import { createCaptureMessages } from '../../../src/application/capture-messages.js'
import type { DownloadDescriptor } from '../../../src/application/ports/capture-repository.js'
import type { TranscribeRequest, Transcriber } from '../../../src/application/ports/transcriber.js'
import { createTranscribeAudios } from '../../../src/application/transcribe-audios.js'
import { createTranscriptionSlot } from '../../../src/application/transcription-slot.js'
import { err, ok } from '../../../src/domain/result.js'
import { mayReadImage, routeMedia } from '../../../src/main/media-transcriber.js'
import { FixedClock } from '../../support/application-fakes.js'
import { InMemoryCaptureRepository } from '../../support/capture-fakes.js'
import { FakeTranscriber, manualDeadlines } from '../../support/transcription-fakes.js'
import { message } from '../domain/factories.js'

const NOW = 5_000_000_000
const DAY = 86_400_000

interface Options {
  readonly readImages?: boolean
  readonly downloadAudios?: boolean
  readonly localOnly?: readonly string[]
  readonly imageHistoryDays?: number
}

function setup(options: Options = {}) {
  const clock = new FixedClock(NOW)
  const repository = new InMemoryCaptureRepository(() => clock.time)
  const capture = createCaptureMessages({
    repository,
    clock,
    excludePatterns: () => [],
    ownConversationIds: () => [],
    ...(options.downloadAudios === undefined ? {} : { downloadAudios: options.downloadAudios }),
    readImages: () => options.readImages ?? true,
    localOnlyPatterns: () => options.localOnly ?? [],
    ...(options.imageHistoryDays === undefined ? {} : { imageHistoryDays: options.imageHistoryDays }),
  })
  return { repository, capture }
}

const image = (id = 'i1', conversationId = 'c1', overrides: Partial<MessageReceived> = {}): MessageReceived => ({
  message: message({ id, conversationId, kind: 'image', text: '[imagen] Mirá', timestamp: NOW - 1000 }),
  isGroup: false,
  origin: 'live',
  conversationName: 'Familia',
  ...overrides,
})
const DESCRIPTOR: DownloadDescriptor = {
  directPath: '/v/t62.7117-24/1_2_n.enc?ccb=11-4',
  mediaKey: new Uint8Array(32).fill(7),
  mimetype: 'image/jpeg',
  fileLength: 4321,
}

describe('capture asks for the images it will read (opt-in)', () => {
  it('asks for a live image, and not for an audio, when only images are read', async () => {
    const t = setup({ downloadAudios: false })
    expect((await t.capture.receiveMessage(image())).downloadImage).toBe(true)
    const audio: MessageReceived = {
      message: message({ id: 'a1', kind: 'audio', text: '[audio]', timestamp: NOW - 1000 }),
      isGroup: false,
      origin: 'live',
    }
    const outcome = await t.capture.receiveMessage(audio)
    expect(outcome.downloadAudio).toBe(false)
    expect(outcome.downloadImage).toBe(false)
  })

  it('does not ask for images when reading is off', async () => {
    const t = setup({ readImages: false })
    expect((await t.capture.receiveMessage(image())).downloadImage).toBe(false)
  })

  it('never asks for the image of a local-only conversation: reading it would send it to a model off this machine', async () => {
    const t = setup({ localOnly: ['familia'] })
    expect((await t.capture.receiveMessage(image())).downloadImage).toBe(false)
    // The same rule by id, and a conversation that does not match is read.
    expect((await setup({ localOnly: ['c1'] }).capture.receiveMessage(image())).downloadImage).toBe(false)
    expect((await setup({ localOnly: ['trabajo'] }).capture.receiveMessage(image())).downloadImage).toBe(true)
  })

  it('uses the stored name of the conversation when the event brings none', async () => {
    const t = setup({ localOnly: ['familia'] })
    await t.repository.upsertConversation({
      id: 'c1',
      isGroup: false,
      name: 'Familia',
      participantId: null,
      address: 'c1',
    })
    expect((await t.capture.receiveMessage(image('i1', 'c1', { conversationName: null }))).downloadImage).toBe(false)
  })

  it('asks for the images of the history of the last N days only, and 0 means all of them', async () => {
    const old = (id: string) =>
      image(id, 'c1', {
        origin: 'history',
        message: message({ id, conversationId: 'c1', kind: 'image', text: '[imagen]', timestamp: NOW - 10 * DAY }),
      })
    expect((await setup({ imageHistoryDays: 7 }).capture.receiveMessage(old('h1'))).downloadImage).toBe(false)
    expect((await setup({ imageHistoryDays: 14 }).capture.receiveMessage(old('h2'))).downloadImage).toBe(true)
    expect((await setup({ imageHistoryDays: 0 }).capture.receiveMessage(old('h3'))).downloadImage).toBe(true)
  })

  it('does not ask again for an image that is queued', async () => {
    const t = setup()
    expect((await t.capture.receiveMessage(image())).downloadImage).toBe(true)
    await t.capture.queueMedia({ conversationId: 'c1', isGroup: false, messageId: 'i1', descriptor: DESCRIPTOR })
    expect((await t.capture.receiveMessage(image())).downloadImage).toBe(false)
    expect(await t.repository.countDownloads()).toBe(1)
  })
})

/** An image that was downloaded: stored, with its text, and queued to be read. */
async function stored(repo: InMemoryCaptureRepository, id: string, timestamp: number, conversationId = 'c1') {
  await repo.insertMessage(message({ id, conversationId, kind: 'image', text: '[imagen] Mirá', timestamp }))
  await repo.setMedia(conversationId, id, `${id}.jpg`)
}
async function storedAudio(repo: InMemoryCaptureRepository, id: string, timestamp: number) {
  await repo.insertMessage(message({ id, kind: 'audio', text: '[audio]', timestamp }))
  await repo.setMedia('c1', id, `${id}.ogg`)
}
const transcriptOf = async (repo: InMemoryCaptureRepository, id: string) =>
  (await repo.source.messagesInWindow('c1', { since: 0, until: 1e12 })).find((m) => m.id === id)?.transcript

function queue(mayRead?: (id: string) => boolean) {
  const transcriber = new FakeTranscriber()
  const repo = new InMemoryCaptureRepository()
  const deleted: string[] = []
  const outcomes: string[] = []
  const transcription = createTranscribeAudios({
    store: repo,
    transcriber,
    language: 'es',
    mediaPath: (ref) => `/media/${ref}`,
    startDeadline: manualDeadlines().start,
    slot: createTranscriptionSlot(1),
    deleteMedia: async (ref) => {
      deleted.push(ref)
    },
    onOutcome: (outcome) => outcomes.push(outcome),
    ...(mayRead === undefined ? {} : { mayRead: async (item) => mayRead(item.messageId) }),
  })
  return { transcriber, repo, deleted, outcomes, transcription }
}

describe('the media queue reads images next to the audios', () => {
  it('hands an image to the transcriber with its kind and the text of the message, stores what it says and deletes the file', async () => {
    const t = queue()
    await stored(t.repo, 'i1', 1000)
    t.transcriber.answer = async () => ok('Feria del libro, sábado 10 hs')
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.transcriber.calls).toEqual([
      { audioPath: '/media/i1.jpg', language: 'es', kind: 'image', caption: '[imagen] Mirá' },
    ])
    expect(await transcriptOf(t.repo, 'i1')).toBe('Feria del libro, sábado 10 hs')
    expect(t.deleted).toEqual(['i1.jpg'])
  })

  it('an audio is still asked with no kind, so whisper takes it', async () => {
    const t = queue()
    await storedAudio(t.repo, 'a1', 1000)
    t.transcriber.files['/media/a1.ogg'] = 'hola'
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.transcriber.calls).toEqual([{ audioPath: '/media/a1.ogg', language: 'es' }])
  })

  it('an image with nothing to read is done with an empty text, so it shows as before', async () => {
    const t = queue()
    await stored(t.repo, 'i1', 1000)
    t.transcriber.answer = async () => ok('')
    t.transcription.kick()
    await t.transcription.idle()
    expect(await t.repo.countPending()).toBe(0)
    expect(await transcriptOf(t.repo, 'i1')).toBe('')
  })

  it('does not read the image of a conversation that became local-only: it fails for good and the file goes', async () => {
    const t = queue((id) => id !== 'secret')
    await stored(t.repo, 'ok', 1000)
    await stored(t.repo, 'secret', 2000)
    t.transcriber.answer = async () => ok('text')
    t.transcription.kick()
    await t.transcription.idle()
    expect(t.transcriber.calls.map((c) => c.audioPath)).toEqual(['/media/ok.jpg'])
    expect(t.deleted.sort()).toEqual(['ok.jpg', 'secret.jpg'])
    expect(t.repo.media.get(JSON.stringify(['c1', 'secret']))).toMatchObject({ status: 'failed', error: 'not-allowed' })
    expect(await transcriptOf(t.repo, 'secret')).toBeNull()
  })

  it('never asks about an audio: whisper is on this machine', async () => {
    const asked: string[] = []
    const t = queue((id) => {
      asked.push(id)
      return false
    })
    await storedAudio(t.repo, 'a1', 1000)
    t.transcriber.files['/media/a1.ogg'] = 'hola'
    t.transcription.kick()
    await t.transcription.idle()
    expect(asked).toEqual([])
    expect(await transcriptOf(t.repo, 'a1')).toBe('hola')
  })

  it('an unavailable reader leaves the image queued for later', async () => {
    const t = queue()
    await stored(t.repo, 'i1', 1000)
    t.transcriber.answer = async () => err({ kind: 'unavailable', reason: 'claude-not-found' })
    t.transcription.kick()
    await t.transcription.idle()
    expect(await t.repo.countPending()).toBe(1)
    expect(t.deleted).toEqual([])
  })
})

describe('routeMedia', () => {
  const request = (kind?: 'image'): TranscribeRequest => ({
    audioPath: '/x',
    language: 'es',
    ...(kind ? { kind } : {}),
  })
  const named = (name: string): Transcriber & { closed: boolean } => ({
    closed: false,
    transcribe: async () => ok(name),
    async close() {
      this.closed = true
    },
  })

  it('is off when both are off, and is the audio transcriber itself when images are off', () => {
    const audio = named('audio')
    expect(routeMedia(null, null)).toBeNull()
    expect(routeMedia(audio, null)).toBe(audio)
  })

  it('sends audios to whisper and images to the reader, and closes both', async () => {
    const audio = named('audio')
    const images = named('images')
    const routed = routeMedia(audio, images)
    expect(await routed?.transcribe(request())).toEqual(ok('audio'))
    expect(await routed?.transcribe(request('image'))).toEqual(ok('images'))
    await routed?.close?.()
    expect([audio.closed, images.closed]).toEqual([true, true])
  })

  it('with only the reader, an audio is unavailable and an image is read', async () => {
    const routed = routeMedia(null, named('images'))
    expect(await routed?.transcribe(request())).toEqual(err({ kind: 'unavailable', reason: 'off' }))
    expect(await routed?.transcribe(request('image'))).toEqual(ok('images'))
  })
})

describe('mayReadImage: the second lock of the local-only rule', () => {
  const item = (conversationId = 'c1') => ({
    conversationId,
    messageId: 'i1',
    mediaRef: 'i1.jpg',
    timestamp: 1,
    kind: 'image' as const,
    caption: null,
  })

  it('reads everything when nothing is local-only', async () => {
    const repo = new InMemoryCaptureRepository()
    expect(await mayReadImage(repo, () => [])(item())).toBe(true)
  })

  it('refuses a conversation that matches by its name now, even if it did not when the image was queued', async () => {
    const repo = new InMemoryCaptureRepository()
    await repo.upsertConversation({
      id: 'c1',
      isGroup: true,
      name: 'Terapia grupal',
      participantId: null,
      address: 'c1',
    })
    expect(await mayReadImage(repo, () => ['terapia'])(item())).toBe(false)
    expect(await mayReadImage(repo, () => ['trabajo'])(item())).toBe(true)
  })

  it('refuses what it cannot check: a conversation it does not know', async () => {
    const repo = new InMemoryCaptureRepository()
    expect(await mayReadImage(repo, () => ['terapia'])(item('ghost'))).toBe(false)
  })
})
