import { describe, expect, it } from 'vitest'
import {
  applyServerEvent,
  EMPTY_LINK,
  initialState,
  linkFromSnapshot,
  previewFromView,
} from '../../../src/interfaces/web/lib/state.js'
import { account } from './support.js'

const start = () => initialState('en')

describe('applyServerEvent', () => {
  it('replaces the accounts', () => {
    const next = applyServerEvent(start(), 'accounts', { accounts: [account()] })
    expect(next.accounts).toEqual([account()])
    expect(applyServerEvent(start(), 'accounts', { accounts: 'x' }).accounts).toBeNull()
  })

  it('follows a link: waiting, QR (rotating), sync with counts, done', () => {
    let s = applyServerEvent(start(), 'link', { account: 'a', state: 'waitingQr' })
    expect(s.links.a?.phase).toBe('waitingQr')
    s = applyServerEvent(s, 'qr', { account: 'a', seq: 1 })
    expect(s.links.a).toMatchObject({ phase: 'qr' })
    const first = s.links.a?.qrSeq as number
    s = applyServerEvent(s, 'qr', { account: 'a', seq: 2 })
    expect(s.links.a?.qrSeq).toBeGreaterThan(first)
    s = applyServerEvent(s, 'link', { account: 'a', state: 'syncing' })
    s = applyServerEvent(s, 'sync', { account: 'a', chats: 3, messages: 40, done: false })
    expect(s.links.a).toMatchObject({ phase: 'syncing', sync: { chats: 3, messages: 40, done: false } })
    s = applyServerEvent(s, 'sync', { account: 'a', chats: 5, messages: 90, done: true })
    expect(s.links.a?.sync).toEqual({ chats: 5, messages: 90, done: true })
    s = applyServerEvent(s, 'link', { account: 'a', state: 'done' })
    expect(s.links.a?.phase).toBe('done')
    // a late sync event does not bring a finished link back to syncing
    s = applyServerEvent(s, 'sync', { account: 'a', chats: 5, messages: 91, done: true })
    expect(s.links.a?.phase).toBe('done')
  })

  it('keeps the error code of a failed link and forgets the old progress when it starts again', () => {
    let s = applyServerEvent(start(), 'sync', { account: 'a', chats: 1, messages: 1, done: false })
    s = applyServerEvent(s, 'link', { account: 'a', state: 'failed', error: 'loggedOut' })
    expect(s.links.a).toMatchObject({ phase: 'failed', error: 'loggedOut' })
    s = applyServerEvent(s, 'link', { account: 'a', state: 'waitingQr' })
    expect(s.links.a).toMatchObject({ phase: 'waitingQr', error: null, sync: null })
  })

  it('records how a digest goes, with counts and codes only', () => {
    let s = applyServerEvent(start(), 'digest', { account: 'a', state: 'started' })
    expect(s.digests.a).toEqual({ kind: 'started' })
    s = applyServerEvent(s, 'digest', { account: 'a', state: 'done', summarized: 4, failed: 1, parts: 2 })
    expect(s.digests.a).toEqual({ kind: 'done', summarized: 4, failed: 1, parts: 2 })
    s = applyServerEvent(s, 'digest', { account: 'a', state: 'failed', error: 'noProvider' })
    expect(s.digests.a).toEqual({ kind: 'failed', error: 'noProvider' })
  })

  it('records how a preview ended and keeps the content already loaded', () => {
    let s = applyServerEvent(start(), 'preview', { account: 'a', state: 'done' })
    expect(s.previews.a).toEqual({ kind: 'done' })
    s = { ...s, previews: { a: { kind: 'done', view: { state: 'done', parts: ['x'] } } } }
    s = applyServerEvent(s, 'preview', { account: 'a', state: 'failed', error: 'failed' })
    expect(s.previews.a).toMatchObject({ kind: 'failed', error: 'failed', view: { parts: ['x'] } })
  })

  it('ignores events it does not know or that are malformed', () => {
    const s = start()
    expect(applyServerEvent(s, 'nope', {})).toBe(s)
    expect(applyServerEvent(s, 'link', { account: 'a', state: 'weird' })).toBe(s)
    expect(applyServerEvent(s, 'digest', { account: 'a', state: 'weird' })).toBe(s)
    expect(applyServerEvent(s, 'qr', null)).toBe(s)
    expect(applyServerEvent(s, 'preview', { account: 'a', state: 'running' })).toBe(s)
  })
})

describe('snapshots', () => {
  it('turns what GET link and GET preview answer into the state of the page', () => {
    expect(linkFromSnapshot(EMPTY_LINK, { state: 'qr' })).toMatchObject({ phase: 'qr', qrSeq: 1 })
    expect(linkFromSnapshot(EMPTY_LINK, { state: 'failed', error: 'timeout' })).toMatchObject({
      phase: 'failed',
      error: 'timeout',
    })
    expect(
      linkFromSnapshot(EMPTY_LINK, { state: 'syncing', sync: { chats: 1, messages: 2, done: false } }).sync,
    ).toEqual({ chats: 1, messages: 2, done: false })
    expect(previewFromView({ state: 'none' })).toEqual({ kind: 'idle' })
    expect(previewFromView({ state: 'running' })).toEqual({ kind: 'running' })
    expect(previewFromView({ state: 'done', parts: ['a'] })).toEqual({
      kind: 'done',
      view: { state: 'done', parts: ['a'] },
    })
  })
})
