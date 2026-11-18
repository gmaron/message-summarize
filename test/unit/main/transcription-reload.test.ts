import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { err } from '../../../src/domain/result.js'
import { disposeHarnesses, until, waitFor } from '../../support/cli-harness.js'
import { FakeTranscriber } from '../../support/transcription-fakes.js'
import { BASE, disposeWorlds, type World, world } from '../../support/web-world.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

// A change of `transcription` in the configuration of a running account cannot be applied in place: the transcriber, the
// queue, the days of history audio and the download worker of the connection are wired when the unit starts. So the host
// restarts the unit (the full release of a stop, then a start on the next look); every other change stays live.

const accountFile = (w: World, id: string) => w.h.accountOf(id).configFile
const started = (w: World, id: string) => until(() => w.host.daemonOf(id) !== undefined, `the unit of ${id}`)
const named = (w: World, event: string) =>
  w.h.logs.map((l) => JSON.parse(l) as { event: string; reason?: string }).filter((e) => e.event === event)
const calls = (w: World) => w.h.connection.calls.filter((call) => call === 'start' || call === 'stop')
const ANA = '5491100000001@s.whatsapp.net'

describe('a live change of the transcription settings restarts the unit of the account', () => {
  it('turning it off stops the unit (connection, downloads and whisper) and it comes back without transcription', async () => {
    const w = await world({
      accounts: ['alpha'],
      linked: ['alpha'],
      config: { ...BASE, transcription: { enabled: true } },
    })
    await started(w, 'alpha')
    const before = w.host.runtimeOf('alpha')
    expect(before?.transcription.enabled).toBe(true)
    const stopped = vi.spyOn(before?.transcription as { stop: () => Promise<void> }, 'stop')
    expect(calls(w)).toEqual(['start'])

    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ transcription: { enabled: false } }))

    await waitFor(() => expect(named(w, 'account.restarting')).toHaveLength(1))
    expect(named(w, 'account.restarting')[0]?.reason).toBe('transcription')
    // The old unit was released: its connection (and the download worker with it) stopped, its transcription stopped.
    await waitFor(() => expect(w.host.runtimeOf('alpha')).not.toBe(before))
    expect(stopped).toHaveBeenCalled()
    expect(calls(w).slice(0, 2)).toEqual(['start', 'stop'])
    // ...and the unit came back (a new socket, a new runtime) with nothing to transcribe.
    await waitFor(() => expect(calls(w)).toEqual(['start', 'stop', 'start']))
    expect(w.host.runtimeOf('alpha')?.transcription.enabled).toBe(false)
    expect(w.host.runtimeOf('alpha')?.config.transcription.enabled).toBe(false)
  })

  it('turning it on starts it: the unit comes back with transcription enabled', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], config: BASE })
    await started(w, 'alpha')
    const before = w.host.runtimeOf('alpha')
    expect(before?.transcription.enabled).toBe(false)

    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ transcription: { enabled: true } }))

    await waitFor(() => expect(calls(w)).toEqual(['start', 'stop', 'start']))
    expect(named(w, 'account.restarting')).toHaveLength(1)
    const after = w.host.runtimeOf('alpha')
    expect(after).not.toBe(before)
    expect(after?.transcription.enabled).toBe(true)
  })

  it('a running whisper does not survive the restart', async () => {
    const transcriber = new FakeTranscriber()
    transcriber.answer = async () => {
      await transcriber.closedSignal
      return err({ kind: 'failed', reason: 'killed' })
    }
    // The transcriber is given to the context before the host starts the unit.
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], config: BASE, start: false })
    Object.assign(w.h.ctx, { transcriber })
    await w.host.start()
    await started(w, 'alpha')
    const runtime = w.host.runtimeOf('alpha')
    if (runtime === undefined) throw new Error('no runtime')
    // An audio whose file is downloaded and waits for its transcript: the unit's transcription takes it on a sweep.
    await runtime.capture.participantInfo({ participant: { id: ANA, savedName: 'Ana', publicName: null } })
    await runtime.capture.receiveMessage({
      origin: 'live',
      isGroup: false,
      message: {
        id: 'a1',
        conversationId: ANA,
        senderId: ANA,
        senderName: null,
        senderAddress: '+5491100000001',
        fromMe: false,
        timestamp: Date.now() - 1_000,
        kind: 'audio',
        text: '[audio]',
        transcript: null,
        read: false,
      },
    })
    mkdirSync(w.h.accountOf('alpha').mediaDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(w.h.accountOf('alpha').mediaDir, 'a1.ogg'), 'bytes')
    await runtime.repository.setMedia(ANA, 'a1', 'a1.ogg')
    await until(() => transcriber.inFlight === 1, 'the whisper running', 2_000)

    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ transcription: { historyAudioDays: 3 } }))

    await waitFor(() => expect(named(w, 'account.restarting')).toHaveLength(1))
    // The whisper was killed with its unit: nothing of it is left running, and the audio stays pending for the next one.
    await waitFor(() => expect(transcriber.closed).toBe(true))
    await waitFor(() => expect(transcriber.inFlight).toBe(0))
    // (Between the stop and the start of the next look there is no runtime at all.)
    await waitFor(() => expect(w.host.runtimeOf('alpha')?.config.transcription.historyAudioDays).toBe(3))
    expect(w.host.runtimeOf('alpha')).not.toBe(runtime)
  })

  it('a change of any other option does not restart the unit', async () => {
    const w = await world({
      accounts: ['alpha'],
      linked: ['alpha'],
      config: { ...BASE, transcription: { enabled: true } },
    })
    await started(w, 'alpha')
    const before = w.host.runtimeOf('alpha')

    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ language: 'es', unreadOnly: true }))

    await waitFor(() => expect(w.host.runtimeOf('alpha')?.config.language).toBe('es'))
    // Give the host several looks: still the same unit, the same runtime, the same socket.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(w.host.runtimeOf('alpha')).toBe(before)
    expect(calls(w)).toEqual(['start'])
    expect(named(w, 'account.restarting')).toEqual([])
  })
})
