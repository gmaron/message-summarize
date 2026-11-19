import { describe, expect, it } from 'vitest'
import { webEn } from '../../../src/infrastructure/i18n/web-en.js'
import { webEs } from '../../../src/infrastructure/i18n/web-es.js'
import {
  canStartLink,
  linkNeedsNotice,
  linkNotStarted,
  rememberRisk,
  riskAccepted,
} from '../../../src/interfaces/web/lib/risk.js'

const memory = () => {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
}
const throwing = {
  getItem: (): string | null => {
    throw new Error('blocked')
  },
  setItem: (): void => {
    throw new Error('blocked')
  },
}

describe('the legal notice before linking (RF-70)', () => {
  it('keeps the start button disabled until the box is checked', () => {
    expect(canStartLink(true, false)).toBe(false)
    expect(canStartLink(true, true)).toBe(true)
  })

  it('shows the notice again for a link that was cancelled, not a progress bar with no button', () => {
    expect(linkNotStarted(undefined)).toBe(true)
    expect(linkNotStarted({ phase: 'idle', requestError: null })).toBe(true)
    expect(linkNotStarted({ phase: 'idle', requestError: 'busy' })).toBe(false)
    expect(linkNotStarted({ phase: 'qr', requestError: null })).toBe(false)
  })

  it('asks only for a new account, not to link again or to follow one that is linking', () => {
    expect(linkNeedsNotice({ state: 'idle', maskedNumber: null })).toBe(true)
    expect(linkNeedsNotice({ state: 'idle', maskedNumber: '+54 *** 1234' })).toBe(false)
    expect(linkNeedsNotice({ state: 'linking', maskedNumber: null })).toBe(false)
    expect(linkNeedsNotice({ state: 'blocked', maskedNumber: '+54 *** 1234' })).toBe(false)
    expect(canStartLink(false, false)).toBe(true)
  })

  it('remembers the acceptance in the tab only, and survives a storage that is missing or throws', () => {
    const storage = memory()
    expect(riskAccepted(storage)).toBe(false)
    rememberRisk(storage)
    expect(riskAccepted(storage)).toBe(true)
    expect(riskAccepted(undefined)).toBe(false)
    expect(riskAccepted(throwing)).toBe(false)
    expect(() => rememberRisk(throwing)).not.toThrow()
    expect(() => rememberRisk(undefined)).not.toThrow()
  })

  it('has every text in both languages, with a link to the README warning', () => {
    for (const texts of [webEn, webEs]) {
      for (const [key, value] of Object.entries(texts.ui.risk)) expect(value.trim(), key).not.toBe('')
      expect(texts.ui.risk.learnMoreUrl).toMatch(/^https:\/\/github\.com\/gmaron\/message-summarize/)
    }
    expect(webEn.ui.risk.checkbox).not.toBe(webEs.ui.risk.checkbox)
  })
})
