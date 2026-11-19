import { describe, expect, it } from 'vitest'
import {
  accountActions,
  badgeOf,
  fixKind,
  hasProblem,
  initialOf,
  isAccountIdValid,
  isDigestRunning,
  pillOf,
  pillText,
  problemsFirst,
  railStatus,
  retryWaitUntil,
} from '../../../src/interfaces/web/lib/accounts.js'
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
    expect(accountActions(a)).toMatchObject({ link: false, schedules: false, preview: false })
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

describe('the pill and the order of the accounts', () => {
  it('says what is wrong before the state', () => {
    expect(pillOf(account({ configValid: false }), false)).toEqual({ tone: 'bad', key: 'invalidConfig' })
    expect(pillOf(account({ state: 'blocked', blockedReason: 'loggedOut', fix: 'relink' }), false)).toEqual({
      tone: 'bad',
      key: 'sessionClosed',
    })
    expect(pillOf(account({ state: 'blocked', blockedReason: 'forbidden' }), false)).toEqual({
      tone: 'bad',
      key: 'blocked',
    })
  })

  it('says that a digest is being made only for a connected account', () => {
    expect(pillOf(account(), true)).toEqual({ tone: 'busy', key: 'running' })
    expect(pillOf(account(), false)).toEqual({ tone: 'ok', key: 'connected' })
    expect(pillOf(account({ state: 'reconnecting' }), true)).toEqual({ tone: 'busy', key: 'reconnecting' })
    expect(pillOf(account({ state: 'idle', maskedNumber: null }), false)).toEqual({ tone: 'idle', key: 'notLinked' })
  })

  it('puts the accounts with a problem first and keeps the order of the rest', () => {
    const list = [
      account({ id: 'a' }),
      account({ id: 'b', state: 'blocked', blockedReason: 'loggedOut' }),
      account({ id: 'c' }),
      account({ id: 'd', configValid: false }),
    ]
    expect(problemsFirst(list).map((one) => one.id)).toEqual(['b', 'd', 'a', 'c'])
    expect(hasProblem(account())).toBe(false)
  })

  it('draws the avatar letter in capitals', () => {
    expect(initialOf('personal')).toBe('P')
    expect(initialOf('')).toBe('?')
  })
})

describe('the one fix an account offers', () => {
  it('is what the daemon says, then linking for an account that is not linked, then the settings', () => {
    expect(fixKind(account({ state: 'blocked', blockedReason: 'loggedOut', fix: 'relink' }))).toBe('relink')
    expect(fixKind(account({ state: 'blocked', blockedReason: 'socketFailed', fix: 'retry' }))).toBe('retry')
    expect(fixKind(account({ state: 'idle', maskedNumber: null }))).toBe('link')
    expect(fixKind(account({ configValid: false }))).toBe('settings')
    expect(fixKind(account())).toBeNull()
  })

  it('names a pill in the language of the page', () => {
    expect(pillText('sessionClosed', textsFor('es'))).toBe('Sesión cerrada')
    expect(pillText('connected', textsFor('en'))).toBe('Connected')
    expect(pillText('running', textsFor('en'))).toBe('Summarizing')
  })
})

describe('the line of an account in the rail', () => {
  const now = Date.UTC(2026, 10, 18, 15, 0)
  const es = textsFor('es')

  it('says what is wrong in red, before anything else', () => {
    const closed = account({ state: 'blocked', blockedReason: 'loggedOut', fix: 'relink', nextRun: now + 3_600_000 })
    expect(railStatus(closed, false, es, now)).toEqual({ text: 'Sesión cerrada', bad: true })
  })

  it('says that a digest is being made, then when the next one is, then that there is no schedule', () => {
    expect(railStatus(account(), true, es, now)).toEqual({ text: 'Resumiendo…', bad: false })
    // 22:00 UTC is 19:00 in Buenos Aires, the same day
    const next = account({ nextRun: Date.UTC(2026, 10, 18, 22, 0) })
    expect(railStatus(next, false, es, now)).toEqual({ text: 'Próximo hoy 19:00', bad: false })
    expect(railStatus(account(), false, es, now)).toEqual({ text: 'Sin horarios', bad: false })
  })

  it('knows when a digest is under way from what the daemon said', () => {
    expect(isDigestRunning({ kind: 'requesting' })).toBe(true)
    expect(isDigestRunning({ kind: 'started' })).toBe(true)
    for (const kind of ['deferred', 'done', 'empty', 'failed', 'busy', 'error'] as const) {
      expect(isDigestRunning({ kind })).toBe(false)
    }
    expect(isDigestRunning(undefined)).toBe(false)
  })
})
