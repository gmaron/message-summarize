import type { ConversationTranscript, TranscriptEntry, TranscriptRenderer } from '../../application/ports/rendering.js'
import { messageBody } from '../../domain/body.js'
import { senderLabel } from '../../domain/names.js'
import { truncateTranscript } from '../../domain/truncate.js'
import type { Catalog } from '../i18n/catalog.js'

/** How many UTF-16 units of an own mass message are shown. */
const MASS_EXCERPT_LENGTH = 60
/** The most of a quoted message that a transcript shows (a longer quote is left out). */
const QUOTED_EXCERPT_LENGTH = 80

export function createTranscriptRenderer(catalog: Catalog, timeZone: string): TranscriptRenderer {
  const time = new Intl.DateTimeFormat(catalog.dateLocale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  })
  const dateTime = new Intl.DateTimeFormat(catalog.dateLocale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  })
  const t = catalog.transcript

  const bodyOf = ({ message, isMass }: TranscriptEntry): string => {
    const body = messageBody(message)
    if (body.type === 'audio') return body.transcript ? t.audio(body.transcript) : t.audioUntranscribed
    if (body.type === 'image') return t.imageRead(body.text, body.transcript)
    if (body.type === 'placeholder') return t.kinds[body.kind]
    if (isMass) return t.massMessage(body.text.replace(/\s+/g, ' ').slice(0, MASS_EXCERPT_LENGTH))
    return body.text
  }

  /** The context of a reply, as a short prefix: to a status of the owner, or to a short quoted message. */
  const replyPrefix = ({ message }: TranscriptEntry): string => {
    const reply = message.reply
    if (reply === undefined) return ''
    const text = reply.text === null ? '' : reply.text.replace(/\s+/g, ' ').trim()
    if (reply.fromStatus) {
      const kind = reply.kind === null || reply.kind === 'text' ? '' : t.kinds[reply.kind].replace(/^\[|\]$/g, '')
      const what = `${kind} ${text === '' ? '' : `«${text.slice(0, QUOTED_EXCERPT_LENGTH)}»`}`.trim()
      return `${t.replyToStatus(what === '' ? null : what)} `
    }
    // A long quoted text would bloat the transcript: only a short one is shown.
    return text !== '' && text.length <= QUOTED_EXCERPT_LENGTH ? `${t.replyTo(text)} ` : ''
  }

  const renderLine = (entry: TranscriptEntry, ownerLabel: string, withDate = false): string => {
    const { message, participant } = entry
    const label = senderLabel(message, participant, { ownerLabel })
    const copies = message.copies > 0 ? t.copies(message.copies) : ''
    const when = withDate ? dateTime.format(message.timestamp) : time.format(message.timestamp)
    return `[${when}] ${label}: ${replyPrefix(entry)}${bodyOf(entry)}${copies}`
  }

  return {
    unnamedGroup: catalog.unnamedGroup,
    lines(input) {
      const ownerLabel = t.ownerLabel(input.ownerName?.trim() ? input.ownerName : catalog.defaultOwnerName)
      return input.entries.map((entry) => renderLine(entry, ownerLabel, true))
    },
    formatDateTime: (timestamp) => dateTime.format(timestamp),
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
