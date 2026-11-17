import type { Catalog, Language } from './catalog.js'
import { en } from './en.js'
import { es } from './es.js'

export type { Catalog, HeadlineParts, Language } from './catalog.js'

export const LANGUAGES: readonly Language[] = ['es', 'en']

const catalogs: Readonly<Record<Language, Catalog>> = { es, en }

export const getCatalog = (language: Language): Catalog => catalogs[language]
