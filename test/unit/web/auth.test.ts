import { describe, expect, it } from 'vitest'
import { consumeToken } from '../../../src/interfaces/web/lib/auth.js'
import { fakeFetch } from './support.js'

function setup(hash: string, answers: Parameters<typeof fakeFetch>[0]) {
  const replaced: string[] = []
  const { fetchFn, calls } = fakeFetch(answers)
  return {
    replaced,
    calls,
    env: {
      location: { hash, pathname: '/', search: '?x=1' },
      history: { replaceState: (_data: unknown, _unused: string, url: string) => void replaced.push(url) },
      fetch: fetchFn,
    },
  }
}

describe('consumeToken', () => {
  it('exchanges the token of the address for the session and takes it out of the address', async () => {
    const t = setup('#token=abc123', { 'POST /api/session': { body: { ok: true } } })
    expect(await consumeToken(t.env)).toBe('ok')
    expect(t.calls).toEqual([{ method: 'POST', path: '/api/session', body: { token: 'abc123' } }])
    expect(t.replaced).toEqual(['/?x=1'])
  })

  it('does nothing when the address has no token', async () => {
    const t = setup('', {})
    expect(await consumeToken(t.env)).toBe('none')
    expect(t.calls).toEqual([])
    expect(t.replaced).toEqual([])
  })

  it('removes the token from the address even when the daemon refuses it or does not answer', async () => {
    const refused = setup('#token=bad', { 'POST /api/session': { status: 401, body: { error: 'unauthorized' } } })
    expect(await consumeToken(refused.env)).toBe('rejected')
    expect(refused.replaced).toEqual(['/?x=1'])
    const broken = setup('#token=x', {})
    broken.env.fetch = async () => {
      throw new Error('offline')
    }
    expect(await consumeToken(broken.env)).toBe('failed')
    expect(broken.replaced).toEqual(['/?x=1'])
    const odd = setup('#token=x', { 'POST /api/session': { status: 500 } })
    expect(await consumeToken(odd.env)).toBe('failed')
  })
})
