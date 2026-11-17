import type { ConversationTranscript, TranscriptEntry, TranscriptRenderer } from '../../application/ports/rendering.js'
import { messageBody } from '../../domain/body.js'
import { senderLabel } from '../../domain/names.js'
import { truncateTranscript } from '../../domain/truncate.js'
import type { Catalog } from '../i18n/catalog.js'

/** How many UTF-16 units of an own mass message are shown. */
const MASS_EXCERPT_LENGTH = 60

export function createTranscriptRenderer(catalog: Catalog, timeZone: string): TranscriptRenderer {
  const time = new Intl.DateTimeFormat(catalog.dateLocale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  })
  const t = catalog.transcript

  const bodyOf = ({ message, isMass }: TranscriptEntry): string => {
    const body = messageBody(message)
    if (body.type === 'audio') return body.transcript ? t.audio(body.transcript) : t.audioUntranscribed
    if (body.type === 'placeholder') return t.kinds[body.kind]
    if (isMass) return t.massMessage(body.text.replace(/\s+/g, ' ').slice(0, MASS_EXCERPT_LENGTH))
    return body.text
  }

  const renderLine = (entry: TranscriptEntry, ownerLabel: string): string => {
    const { message, participant } = entry
    const label = senderLabel(message, participant, { ownerLabel })
    const copies = message.copies > 0 ? t.copies(message.copies) : ''
    return `[${time.format(message.timestamp)}] ${label}: ${bodyOf(entry)}${copies}`
  }

  return {
    unnamedGroup: catalog.unnamedGroup,
    render(input: ConversationTranscript): string {
      const ownerLabel = t.ownerLabel(input.ownerName?.trim() ? input.ownerName : catalog.defaultOwnerName)
      const lines = (entries: readonly TranscriptEntry[]): string =>
        entries.map((entry) => renderLine(entry, ownerLabel)).join('\n')

      const cut = truncateTranscript(lines(input.messages), input.maxChars)
      let transcript = cut.truncated ? `${t.truncatedMarker}\n${cut.text}` : cut.text
      if (input.context.length > 0) {
        transcript = `${t.contextHeader}\n${lines(input.context)}\n\n${t.unreadHeader}\n${transcript}`
      }
      return `${t.header(input.isGroup, input.name)}\n\n${transcript}`
    },
  }
}
