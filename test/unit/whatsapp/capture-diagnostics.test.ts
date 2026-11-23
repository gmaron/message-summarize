import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureMessages } from '../../../src/application/capture-messages.js'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import { createWhatsAppConnection, OwnConversationIds } from '../../../src/infrastructure/whatsapp/index.js'
import { createTranslator, type WarningDetail } from '../../../src/infrastructure/whatsapp/translate.js'
import type { WaMessage } from '../../../src/infrastructure/whatsapp/wa-types.js'
import { FixedClock } from '../../support/application-fakes.js'
import { fakeSocketFactory, recordingCapture } from '../../support/whatsapp-fakes.js'

const ANA = '9911963367943@s.whatsapp.net'
const ME = '9913174261432@s.whatsapp.net'
const NEVER = new Promise<never>(() => {})

const dirs: string[] = []
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const message = (id: string, extra: Partial<WaMessage> = {}): WaMessage => ({
  key: { remoteJid: ANA, id, fromMe: false },
  message: { conversation: 'hola' },
  messageTimestamp: 1_700_000_000,
  ...extra,
})

function connectionSetup(overrides: Partial<CaptureMessages> = {}) {
  const fake = fakeSocketFactory({})
  const { capture, calls } = recordingCapture()
  const dir = mkdtempSync(join(tmpdir(), 'message-summarize-diag-'))
  dirs.push(dir)
  const warnings: { code: string; detail?: WarningDetail }[] = []
  const stats: Record<string, number>[] = []
  const connection = createWhatsAppConnection({
    authDir: dir,
    language: 'es',
    capture: { ...capture, ...overrides },
    clock: new FixedClock(1_800_000_000_000),
    ownIds: new OwnConversationIds(),
    socketFactory: fake.factory,
    eventTimeoutMs: 1_000,
    statsIntervalMs: 60_000,
    onWarning: (code, detail) => warnings.push({ code, ...(detail === undefined ? {} : { detail }) }),
    onStats: (s) => stats.push({ ...s }),
  })
  const socket = () => {
    const s = fake.sockets.at(-1)
    if (s === undefined) throw new Error('no socket')
    return s
  }
  return { connection, calls, warnings, stats, socket }
}

describe('event queue timeout', () => {
  it('abandons an event that never settles, warns with its name and lets the next one through', async () => {
    let first = true
    const received: string[] = []
    const t = connectionSetup({
      receiveMessage: (event) => {
        received.push(event.message.id)
        if (first) {
          first = false
          return NEVER
        }
        return recordingCapture().capture.receiveMessage(event)
      },
    })
    await t.connection.start()
    const upsert = (id: string) => ({ type: 'notify', messages: [message(id)] })
    t.socket().ev.emit('messages.upsert', upsert('HUNG'))
    t.socket().ev.emit('messages.upsert', upsert('NEXT'))
    await vi.advanceTimersByTimeAsync(500)
    expect(t.warnings).toEqual([])
    expect(received).toEqual(['HUNG'])
    await vi.advanceTimersByTimeAsync(600)
    expect(t.warnings).toEqual([{ code: 'event-timeout', detail: { wsEvent: 'messages.upsert' } }])
    // the second one ran after the first was abandoned
    expect(received).toEqual(['HUNG', 'NEXT'])
    expect(JSON.stringify(t.warnings)).not.toContain(ANA)
  })

  it('an event that settles in time does not warn', async () => {
    const t = connectionSetup()
    await t.connection.start()
    t.socket().ev.emit('messages.upsert', { type: 'notify', messages: [message('M1')] })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.warnings).toEqual([])
  })
})

describe('capture counters', () => {
  function translatorSetup(extra: Partial<Parameters<typeof createTranslator>[0]> = {}) {
    const { capture } = recordingCapture()
    const ownIds = new OwnConversationIds()
    ownIds.set([ME])
    return createTranslator({
      capture,
      catalog: getCatalog('es'),
      clock: new FixedClock(1_800_000_000_000),
      ownIds,
      ...extra,
    })
  }

  it('counts one drop per reason, and what is stored', async () => {
    const translator = translatorSetup()
    await translator.messagesUpsert({
      type: 'notify',
      messages: [
        message('A'), // stored
        { ...message('B'), key: { remoteJid: ANA } }, // noKey
        { key: { remoteJid: ANA, id: 'C' }, messageTimestamp: 1 }, // noMessage
        { ...message('D'), key: { remoteJid: 'status@broadcast', id: 'D' } }, // ignoredChat + notLocated
        { ...message('E'), key: { remoteJid: ME, id: 'E' } }, // ownChat + notLocated
        { ...message('F'), messageTimestamp: null }, // noTimestamp
        { ...message('G'), message: { protocolMessage: {} } }, // notParsed
        { ...message('H'), message: {} }, // noContent
      ],
    })
    const stats = translator.stats()
    expect(stats).toMatchObject({
      upsertBatches: 1,
      upsertMessages: 8,
      stored: 1,
      droppedNoKey: 1,
      droppedNoMessage: 1,
      ignoredChat: 1,
      ownChat: 1,
      droppedNotLocated: 2,
      droppedNoTimestamp: 1,
    })
    expect(stats.droppedNotParsed ?? 0).toBeGreaterThanOrEqual(0)
    expect((stats.droppedNotParsed ?? 0) + (stats.droppedNoContent ?? 0)).toBe(2)
    expect(JSON.stringify(stats)).not.toContain(ANA)
  })

  it('counts a failing item', async () => {
    const { capture } = recordingCapture()
    const translator = translatorSetup({
      capture: {
        ...capture,
        receiveMessage: () => Promise.reject(new Error('boom')),
      },
    })
    await translator.messagesUpsert({ type: 'notify', messages: [message('A')] })
    expect(translator.stats()).toMatchObject({ itemFailed: 1 })
    expect(translator.stats().stored).toBeUndefined()
  })

  it('warns slow-step once, with the step name, when an await takes too long', async () => {
    const warnings: { code: string; detail?: WarningDetail }[] = []
    let release: () => void = () => {}
    const slow = new Promise<string | undefined>((resolve) => {
      release = () => resolve(undefined)
    })
    const translator = translatorSetup({
      slowStepMs: 100,
      onWarning: (code, detail) => warnings.push({ code, ...(detail === undefined ? {} : { detail }) }),
      resolvePhoneNumber: () => slow,
    })
    const pending = translator.messagesUpsert({
      type: 'notify',
      messages: [message('A', { key: { remoteJid: '99900000001@lid', id: 'A' } })],
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(warnings).toEqual([{ code: 'slow-step', detail: { step: 'resolvePhoneNumber' } }])
    release()
    await pending
    expect(translator.stats().stored).toBe(1)
  })
})

describe('capture.stats reporting', () => {
  it('reports only when something changed, and only while connected', async () => {
    const t = connectionSetup()
    await t.connection.start()
    t.socket().ev.emit('connection.update', { connection: 'open' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.stats).toHaveLength(0) // nothing counted yet

    t.socket().ev.emit('messages.upsert', { type: 'notify', messages: [message('M1')] })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.stats).toHaveLength(1)
    expect(t.stats[0]).toMatchObject({ evMessagesUpsert: 1, upsertBatches: 1, upsertMessages: 1, stored: 1 })

    await vi.advanceTimersByTimeAsync(120_000)
    expect(t.stats).toHaveLength(1) // unchanged: no new line

    t.socket().ev.emit('messages.upsert', { type: 'notify', messages: [message('M2')] })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.stats).toHaveLength(2)
    expect(t.stats[1]).toMatchObject({ stored: 2 })

    await t.connection.stop()
    t.socket()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(t.stats).toHaveLength(2) // not connected any more: silent
  })
})
