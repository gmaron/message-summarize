import { isExcluded } from '../domain/exclusion.js'
import type { Message, Participant } from '../domain/model.js'
import { resolveConversationName } from '../domain/names.js'
import { err, ok, type Result } from '../domain/result.js'
import type { DigestSettings } from '../domain/settings.js'
import { parseSummaryResponse } from '../domain/summary.js'
import type { SummaryWindow } from '../domain/window.js'
import { assertConcurrency, mapWithConcurrency } from './concurrency.js'
import type { DigestSource } from './ports/digest-source.js'
import type { Renderers, TranscriptEntry } from './ports/rendering.js'
import type { Summarizer } from './ports/summarizer.js'

/** The most conversations one request reads: a wider one has to be narrowed (period or chat filter), not cut silently. */
export const MAX_ASK_CONVERSATIONS = 60
/** The longest question accepted, in characters. */
export const MAX_QUESTION_CHARS = 1000
/** What the model writes in `resumen` when a conversation has nothing to do with the request. */
export const NOTHING_RELEVANT = '-'

export interface AskChatsDeps {
  readonly source: DigestSource
  /** The same composed summarizer of the digest: its fallback, retries and local-only routing (RF-43) apply as they are. */
  readonly summarizer: Summarizer
  readonly renderers: Renderers
  /** The system prompt of a request, in the language of the installation. Gets the cleaned question and the owner name. */
  readonly systemPrompt: (question: string, ownerName: string | null) => string
  /** One line placed before each chat: saved or unsaved contact (individual chats) or a group. */
  readonly contactStatus: (status: 'saved' | 'unsaved' | 'group') => string
  /** Ids of the owner's own chat(s): never read (the same fallback filter as the digest). Default: none. */
  readonly ownConversationIds?: () => readonly string[]
}

export interface AskChatsRequest {
  readonly question: string
  readonly window: SummaryWindow
  /** Only conversations that match one of these patterns (a name, a phone number or `id:<id>`). Empty: all of them. */
  readonly chats?: readonly string[]
  readonly settings: DigestSettings
  readonly concurrency?: number
}

/** What one conversation answered to the request. */
export interface AskItem {
  readonly name: string
  readonly answer: string
  readonly todos: readonly string[]
  readonly needsReply: boolean
  readonly messageCount: number
}

export interface AskReport {
  readonly window: SummaryWindow
  /** Conversations that were read (they had messages in the period and were not excluded). */
  readonly consulted: number
  /** The conversations that had something for the request. Empty is a valid answer. */
  readonly items: readonly AskItem[]
  /** Conversations that could not be read by the provider. Their names are private: only the count is kept. */
  readonly failed: number
  /** How many conversations each provider answered. */
  readonly providers: Readonly<Record<string, number>>
}

export type AskChatsError =
  | { readonly kind: 'emptyQuestion' }
  | { readonly kind: 'invalidWindow' }
  /** More conversations than `MAX_ASK_CONVERSATIONS`: narrow the period or the chat filter. */
  | { readonly kind: 'tooMany'; readonly count: number }

export type AskChats = (request: AskChatsRequest) => Promise<Result<AskReport, AskChatsError>>

/** "-" alone, even with blanks, quotes or a final period around it ("- ", "\"-\"", "-."). */
// Any single dash (hyphen, en dash, em dash, minus...): models told to write "-" sometimes use another one.
const NOTHING_WRAPPED = /^[\s"'«»“”‘’`.]*[-‐‑‒–—―−][\s"'«»“”‘’`.]*$/

function isNothingRelevant(answer: string): boolean {
  return answer === NOTHING_RELEVANT || NOTHING_WRAPPED.test(answer)
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/** The question as the model gets it: no control characters, blanks collapsed, cut at `MAX_QUESTION_CHARS`. */
export function cleanQuestion(question: string): string {
  return question.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_CHARS)
}

/**
 * Answers a free request of the owner ("who asked me for something", "what did Ana say about the delivery") over the
 * conversations of a period. Nothing is saved and nothing moves (no pointer, no history, no outbox): it only reads.
 *
 * It asks each conversation through the SAME summarizer the digest uses, with a system prompt that carries the request,
 * so every guarantee of the digest holds without a new provider path: the consent, the fallback, the retries and the
 * conversations marked "local only", which never reach an external provider. The answer of each conversation travels in
 * the `resumen` field of the schema every provider already forces; a conversation with nothing for the request says
 * `NOTHING_RELEVANT` and is left out.
 */
export function createAskChats(deps: AskChatsDeps): AskChats {
  const { source, summarizer, renderers } = deps

  return async (request) => {
    const question = cleanQuestion(request.question)
    if (question === '') return err({ kind: 'emptyQuestion' })
    const { window, settings } = request
    if (!(window.since < window.until)) return err({ kind: 'invalidWindow' })
    const concurrency = request.concurrency ?? 4
    assertConcurrency(concurrency)

    const ownIds = new Set(deps.ownConversationIds?.() ?? [])
    const conversations = (await source.conversationsWithMessages(window)).filter((c) => !ownIds.has(c.id))
    const loaded: { conversation: (typeof conversations)[number]; messages: readonly Message[] }[] = []
    for (const conversation of conversations) {
      const messages = await source.messagesInWindow(conversation.id, window)
      if (messages.length > 0) loaded.push({ conversation, messages })
    }

    const ids = new Set<string>()
    for (const { conversation, messages } of loaded) {
      if (conversation.participantId !== null) ids.add(conversation.participantId)
      for (const m of messages) if (m.senderId !== null) ids.add(m.senderId)
    }
    const people = await source.participants([...ids])
    const personOf = (id: string | null): Participant | null => (id === null ? null : (people.get(id) ?? null))

    const filters = (request.chats ?? []).map((c) => c.trim()).filter((c) => c !== '')
    const named = loaded
      .map(({ conversation, messages }) => ({
        conversation,
        messages,
        ...resolveConversationName(conversation, personOf(conversation.participantId), {
          unnamedGroup: renderers.transcript.unnamedGroup,
        }),
      }))
      // The privacy exclusions come first and cannot be overridden by the filter of the request.
      .filter((c) => !isExcluded(settings.excludePatterns, c.conversation.id, c.name))
      .filter((c) => filters.length === 0 || isExcluded(filters, c.conversation.id, c.name))
    if (named.length > MAX_ASK_CONVERSATIONS) return err({ kind: 'tooMany', count: named.length })

    const systemPrompt = deps.systemPrompt(question, settings.ownerName)
    const outcomes = await mapWithConcurrency(named, concurrency, async (item) => {
      try {
        const entries: TranscriptEntry[] = item.messages.map((m) => ({
          message: { ...m, copies: 0 },
          participant: m.fromMe ? null : personOf(m.senderId),
          isMass: false,
        }))
        const body = renderers.transcript.render({
          name: item.name,
          isGroup: item.conversation.isGroup,
          messages: entries,
          context: [],
          ownerName: settings.ownerName,
          maxChars: settings.maxCharsPerConversation,
        })
        // Only an individual chat has an address-book status; a group says it is a group, so it is never an "unsaved contact".
        const status = item.conversation.isGroup ? 'group' : item.saved ? 'saved' : 'unsaved'
        const transcript = `${deps.contactStatus(status)}\n${body}`
        const raw = await summarizer.summarize({
          conversation: { id: item.conversation.id, name: item.name, isGroup: item.conversation.isGroup },
          systemPrompt,
          transcript,
        })
        if (typeof raw !== 'object' || raw === null || raw.ok !== true) return null
        const parsed = parseSummaryResponse(raw.value)
        if (!parsed.ok) return null
        const provider = typeof raw.provider === 'string' && raw.provider !== '' ? raw.provider : 'unknown'
        const answer = parsed.value.summary.trim()
        const relevant = answer !== '' && !isNothingRelevant(answer)
        return {
          provider,
          item: relevant
            ? {
                name: item.name,
                answer,
                todos: parsed.value.todos.filter((t) => t.trim() !== ''),
                needsReply: parsed.value.needsReply,
                messageCount: item.messages.length,
              }
            : null,
        }
      } catch {
        return null
      }
    })

    const items: AskItem[] = []
    const providers: Record<string, number> = {}
    let failed = 0
    for (const outcome of outcomes) {
      if (outcome === null) {
        failed += 1
        continue
      }
      providers[outcome.provider] = (providers[outcome.provider] ?? 0) + 1
      if (outcome.item !== null) items.push(outcome.item)
    }
    // The most urgent first: what needs a reply, then the busiest conversation.
    items.sort((a, b) => Number(b.needsReply) - Number(a.needsReply) || b.messageCount - a.messageCount)
    return ok({ window, consulted: named.length, items, failed, providers })
  }
}
