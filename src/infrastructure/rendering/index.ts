import type { Renderers } from '../../application/ports/rendering.js'
import { getCatalog, type Language } from '../i18n/index.js'
import { createErrorMessages } from './error-messages.js'
import { createSystemPromptRenderer } from './system-prompt.js'
import { createTranscriptRenderer } from './transcript.js'
import { createWhatsAppTextRenderer } from './whatsapp-text.js'

/**
 * Renderers of one language. `timeZone` is an IANA name ("America/Argentina/Buenos_Aires"): the dates and times of the
 * transcript and the digest are shown in it. An unknown name throws a RangeError here, not later.
 */
export function createRenderers(language: Language, timeZone: string): Renderers {
  const catalog = getCatalog(language)
  return {
    transcript: createTranscriptRenderer(catalog, timeZone),
    systemPrompt: createSystemPromptRenderer(catalog),
    digest: createWhatsAppTextRenderer(catalog, timeZone),
    errors: createErrorMessages(catalog),
  }
}
