import { describe, expect, it } from 'vitest'
import {
  dayChip,
  formatDateTime,
  formatTime,
  percentOf,
  weekdayName,
  whenText,
} from '../../../src/interfaces/web/lib/format.js'
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

describe('percentOf', () => {
  it('rounds and clamps to 0..100, and is null for what is not a number', () => {
    expect(percentOf(0)).toBe(0)
    expect(percentOf(42.6)).toBe(43)
    expect(percentOf(-5)).toBe(0)
    expect(percentOf(130)).toBe(100)
    for (const bad of [undefined, null, '50', Number.NaN, Number.POSITIVE_INFINITY]) expect(percentOf(bad)).toBeNull()
  })
})

describe('the percent text', () => {
  it('exists in both languages with the {percent} slot', () => {
    expect(fmt(textsFor('en').ui.link.percent, { percent: 42 })).toBe('42%')
    expect(fmt(textsFor('es').ui.link.percent, { percent: 42 })).toBe('42 %')
  })
})

describe('the day and the time of a moment in the zone of the account', () => {
  const zone = 'America/Argentina/Buenos_Aires'
  // 2026-11-18, noon in Buenos Aires (UTC-3)
  const now = Date.UTC(2026, 10, 18, 15, 0)

  it('names today, yesterday and tomorrow by the day of the zone, not of the browser', () => {
    expect(dayChip(Date.UTC(2026, 10, 18, 12, 0), zone, 'es-AR', now)).toBe('Hoy')
    // 02:00 UTC of the 19th is still the 18th, 23:00 here
    expect(dayChip(Date.UTC(2026, 10, 19, 2, 0), zone, 'es-AR', now)).toBe('Hoy')
    expect(dayChip(Date.UTC(2026, 10, 17, 15, 0), zone, 'es-AR', now)).toBe('Ayer')
    expect(dayChip(Date.UTC(2026, 10, 19, 15, 0), 'UTC', 'en', Date.UTC(2026, 10, 18, 15, 0))).toBe('Tomorrow')
  })

  it('shows a weekday for the nearby days and a date for the far ones', () => {
    expect(dayChip(Date.UTC(2026, 10, 21, 15, 0), zone, 'es-AR', now)).toMatch(/sáb/i)
    expect(dayChip(Date.UTC(2026, 11, 20, 15, 0), zone, 'es-AR', now)).toMatch(/dic/i)
  })

  it('says the time in 24 hours and puts the day before it', () => {
    expect(formatTime(Date.UTC(2026, 10, 18, 12, 0), zone, 'es-AR')).toBe('9:00')
    expect(formatTime(Date.UTC(2026, 10, 18, 22, 30), zone, 'en')).toBe('19:30')
    expect(whenText(Date.UTC(2026, 10, 18, 22, 0), zone, 'es-AR', now)).toBe('hoy 19:00')
  })

  it('survives a zone the browser does not know', () => {
    expect(() => dayChip(now, 'Not/AZone', 'en', now)).not.toThrow()
    expect(() => formatTime(now, 'Not/AZone', 'en')).not.toThrow()
  })
})
