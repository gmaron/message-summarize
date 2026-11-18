import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createWhatsAppConnection } from '../../../src/infrastructure/whatsapp/index.js'
import type { ManagedConnection } from '../../../src/main/whatsapp.js'
import { disposeHarnesses, seedMessages, until, waitFor } from '../../support/cli-harness.js'
import { BASE, disposeWorlds, type World, world } from '../../support/web-world.js'
import { fakeSocketFactory } from '../../support/whatsapp-fakes.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

const ANA = '5491100000001@s.whatsapp.net'
const LID = '99900000001@lid'
const TEXT = 'PRIVATE-CHAT-TEXT: the plan'
const WITH_OLLAMA = { ...BASE, provider: { primary: 'claude-cli', ollama: { model: 'llama-test' } } }

const accountFile = (w: World) => w.h.accountOf('alpha').configFile
const readAccount = (w: World) => JSON.parse(readFileSync(accountFile(w), 'utf8')) as Record<string, unknown>
const marks = (w: World, list: 'excludePatterns' | 'localOnlyPatterns') => (readAccount(w)[list] ?? []) as string[]

async function seed(w: World, chat: string, messages = 1): Promise<void> {
  const runtime = w.h.runtime('alpha')
  try {
    for (let n = 0; n < messages; n++) {
      await seedMessages(runtime, [
        { id: `${chat}-${n}`, text: TEXT, conversationId: chat, conversationName: 'Ana Test' },
      ])
    }
  } finally {
    runtime.close()
  }
}
const stored = (w: World, chat: string): number => {
  const runtime = w.h.runtime('alpha')
  try {
    return (
      runtime.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(chat) as { n: number }
    ).n
  } finally {
    runtime.close()
  }
}
const started = (w: World) => until(() => w.host.daemonOf('alpha') !== undefined, 'the unit')

describe('coverAlias: the marks of one id are put on the other', () => {
  it('real WhatsAppConnection.onAlias reaches the host: a lid-mapping.update covers the other id', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    writeFileSync(accountFile(w), JSON.stringify({ excludePatterns: [`id:${LID}`] }))
    const sockets = fakeSocketFactory()
    Object.assign(w.h.ctx, {
      connectionFactory: async (runtime: import('../../../src/main/runtime.js').Runtime) =>
        createWhatsAppConnection({
          authDir: runtime.layout.authDir,
          language: 'en',
          capture: runtime.capture,
          clock: runtime.clock,
          ownIds: runtime.ownIds,
          socketFactory: sockets.factory,
        }) as unknown as ManagedConnection,
    })
    await w.host.start()
    await started(w)
    await until(() => sockets.sockets.length > 0, 'the socket')
    sockets.sockets[0]?.ev.emit('lid-mapping.update', { lid: LID, pn: ANA })
    await until(() => marks(w, 'excludePatterns').length === 2, 'the alias mark')
    expect(marks(w, 'excludePatterns')).toEqual([`id:${LID}`, `id:${ANA}`])
    await waitFor(() =>
      expect(w.host.runtimeOf('alpha')?.config.digest.excludePatterns).toEqual([`id:${LID}`, `id:${ANA}`]),
    )
  })

  it('looks at the pairs the connection already knows when the unit starts (the ones learned while linking)', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false, config: WITH_OLLAMA })
    writeFileSync(accountFile(w), JSON.stringify({ localOnlyPatterns: [`id:${ANA}`] }))
    w.h.connection.aliasPairs.push([LID, ANA])
    await w.host.start()
    await started(w)
    expect(marks(w, 'localOnlyPatterns')).toEqual([`id:${ANA}`, `id:${LID}`])
    expect(w.host.runtimeOf('alpha')?.config.localOnlyPatterns).toEqual([`id:${ANA}`, `id:${LID}`])
  })

  it('at start it also deletes what is stored under an excluded id (a deletion that was lost)', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'], start: false })
    await seed(w, ANA, 2)
    writeFileSync(accountFile(w), JSON.stringify({ excludePatterns: [`id:${ANA}`] }))
    await w.host.start()
    await started(w)
    expect(stored(w, ANA)).toBe(0)
  })

  it('waits for a digest or a preview to end before it deletes what is stored under the new id', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    await seed(w, ANA, 2)
    writeFileSync(accountFile(w), JSON.stringify({ excludePatterns: [`id:${LID}`] }))
    await started(w)
    await waitFor(() => expect(w.host.runtimeOf('alpha')?.config.digest.excludePatterns).toEqual([`id:${LID}`]))
    let busy = true
    w.host.addBusyCheck(() => busy)
    await w.h.connection.learnAlias(LID, ANA)
    expect(marks(w, 'excludePatterns')).toEqual([`id:${LID}`, `id:${ANA}`])
    // the pattern is in force at once; the deletion is not run under a running digest
    expect(w.host.runtimeOf('alpha')?.config.digest.excludePatterns).toContain(`id:${ANA}`)
    expect(stored(w, ANA)).toBe(2)
    busy = false
    await until(() => stored(w, ANA) === 0, 'the deferred deletion')
  })

  it('does not fail open: when the file cannot be written the mark is in force in memory, and it is written later', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    writeFileSync(accountFile(w), JSON.stringify({ excludePatterns: [`id:${LID}`] }))
    await started(w)
    await waitFor(() => expect(w.host.runtimeOf('alpha')?.config.digest.excludePatterns).toEqual([`id:${LID}`]))
    // the account file is broken by a hand edit
    writeFileSync(accountFile(w), '{ not json')
    await w.h.connection.learnAlias(LID, ANA)
    const runtime = w.host.runtimeOf('alpha')
    expect(runtime?.config.digest.excludePatterns).toContain(`id:${ANA}`)
    // the chat is dropped meanwhile
    if (runtime === undefined) throw new Error('no runtime')
    await seedMessages(runtime, [{ id: 'm', text: TEXT, conversationId: ANA, conversationName: 'Ana Test' }])
    expect(stored(w, ANA)).toBe(0)
    // the file is fixed by hand (without the alias): the mark is not lost when it is read again, and it is written
    writeFileSync(accountFile(w), JSON.stringify({ excludePatterns: [`id:${LID}`] }))
    await until(() => marks(w, 'excludePatterns').includes(`id:${ANA}`), 'the mark to be written again')
    expect(w.host.runtimeOf('alpha')?.config.digest.excludePatterns).toEqual(
      expect.arrayContaining([`id:${LID}`, `id:${ANA}`]),
    )
  })

  it('decides from the file as it is when it writes: a mark taken off meanwhile is respected', async () => {
    const w = await world({ accounts: ['alpha'], linked: ['alpha'] })
    writeFileSync(accountFile(w), JSON.stringify({ excludePatterns: [`id:${LID}`] }))
    await started(w)
    await waitFor(() => expect(w.host.runtimeOf('alpha')?.config.digest.excludePatterns).toEqual([`id:${LID}`]))
    // the person un-marked it in the file, but the unit has not looked yet
    writeFileSync(accountFile(w), JSON.stringify({ excludePatterns: [] }))
    await w.h.connection.learnAlias(LID, ANA)
    expect(marks(w, 'excludePatterns')).toEqual([])
  })
})
