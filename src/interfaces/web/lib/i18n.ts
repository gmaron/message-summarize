import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
import { webEn } from '../../../infrastructure/i18n/web-en.js'
import { webEs } from '../../../infrastructure/i18n/web-es.js'
import type { Language } from './types.js'

/** Spanish is the language of the page until something says otherwise: the first render, a daemon that does not say, anything else. */
export const DEFAULT_PAGE_LANGUAGE: Language = 'es'

/** The language of the installation when the daemon says it (Spanish or English); Spanish for anything else. */
export function pickLanguage(fromServer: unknown): Language {
  return fromServer === 'en' ? 'en' : DEFAULT_PAGE_LANGUAGE
}

/**
 * The language the browser asks for: the first of its languages (`navigator.languages`, then `navigator.language`) that is
 * Spanish or English. Spanish when none is (a French or Japanese browser): the page does not guess another language.
 */
export function languageFromBrowser(languages: readonly string[] | undefined, single?: string): Language {
  for (const tag of [...(languages ?? []), single ?? '']) {
    const lower = tag.trim().toLowerCase()
    if (lower === 'es' || lower.startsWith('es-')) return 'es'
    if (lower === 'en' || lower.startsWith('en-')) return 'en'
  }
  return DEFAULT_PAGE_LANGUAGE
}

/**
 * The time zone of the computer the browser runs on (no network involved), or undefined where it cannot tell. The daemon
 * takes it only on a fresh install, and only when it is a valid IANA name.
 */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

export const textsFor = (language: Language): WebTexts => (language === 'es' ? webEs : webEn)

/** Fills the `{name}` placeholders of a text of the catalog. */
export function fmt(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole))
}
