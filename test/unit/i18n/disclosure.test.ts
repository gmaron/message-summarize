import { describe, expect, it } from 'vitest'
import { getCatalog, LANGUAGES } from '../../../src/infrastructure/i18n/index.js'

// One disclosure of what is sent (RNF-02): `msum provider use` and the web say it in the same words, per language, and the
// words include what the second version of the text added (CONSENT_TEXT_VERSION): the phone numbers of the contacts that
// were not saved and the transcripts of voice notes.

describe('the disclosure of what is sent', () => {
  it.each(LANGUAGES)('is the same words in the command line and in the web (%s)', (language) => {
    const catalog = getCatalog(language)
    expect(catalog.cli.provider.use.disclosureSends).toContain(catalog.web.ui.disclosure.sends)
    expect(catalog.web.ui.disclosure.sends.length).toBeGreaterThan(50)
  })

  it('names the phone numbers of unsaved contacts and the voice-note transcripts', () => {
    const en = getCatalog('en').web.ui.disclosure.sends
    expect(en).toContain('phone numbers of the contacts you have not saved')
    expect(en).toContain('transcripts of voice notes')
    const es = getCatalog('es').web.ui.disclosure.sends
    expect(es).toContain('números de teléfono de los contactos que no guardaste')
    expect(es).toContain('transcripciones de las notas de voz')
  })
})
