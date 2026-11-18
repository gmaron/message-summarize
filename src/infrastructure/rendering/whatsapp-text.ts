import type { DigestInput, DigestRenderer, RenderedDigest } from '../../application/ports/rendering.js'
import type { ChatResult } from '../../domain/sections.js'
import type { Catalog } from '../i18n/catalog.js'

export function createWhatsAppTextRenderer(catalog: Catalog, timeZone: string): DigestRenderer {
  const date = new Intl.DateTimeFormat(catalog.dateLocale, {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  })
  const d = catalog.digest

  const sectionLines = (title: string, results: readonly ChatResult[]): string[] => {
    const lines = ['', `*${title}*`]
    for (const result of results) {
      lines.push(`• *${result.name}*: ${result.summary.summary}`)
      for (const todo of result.summary.todos) lines.push(`   ☐ ${todo}`)
    }
    return lines
  }

  return {
    render(input: DigestInput): RenderedDigest {
      const { sections } = input
      const { counts } = sections
      const head = [
        `*${d.title(input.platformName, date.format(input.until))}*`,
        d.headline({
          total: counts.total,
          unreadOnly: input.unreadOnly,
          since: date.format(input.since),
          needsReply: counts.needsReply,
          unsaved: counts.unsaved,
        }),
      ]
      const tail = input.errors > 0 ? ['', d.failedChats(input.errors)] : []
      const body = (hideRest: boolean): string[] => [
        ...(sections.unsaved.length > 0 ? sectionLines(d.unsavedTitle(sections.unsaved.length), sections.unsaved) : []),
        ...(sections.needsReply.length > 0 ? sectionLines(d.needsReplyTitle, sections.needsReply) : []),
        ...(sections.withTodos.length > 0 ? sectionLines(d.withTodosTitle, sections.withTodos) : []),
        ...(sections.rest.length === 0
          ? []
          : hideRest
            ? ['', d.hiddenRest(sections.rest.length)]
            : sectionLines(d.restTitle, sections.rest)),
      ]
      const fullLines = [...head, ...body(false), ...tail]
      return { fullLines, deliveryLines: input.hideRest ? [...head, ...body(true), ...tail] : fullLines }
    },
  }
}
