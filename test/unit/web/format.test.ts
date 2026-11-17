import { describe, expect, it } from 'vitest'
import { formatDateTime, weekdayName } from '../../../src/interfaces/web/lib/format.js'
import { fmt, pickLanguage, textsFor } from '../../../src/interfaces/web/lib/i18n.js'

describe('formatDateTime', () => {
  const noon = Date.UTC(2026, 0, 15, 12, 0) // 12:00 UTC
  it('shows the time of the account zone, not the one of the browser', () => {
    expect(formatDateTime(noon, 'America/Argentina/Buenos_Aires', 'en-GB')).toContain('09:00')
    expect(formatDateTime(noon, 'Asia/Tokyo', 'en-GB')).toContain('21:00')
    expect(formatDateTime(noon, 'UTC', 'en-GB')).toContain('12:00')
  })

  it('follows the daylight saving of the zone', () => {
    const winter = formatDateTime(Date.UTC(2026, 0, 15, 12, 0), 'Europe/Madrid', 'en-GB')
    const summer = formatDateTime(Date.UTC(2026, 6, 15, 12, 0), 'Europe/Madrid', 'en-GB')
    expect(winter).toContain('13:00')
    expect(summer).toContain('14:00')
  })

  it('writes in the locale of the page and survives a zone the browser does not know', () => {
    expect(formatDateTime(noon, 'UTC', 'es-AR')).toMatch(/ene/i)
    expect(() => formatDateTime(noon, 'Not/AZone', 'en-GB')).not.toThrow()
  })
})

describe('weekdayName', () => {
  it('numbers the days from Sunday', () => {
    expect(weekdayName(0, 'en-GB', 'long')).toBe('Sunday')
    expect(weekdayName(1, 'en-GB', 'long')).toBe('Monday')
    expect(weekdayName(6, 'es-AR', 'long').toLowerCase()).toBe('sábado')
  })
})

describe('language and texts', () => {
  it('uses the language of the installation, then the browser, then English', () => {
    expect(pickLanguage('es', 'en-US')).toBe('es')
    expect(pickLanguage('en', 'es-AR')).toBe('en')
    expect(pickLanguage(undefined, 'es-AR')).toBe('es')
    expect(pickLanguage('fr', 'fr-FR')).toBe('en')
    expect(pickLanguage(undefined, undefined)).toBe('en')
  })

  it('has the texts of both languages and fills placeholders', () => {
    expect(textsFor('es').locale).toBe('es-AR')
    expect(textsFor('en').locale).toBe('en-GB')
    expect(fmt('{count} chats of {x}', { count: 3 })).toBe('3 chats of {x}')
    expect(fmt(textsFor('en').ui.link.title, { account: 'alpha' })).toContain('alpha')
  })
})
