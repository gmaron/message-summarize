import { describe, expect, it } from 'vitest'
import { accountActions, badgeOf, isAccountIdValid, retryWaitUntil } from '../../../src/interfaces/web/lib/accounts.js'
import {
  blockedText,
  digestMessage,
  errorText,
  linkErrorText,
  stateText,
} from '../../../src/interfaces/web/lib/digest.js'
import { textsFor } from '../../../src/interfaces/web/lib/i18n.js'
import { account } from './support.js'

describe('the buttons of a card', () => {
  it('offers link for an account that is not linked and nothing that needs a connection', () => {
    const a = account({ state: 'idle', maskedNumber: null })
    expect(badgeOf(a)).toBe('notLinked')
    expect(accountActions(a)).toMatchObject({ link: true, relink: false, retry: false, digest: false, preview: false })
  })

  it('offers relink or retry as the daemon says (`fix`), and nothing of its own', () => {
    const relink = account({ state: 'blocked', blockedReason: 'loggedOut', fix: 'relink' })
    expect(accountActions(relink)).toMatchObject({ relink: true, retry: false, digest: false })
    const retry = account({ state: 'blocked', blockedReason: 'socketFailed', fix: 'retry' })
    expect(accountActions(retry)).toMatchObject({ relink: false, retry: true })
    // the page does not decide from the reason: a block with no `fix` offers neither
    const unknown = account({ state: 'blocked', blockedReason: 'forbidden', fix: null })
    expect(accountActions(unknown)).toMatchObject({ relink: false, retry: false })
    expect(accountActions(account({ ...retry, configValid: false }))).toMatchObject({ retry: false })
  })

  it('knows when retrying is not yet allowed', () => {
    const waiting = account({ state: 'blocked', blockedReason: 'forbidden', fix: 'retry', retryAfter: 2_000 })
    expect(retryWaitUntil(waiting, 1_000)).toBe(2_000)
    expect(retryWaitUntil(waiting, 2_000)).toBeNull()
    expect(retryWaitUntil(account(), 1_000)).toBeNull()
  })

  it('lets a connected account summarize and preview, and a linking one reopen its dialog', () => {
    expect(accountActions(account())).toMatchObject({ digest: true, preview: true, schedules: true, link: false })
    expect(accountActions(account({ state: 'linking' }))).toMatchObject({ link: true, digest: false, preview: false })
    expect(accountActions(account({ state: 'reconnecting' })).digest).toBe(true)
  })

  it('offers neither link nor schedules for an account whose configuration is not valid', () => {
    const a = account({ state: 'idle', maskedNumber: null, configValid: false })
    expect(accountActions(a)).toMatchObject({ link: false, schedules: false, preview: false, settings: true })
  })

  it('checks the id as the daemon does', () => {
    expect(isAccountIdValid('work-2')).toBe(true)
    for (const bad of ['', 'Work', '-a', 'a b', 'a/b', 'a'.repeat(33)]) expect(isAccountIdValid(bad)).toBe(false)
  })
})

describe('digestMessage', () => {
  const texts = textsFor('en')
  it('says each way a digest goes', () => {
    expect(digestMessage({ kind: 'requesting' }, texts).tone).toBe('working')
    expect(digestMessage({ kind: 'started' }, texts).text).toBe(texts.ui.digest.started)
    expect(digestMessage({ kind: 'deferred' }, texts).text).toBe(texts.ui.digest.deferred)
    expect(digestMessage({ kind: 'done', summarized: 3, parts: 2 }, texts)).toEqual({
      text: 'Digest sent: 3 chats summarized in 2 parts.',
      tone: 'ok',
    })
    expect(digestMessage({ kind: 'done', summarized: 3, failed: 1, parts: 2 }, texts).tone).toBe('warn')
    expect(digestMessage({ kind: 'empty' }, texts).text).toBe(texts.ui.digest.empty)
    expect(digestMessage({ kind: 'busy' }, texts).tone).toBe('warn')
    expect(digestMessage({ kind: 'failed', error: 'noProvider' }, texts).text).toBe(texts.digestErrors.noProvider)
    expect(digestMessage({ kind: 'failed' }, texts).text).toBe(texts.ui.digest.failed)
    expect(digestMessage({ kind: 'error', code: 'notRunning' }, texts).text).toBe(texts.errors.notRunning)
    expect(digestMessage({ kind: 'error', code: 'madeUp' }, texts).text).toBe(texts.errors.internal)
  })
})

describe('texts of codes the page does not know (a newer daemon)', () => {
  const texts = textsFor('en')
  it('fall back to a generic text and never to a property of Object', () => {
    expect(linkErrorText('timeout', texts)).toBe(texts.linkErrors.timeout)
    expect(linkErrorText('madeUp', texts)).toBe(texts.ui.link.failed)
    expect(linkErrorText(null, texts)).toBe(texts.ui.link.failed)
    expect(blockedText('loggedOut', texts)).toBe(texts.ui.blockedReasons.loggedOut)
    expect(blockedText('madeUp', texts)).toBe(texts.ui.states.blocked)
    expect(errorText('constructor', texts)).toBe(texts.errors.internal)
    expect(errorText(undefined, texts)).toBe(texts.errors.internal)
    expect(stateText('madeUp', texts)).toBe('madeUp')
    expect(digestMessage({ kind: 'failed', error: 'madeUp' as never }, texts).text).toBe(texts.ui.digest.failed)
  })
})
