import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
import { webEn } from '../../../infrastructure/i18n/web-en.js'
import { webEs } from '../../../infrastructure/i18n/web-es.js'
import type { Language } from './types.js'

/** The language of the installation when the daemon says it, otherwise the one of the browser, otherwise English. */
export function pickLanguage(fromServer: unknown, browser: string | undefined): Language {
  if (fromServer === 'es' || fromServer === 'en') return fromServer
  return (browser ?? '').toLowerCase().startsWith('es') ? 'es' : 'en'
}

export const textsFor = (language: Language): WebTexts => (language === 'es' ? webEs : webEn)

/** Fills the `{name}` placeholders of a text of the catalog. */
export function fmt(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole))
}
