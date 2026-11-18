import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { WEB_RETRY_MIN_WAIT_MS, writeBlocked } from '../../../src/main/blocked.js'
import { disposeHarnesses, waitFor } from '../../support/cli-harness.js'
import { disposeWorlds, type World, world } from '../../support/web-world.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

interface View {
  id: string
  state: string
  blockedReason: string | null
  blockedAt: number | null
  retryAfter: number | null
  fix: 'relink' | 'retry' | null
}
const views = async (w: World): Promise<Record<string, View>> =>
  Object.fromEntries(((await w.api('GET', '/api/accounts')).body.accounts as View[]).map((v) => [v.id, v]))

describe('what the web says about a blocked account', () => {
  it('says what fixes the block with the rules of the routes: a session decides between retry and relink', async () => {
    const w = await world({
      accounts: ['gone', 'kept', 'loose', 'fine'],
      linked: ['gone', 'kept', 'fine'],
      blocked: { gone: 'loggedOut', kept: 'socketFailed', loose: 'socketFailed' },
    })
    await waitFor(async () => {
      const all = await views(w)
      // linking fixes a closed session; a refused connection with a session is retried; with no session only a link helps
      expect(all.gone).toMatchObject({ state: 'blocked', blockedReason: 'loggedOut', fix: 'relink' })
      expect(all.kept).toMatchObject({ state: 'blocked', blockedReason: 'socketFailed', fix: 'retry' })
      expect(all.loose).toMatchObject({ state: 'blocked', blockedReason: 'socketFailed', fix: 'relink' })
      expect(all.fine).toMatchObject({ fix: null, blockedAt: null, retryAfter: null })
    })
    // and the routes agree with what it said
    expect((await w.api('POST', '/api/accounts/kept/retry')).status).toBe(200)
    expect((await w.api('POST', '/api/accounts/gone/retry')).body).toEqual({ error: 'needsRelink' })
  })

  it('reports the time of the block and, for a block WhatsApp asked to wait for, when retrying is allowed', async () => {
    const w = await world({
      accounts: ['a', 'b'],
      linked: ['a', 'b'],
      blocked: { a: 'forbidden', b: 'socketFailed' },
    })
    await waitFor(async () => {
      const all = await views(w)
      expect(all.a).toMatchObject({ blockedAt: 5, retryAfter: 5 + WEB_RETRY_MIN_WAIT_MS })
      expect(all.b).toMatchObject({ blockedAt: 5, retryAfter: null })
    })
  })

  it('reports a block that is on disk but has no live state as blocked, not idle (a daemon of another account)', async () => {
    const w = await world({
      accounts: ['mine', 'other'],
      linked: ['mine', 'other'],
      blocked: { other: 'replaced' },
      only: 'mine',
    })
    expect(w.host.accountState('other')).toBeNull()
    expect((await views(w)).other).toMatchObject({
      state: 'blocked',
      blockedReason: 'replaced',
      fix: 'retry',
      blockedAt: 5,
    })
  })
})

describe('retrying from the web (POST /api/accounts/:id/retry)', () => {
  const blockedNow = (w: World, id: string, reason: 'forbidden' | 'replaced' | 'socketFailed', at: number) =>
    writeBlocked(w.h.accountOf(id).blockedFile, reason, at)

  it('refuses 409 tooSoon, with when it is allowed, for a refused or replaced connection that was blocked minutes ago', async () => {
    const w = await world({ accounts: ['a', 'b'], linked: ['a', 'b'], blocked: { a: 'forbidden', b: 'replaced' } })
    const at = Date.now() - 60_000
    await blockedNow(w, 'a', 'forbidden', at)
    await blockedNow(w, 'b', 'replaced', at)
    for (const id of ['a', 'b']) {
      expect(await w.api('POST', `/api/accounts/${id}/retry`)).toEqual({
        status: 409,
        body: { error: 'tooSoon', retryAfter: at + WEB_RETRY_MIN_WAIT_MS },
      })
      // nothing was cleared and nothing reconnected
      expect(existsSync(w.h.accountOf(id).blockedFile)).toBe(true)
    }
  })

  it('allows it once the minimum wait has passed', async () => {
    const w = await world({ accounts: ['a'], linked: ['a'], blocked: { a: 'forbidden' } })
    await blockedNow(w, 'a', 'forbidden', Date.now() - WEB_RETRY_MIN_WAIT_MS - 1_000)
    expect((await w.api('POST', '/api/accounts/a/retry')).status).toBe(200)
    expect(existsSync(w.h.accountOf('a').blockedFile)).toBe(false)
  })

  it('does not make a block that WhatsApp did not ask to wait for wait', async () => {
    const w = await world({ accounts: ['a'], linked: ['a'], blocked: { a: 'socketFailed' } })
    await blockedNow(w, 'a', 'socketFailed', Date.now())
    expect((await w.api('POST', '/api/accounts/a/retry')).status).toBe(200)
  })

  it('does not apply to the commands of the terminal (the wait is for the web only)', async () => {
    const { retryBlock } = await import('../../../src/main/retry.js')
    const w = await world({ accounts: ['a'], linked: ['a'], blocked: { a: 'forbidden' } })
    await blockedNow(w, 'a', 'forbidden', Date.now())
    expect(await retryBlock(w.h.accountOf('a'))).toEqual({ result: 'cleared', reason: 'forbidden' })
  })
})
