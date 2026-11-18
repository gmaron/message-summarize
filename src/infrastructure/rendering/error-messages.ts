import type { ErrorMessages } from '../../application/ports/rendering.js'
import type { Catalog } from '../i18n/catalog.js'

export function createErrorMessages(catalog: Catalog): ErrorMessages {
  return {
    settingsIssue: ({ option, code }) => catalog.errors.settings[code](option),
    windowError: (code) => catalog.errors.window[code],
  }
}
